// 用真实记忆库的「副本」验证：原文 + 同日上下文能出来（全程不碰原库）
// 跑：NEURON_REAL=<你的 memory 目录> node test-actual.mjs
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NeuronStore } from './lib/neuron.mjs'

const MEM = String(process.env.NEURON_REAL || '').trim()
if (!MEM) {
  console.error('先设 NEURON_REAL=<你的 memory 目录>（里面有 neuron.db 和 memory.db）')
  process.exit(2)
}
const dir = mkdtempSync(join(tmpdir(), 'neuron-real-'))
copyFileSync(join(MEM, 'neuron.db'), join(dir, 'neuron.db'))
copyFileSync(join(MEM, 'memory.db'), join(dir, 'memory.db'))

const store = new NeuronStore(join(dir, 'neuron.db'), join(dir, 'memory.db'))
const r = store.recall('豆包 妈妈', 6)
console.log('命中', r.count)
for (const n of r.nodes) {
  console.log(`[${n.kind}] #${n.id} ${String(n.text).slice(0, 40)}`)
  if (n.source) console.log('   原文:', String(n.source).slice(0, 60))
  for (const c of n.context || []) {
    console.log(`   那天${c.order === 'prev' ? '前' : '后'} ${c.t}`, String(c.text).slice(0, 40))
  }
}
const ok = r.nodes.some((n) => (n.context || []).length > 0)
console.log(ok ? '\n真实库：同日上下文能出来' : '\n真实库：没拿到上下文')
process.exit(ok ? 0 : 1)
