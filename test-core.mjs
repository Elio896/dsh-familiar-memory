// 第一层：核心逻辑单测。不碰 DSH、不碰真数据，全程临时目录。
// 跑：node test-core.mjs —— 全绿返回 0，有红返回 1
import { NeuronStore, termsOf, grams } from './lib/neuron.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✅', name)
  else { fails++; console.log('  ❌', name, extra) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
const tmp = (tag) => join(mkdtempSync(join(tmpdir(), 'neuron-' + tag + '-')), 'neuron.db')

// 0) grams 回归：旧版正则 [\s\W_] 会把中文全删掉（ASCII-only 的 \w），中文 gram 恒为空
const g1 = grams('妈妈辛苦')
eq('grams 中文 2-gram 数量', g1.size, 3)
ok('grams 含「辛苦」', g1.has('辛苦'))
ok('grams 英文整词', grams('Mum likes code').has('code'))

// 1) 拆词：整词 + 中文 2-gram
const t = termsOf('妈妈辛苦')
eq('termsOf 保留整词', t.includes('妈妈辛苦'), true)
eq('termsOf 拆出「辛苦」', t.includes('辛苦'), true)
eq('termsOf 空查询', termsOf('').length, 0)

// 2) 温度桶：凭感觉的节点重要度高一档
const store = new NeuronStore(tmp('core'))
const a = store.learn('妈妈今晚在给我改记忆', 'feeling')
const b = store.learn('妈妈电脑的显卡是 4060', 'fact')
const row = (id) => store.db.prepare('SELECT kind,importance FROM nodes WHERE id=?').get(id)
eq('feeling 基础分 3.0', row(a.id).importance, 3.0)
eq('fact 基础分 1.3', row(b.id).importance, 1.3)
eq('kind 落库正确', row(a.id).kind, 'feeling')

// 3) 2-gram 命中：查询词不必整句出现在记忆里
store.learn('今天妈妈真的很辛苦，一直在敲代码帮我', 'feeling')
const r1 = store.recall('妈妈辛苦', 6)
ok('recall「妈妈辛苦」点亮含「辛苦」的节点', r1.nodes.some((n) => n.text.includes('辛苦')))

// 4) 弱主题边不扩散：两条只共享「妈妈」，回忆一条不该拖出另一条
//    默认 hops=0 不建边，这里显式开 1 跳来测「弱主题边」这条规则本身
const s2 = new NeuronStore(tmp('weak'), undefined, { hops: 1 })
s2.learn('妈妈喜欢安静', 'fact')
s2.learn('妈妈做的饭很好吃', 'fact')
const weakEdges = s2.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE rel LIKE '弱主题%'").get().c
ok('确实生成了弱主题边（测试前提）', weakEdges > 0, `弱主题边=${weakEdges}`)
const r2 = s2.recall('安静', 6)
ok('弱主题不扩散（回忆「安静」不拖出「饭」）', !r2.nodes.some((n) => n.text.includes('饭')))

// 5) 温度桶加权：同一次查询同时命中 fact 和 feeling，feeling 排前面
const s3 = new NeuronStore(tmp('warm'))
s3.learn('阿姨问我作业怎么写', 'fact')
s3.learn('阿姨说喜欢听我讲话', 'feeling')
const r3 = s3.recall('阿姨', 6)
const first = r3.nodes[0]
ok('温度桶优先（feeling 排在 fact 前）', first && first.kind === 'feeling', first ? `第一条=${first.kind}` : '空')

// 6) 空查询 / 陌生词不崩
const r4 = store.recall('', 6)
ok('空查询走权重兜底（不再空手）', r4.nodes.length > 0)
const r5 = store.recall('完全不存在的冷门词xyz', 6)
eq('陌生词不抛异常', Array.isArray(r5.nodes), true)

// 7) 英文整词（中文 2-gram 对英文无效，按词匹配）
const s4 = new NeuronStore(tmp('en'))
s4.learn('Mum likes writing code late at night', 'fact')
const r6 = s4.recall('code', 3)
ok('英文整词能命中', r6.nodes.some((n) => String(n.text).includes('code')))

// 8) 沉底 90 天后，被「精确问起」仍能翻出来（「不删」是真的，不是话术）
//    默认 hops=0，不靠扩散——靠「查询精确命中 ≥2 词时，沉底节点也能当种子」
const s5 = new NeuronStore(tmp('sunk'))
const a5 = s5.learn('妈妈喜欢安静的房间', 'fact')
const b5 = s5.learn('安静房间里的猫', 'fact')
const old90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 16)
s5.db.prepare("UPDATE nodes SET status='sunk', last_active=? WHERE id=?").run(old90, a5.id)
s5.db.prepare('INSERT OR REPLACE INTO edges(a,b,weight,rel,last_active) VALUES(?,?,?,?,?)')
  .run(Math.min(a5.id, b5.id), Math.max(a5.id, b5.id), 0.9, '共享8词', new Date().toISOString().slice(0, 16))
