// 验证真实 DSH_HOME 下的配置能接上记忆库（只调 recall，副作用只有刷新边的 last_active）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const cfg = JSON.parse(readFileSync(join(home, 'neuron-memory', 'config.json'), 'utf8'))
console.log('配置指向:', cfg.db)

const registered = []
const ctx = {
  tools: { register: (t) => { registered.push(t); return t } },
  webServer: { register: () => () => {} },
  effect: (fn) => fn(),
}
const mod = await import('./index.js')
await mod.apply(ctx, {})
const recall = registered.find((t) => t.name === 'neuron_recall')
const r = await recall.execute({ query: '豆包 妈妈', limit: 4 })
console.log('命中', r.count)
let ctxN = 0
for (const n of r.nodes) {
  console.log(`[${n.kind}] ${String(n.text).slice(0, 34)}`)
  for (const c of n.context || []) { ctxN++; console.log('   那天', c.t, String(c.text).slice(0, 34)) }
}
console.log(ctxN > 0 ? '\n接入真库：上下文能出来' : '\n接入真库：没拿到上下文')
process.exit(ctxN > 0 ? 0 : 1)
