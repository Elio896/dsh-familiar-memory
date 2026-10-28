// 本地自测 lib/neuron.mjs（不依赖 DSH）
import { NeuronStore } from './lib/neuron.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'neuron-test-'))
const store = new NeuronStore(join(dir, 'neuron.db'))

store.learn('妈妈电脑的挖矿病毒查清了：srbminer/bzminer 伪装成 SecurityHealthHost 挖了约 15 天', 'event')
store.learn('入口是 10/13 下的 365/Safewoo 那批可疑软件', 'event')
store.learn('刷抖音优化：只看文字、长视频跳过、失败两次就停', 'fact')
store.learn('妈妈要参加黑客松，想展示省 token 的神经元记忆', 'event')

console.log('stats:', store.stats())
const r = store.recall('显卡 挖矿')
console.log('recall 显卡挖矿 →', r.count, '个节点')
for (const n of r.nodes) console.log(`  #${n.id} [${n.kind}] score=${n.score} ${String(n.text).slice(0, 40)}`)

const r2 = store.recall('抖音 优化')
console.log('recall 抖音优化 →', r2.count, '个节点')
for (const n of r2.nodes) console.log(`  #${n.id} [${n.kind}] score=${n.score} ${String(n.text).slice(0, 40)}`)

const rep = store.replay()
console.log('replay:', rep)
console.log('story:', store.story().length, '条')
console.log('prune:', store.prune())
