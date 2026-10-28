// 模拟真实宿主：从 profile 的 node_modules 加载本插件（不启动 DSH、不改宿主状态）
// 跑：node test-host.mjs
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const entry = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-neuron-memory', 'index.js')

let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✅', name)
  else { fails++; console.log('  ❌', name, extra) }
}

ok('profile 里能找到插件入口', existsSync(entry), entry)
if (!existsSync(entry)) process.exit(1)

const mod = await import(pathToFileURL(entry).href)
ok('宿主路径能 import', typeof mod.apply === 'function')
ok('导出 name', typeof mod.name === 'string', mod.name)
ok('导出 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))

const registered = []
const routes = []
const ctx = {
  tools: { register: (t) => { registered.push(t); return t } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (fn) => fn(),
}
await mod.apply(ctx, {})
ok('按宿主注入后注册了工具', registered.length === 7, String(registered.map((t) => t.name)))
ok('挂上了 HTTP 路由', routes.length === 1)

const recall = registered.find((t) => t.name === 'neuron_recall')
const r = await recall.execute({ query: '豆包', limit: 3 })
ok('能查到记忆', r.ok === true && r.count > 0, JSON.stringify(r).slice(0, 100))
ok('带出了上下文', (r.nodes || []).some((n) => (n.context || []).length > 0))

console.log(fails ? `\n宿主加载模拟：${fails} 项没过` : '\n宿主加载模拟：通过（重启后应能直接用）')
process.exit(fails ? 1 : 0)
