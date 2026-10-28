// 一键跑完三层测试：核心逻辑 → 插件契约 → 安装前自检。
// 跑：node test-all.mjs —— 三层全绿才建议真装
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const layers = ['test-core.mjs', 'test-plugin.mjs', 'test-install.mjs']
let bad = 0

for (const f of layers) {
  console.log(`\n=== ${f} ===`)
  const r = spawnSync(process.execPath, [join(ROOT, f)], { stdio: 'inherit', cwd: ROOT })
  if (r.status !== 0) bad++
}

console.log(bad ? `\n${bad} 层没过，先别装` : '\n三层全绿，可以装')
process.exit(bad ? 1 : 0)
