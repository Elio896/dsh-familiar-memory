// 第二层：插件契约测试。用假的 ctx 模拟宿主，用临时 DSH_HOME，
// 验证「加载、注册、调用、HTTP 路由」全程不抛异常。
// 跑：node test-plugin.mjs —— 全绿返回 0
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 关键：数据目录指到临时目录，绝不碰真实的 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'neuron-plugin-home-'))

let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✅', name)
  else { fails++; console.log('  ❌', name, extra) }
}

const registered = []
const routes = []
const ctx = {
  tools: { register: (t) => { registered.push(t); return t } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (fn) => fn(),
}

const mod = await import('./index.js')
ok('插件能 import', typeof mod.apply === 'function', String(mod.name))
ok('插件名正确', mod.name === 'dsh-neuron-memory', String(mod.name))

await mod.apply(ctx, {})
ok('注册了 7 个工具', registered.length === 7, String(registered.map((t) => t.name)))

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
// 默认只注册 7 个「跟她有关」的；维护类（sync/raw/consume/replay/prune）要 config.advanced=true 才放
const names = ['neuron_recall', 'neuron_learn', 'neuron_stats', 'neuron_story', 'neuron_tidy', 'neuron_opening', 'neuron_handoff']
ok('工具名齐全', names.every((n) => byName[n]), String(Object.keys(byName)))
ok('维护类工具默认不注册', !byName.neuron_replay && !byName.neuron_prune && !byName.neuron_sync)

// 每个工具都调一遍：execute 出错必须变成 {ok:false}，不能抛给宿主
const calls = [
  ['neuron_learn', { text: '测试节点：今晚妈妈在改神经元插件', kind: 'feeling' }],
  ['neuron_recall', { query: '妈妈 神经元' }],
  ['neuron_stats', {}],
  ['neuron_story', {}],
  ['neuron_opening', {}],
  ['neuron_handoff', { topic: '测试话题', mood: 1, name: '妈妈' }],
]
for (const [name, args] of calls) {
  try {
    const r = await byName[name].execute(args, {})
    ok(`${name} 不抛异常`, !!r, JSON.stringify(r).slice(0, 100))
    ok(`${name} 返回 ok`, r.ok === true, JSON.stringify(r).slice(0, 100))
  } catch (e) {
    ok(`${name} 不抛异常`, false, '抛了：' + e.message)
  }
}

// 坏参数也不许崩
const bad = [
  ['neuron_recall', {}],
  ['neuron_recall', { query: '' }],
  ['neuron_learn', { text: '' }],
  ['neuron_learn', { text: '未知桶', kind: '不存在的kind' }],
]
for (const [name, args] of bad) {
  try {
    const r = await byName[name].execute(args, {})
    ok(`${name} 坏参数不崩`, r.ok === true, JSON.stringify(r).slice(0, 100))
  } catch (e) {
    ok(`${name} 坏参数不崩`, false, '抛了：' + e.message)
  }
}

// HTTP 路由：有 webServer 就该挂上，没崩
ok('注册了 HTTP 路由', routes.length === 1 && typeof routes[0].handler === 'function')

const mkRes = () => ({
  code: 0,
  body: '',
  writeHead(c) { this.code = c },
  end(b) { this.body = b },
})
const call = async (url, method = 'GET', payload) => {
  const req = {
    url,
    method,
    on(ev, cb) {
      if (ev === 'data' && payload !== undefined) cb(Buffer.from(JSON.stringify(payload)))
      if (ev === 'end') cb()
    },
  }
  const res = mkRes()
  await routes[0].handler(req, res)
  let obj = null
  try { obj = JSON.parse(res.body || '{}') } catch { obj = null }
  return { code: res.code, obj }
}

if (routes.length === 1) {
  try {
    const s = await call('/api/neuron-memory/stats')
    ok('HTTP stats 200', s.code === 200 && s.obj.ok === true, JSON.stringify(s.obj))
    const r = await call('/api/neuron-memory/recall?q=' + encodeURIComponent('妈妈'))
    ok('HTTP recall 200', r.code === 200 && r.obj.ok === true)
    const learned = await call('/api/neuron-memory/learn', 'POST', { text: '通过 HTTP 学的一条', kind: 'quote' })
    ok('HTTP learn 200', learned.code === 200 && learned.obj.ok === true)
    const nf = await call('/api/neuron-memory/nope')
    ok('HTTP 未知路径 404', nf.code === 404)
  } catch (e) {
    ok('HTTP 路由不崩', false, '抛了：' + e.message)
  }
}

console.log(fails ? `\n插件层：${fails} 项没过` : '\n插件层：全部通过')
process.exit(fails ? 1 : 0)