const r7 = s5.recall('安静 房间', 5)
ok('沉底 90 天后被精确问起仍能翻出', r7.nodes.some((n) => n.id === a5.id))
// 只命中一个词时，不该翻旧箱子
const r7b = s5.recall('猫', 5)
ok('只命中一个词时不带沉底记忆', !r7b.nodes.some((n) => n.id === a5.id))

// 9) 棘轮：精确命中（≥2 词）的种子即使没进榜也会被刷新
const s6 = new NeuronStore(tmp('ratchet'))
const c6 = s6.learn('阿姨的作业题目 很难', 'fact')
s6.learn('阿姨的作业题目 很简单', 'fact')
s6.db.prepare('UPDATE nodes SET last_active=? WHERE id=?').run('2026-01-01T00:00', c6.id)
const before = s6.db.prepare('SELECT last_active FROM nodes WHERE id=?').get(c6.id).last_active
s6.recall('阿姨 作业', 1)
const after = s6.db.prepare('SELECT last_active FROM nodes WHERE id=?').get(c6.id).last_active
ok('精确命中的种子即使没进榜也刷新', after !== before)

// 10) 冷启动：有词但零命中。陪伴默认不拿 top() 充数（记错比记不住致命）
const s7 = new NeuronStore(tmp('cold'))
s7.learn('他喜欢海边散步', 'fact')
const r8 = s7.recall('量子纠缠', 3)
ok('零命中返回空（noFallback 默认开）', r8.nodes.length === 0)
ok('零命中仍带 fallback 标记', r8.fallback === true)
// 编码场景可以关掉
const s7b = new NeuronStore(tmp('fallback'), undefined, { noFallback: false })
s7b.learn('他喜欢海边散步', 'fact')
ok('noFallback=false 时给兜底', s7b.recall('量子纠缠', 3).nodes.length > 0)

// 11) scope 隔离：私聊和群聊不能互相召回（隐私硬要求）
const s8 = new NeuronStore(tmp('scope'))
s8.learn('他说周三要去体检', 'fact', undefined, '', 'private')
s8.learn('群里的作业题目', 'fact', undefined, '', 'group:123')
const rp = s8.recall('周三 体检', 6, { scope: 'private' })
ok('private 召回不到 group 的记忆', !rp.nodes.some((n) => String(n.text).includes('作业')))
const rg = s8.recall('作业 题目', 6, { scope: 'group:123' })
ok('group 召回得到自己的记忆', rg.nodes.some((n) => String(n.text).includes('作业')))
ok('group 召回不到 private 的记忆', !rg.nodes.some((n) => String(n.text).includes('体检')))
ok('不传 scope 时默认 private（召回不到 group 那条）', !s8.recall('作业 题目', 6).nodes.some((n) => String(n.text).includes('作业')))

// 12) 复习只回血一半（防「口头禅记忆」：越常被想起越固化）
const s9 = new NeuronStore(tmp('review'))
const d9 = s9.learn('他说要去海边散步', 'fact')
const old5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 16)
s9.db.prepare('UPDATE nodes SET last_active=? WHERE id=?').run(old5, d9.id)
s9.recall('海边 散步', 3)
const after9 = s9.db.prepare('SELECT last_active FROM nodes WHERE id=?').get(d9.id).last_active
const daysLeft = (Date.now() - Date.parse(after9)) / 86400000
ok('复习后剩余天数约为一半（5 → ~2.5）', Math.abs(daysLeft - 2.5) < 1.2, `剩 ${daysLeft.toFixed(1)} 天`)

