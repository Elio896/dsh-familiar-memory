// 第一层：核心逻辑单测。不碰 DSH、不碰真数据，全程临时目录。
// 跑：node test-core.mjs —— 全绿返回 0，有红返回 1
import { NeuronStore, termsOf } from './lib/neuron.mjs'
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

// 10) 冷启动：有词但零命中 → 给兜底并标记 fallback，不装死
const s7 = new NeuronStore(tmp('cold'))
s7.learn('他喜欢海边散步', 'fact')
const r8 = s7.recall('量子纠缠', 3)
ok('零命中时给兜底（不空手）', r8.nodes.length > 0)
ok('兜底带 fallback 标记', r8.fallback === true)

// 11) replay / story / prune / stats 都能跑
const rep = store.replay()
ok('replay 返回结构', typeof rep.nodes === 'number' && typeof rep.edges === 'number')
ok('story 返回数组', Array.isArray(store.story()))
ok('prune 返回数字', typeof store.prune().pruned === 'number')
const st = store.stats()
ok('stats 有节点数', st.nodes >= 3 && st.edges >= 0)

console.log(fails ? `\n核心层：${fails} 项没过` : '\n核心层：全部通过')
process.exit(fails ? 1 : 0)