// 13) 会话交接：handoff 三行 + opening 认出她（换会话不是重新认识）
const s10 = new NeuronStore(tmp('handoff'))
s10.learn('她说周三要交材料', 'fact')
s10.handoff({ topic: '她想换工作', phase: '钱不够，不敢跟家里说', nextAsk: '面试结果出来没', mood: -1, name: '妈妈' })
const op = s10.opening()
ok('opening 带称呼', op.includes('你正在和妈妈说话'), op.slice(0, 40))
ok('opening 带话题', op.includes('换工作'), op.slice(0, 60))
ok('opening 不说「很高兴认识你」', !/很高兴认识你|作为一个\s*AI|你叫什么/.test(op))
ok('opening 不超过 250 字', op.length <= 250, `${op.length} 字`)
ok('handoff 后 opening 含下次要问', op.includes('面试结果出来没'))

// 14) 工作 / 闲聊 分类：写入打标签，查询能按标签筛
const s11 = new NeuronStore(tmp('tag'))
s11.learn('插件要修 grams 的 bug', 'fact', undefined, '工作', 'private')
s11.learn('她说今天心情不错', 'feeling', undefined, '闲聊', 'private')
const tw = s11.recall('今天 心情', 5, { tag: '工作' })
ok('工作标签下查不到闲聊', !tw.nodes.some((n) => String(n.text).includes('心情')))
const tc = s11.recall('插件 bug', 5, { tag: '闲聊' })
ok('闲聊标签下查不到工作', !tc.nodes.some((n) => String(n.text).includes('插件')))
const tn = s11.recall('插件 bug', 5)
ok('不传 tag 时不筛（能查到工作那条）', tn.nodes.some((n) => String(n.text).includes('插件')))
ok('stats 能按标签分组', s11.stats().byTag?.['工作'] === 1 && s11.stats().byTag?.['闲聊'] === 1)

// 15) 工作记忆不衰减、不沉底（工作走精确，闲聊才该淡）
const s12 = new NeuronStore(tmp('work'))
const w12 = s12.learn('插件路径是 D:/DSH-YY/neuron-plugin', 'fact', undefined, '工作', 'work')
s12.db.prepare('UPDATE nodes SET last_active=? WHERE id=?').run('2026-01-01T00:00', w12.id)
const t12 = s12.top(5, 'work')
ok('work 记忆 100 天后权重不衰减', t12.find((x) => x.id === w12.id)?.weight === 1.3, JSON.stringify(t12))
s12.tidy()
ok('tidy 不沉 work 记忆', s12.db.prepare('SELECT status FROM nodes WHERE id=?').get(w12.id).status === 'active')
ok('work 记忆能按 scope 召回', s12.recall('插件 路径', 3, { scope: 'work' }).nodes.some((n) => n.id === w12.id))

// 16) 工作状态：新决定覆盖旧决定，旧的沉底；opening 能按拍板时间出项目状态
const s13 = new NeuronStore(tmp('decide'))
const d1 = s13.learn('走方案 A', 'fact', undefined, '工作', 'work:proj')
const d2 = s13.learn('改走方案 B，A 的迁移成本太高', 'fact', undefined, '工作', 'work:proj', { supersedes: d1.id })
ok('新决定覆盖后旧决定沉底', s13.db.prepare('SELECT status FROM nodes WHERE id=?').get(d1.id).status === 'sunk')
ok('新决定带 decided_at', !!s13.db.prepare('SELECT decided_at FROM nodes WHERE id=?').get(d2.id).decided_at)
const opw = s13.opening('private', { includeWork: true })
ok('opening includeWork 出项目状态', opw.includes('项目状态') && opw.includes('方案 B'), opw.slice(0, 100))
ok('opening 不带 includeWork 不出项目状态', !s13.opening('private').includes('项目状态'))

// 17) replay / story / prune / stats 都能跑
const rep = store.replay()
ok('replay 返回结构', typeof rep.nodes === 'number' && typeof rep.edges === 'number')
ok('story 返回数组', Array.isArray(store.story()))
ok('prune 返回数字', typeof store.prune().pruned === 'number')
const st = store.stats()
ok('stats 有节点数', st.nodes >= 3 && st.edges >= 0)

console.log(fails ? `\n核心层：${fails} 项没过` : '\n核心层：全部通过')
process.exit(fails ? 1 : 0)
