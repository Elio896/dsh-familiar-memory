// 重启前的只读自检：只看不改，确认宿主配置和插件都完好。
// 跑：node check-host.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = join(home, 'profiles', 'desktop')
const PLUGIN = 'dsh-neuron-memory'

let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✅', name)
  else { fails++; console.log('  ❌', name, extra) }
}

// 1) profile 的 package.json 合法、依赖都能解析
let pkg = null
try { pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) } catch (e) { }
ok('profile/package.json 是合法 JSON', !!pkg)

if (pkg) {
  const bundles = pkg.dsh?.profile?.bundles || []
  ok(`bundles 里登记了 ${PLUGIN}`, bundles.includes(PLUGIN), JSON.stringify(bundles))
  ok('bundles 没有重复项', new Set(bundles).size === bundles.length)
  ok('dependencies 里登记了链接', String(pkg.dependencies?.[PLUGIN] || '').startsWith('file:'))

  const missing = bundles.filter((b) => !b.startsWith('@deepseek-ai/') && !existsSync(join(profile, 'node_modules', b)))
  ok('bundles 里的包都能在 node_modules 找到', missing.length === 0, missing.join(', '))

  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!String(spec).startsWith('file:')) continue
    const p = String(spec).slice(5)
    ok(`file: 依赖 ${name} 路径存在`, existsSync(p), p)
  }
}

// 2) 两份 YAML 只是行级体检（不引第三方包，防止为了检查反而装东西）
const yamlCheck = (label, file) => {
  if (!existsSync(file)) return ok(`${label} 存在`, false, file)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const badTab = lines.some((l) => l.includes('\t'))
  const hasEntry = lines.some((l) => l.trim().startsWith('- '))
  // 合法行：空行/注释/列表项/流式数组/映射键值/纯标量项
  const okLine = (t) => !t || t.startsWith('#') || t.startsWith('-') ||
    t.startsWith('[') || t.startsWith(']') || t.startsWith('{') || t.startsWith('}') ||
    t.startsWith("'") || t.startsWith('"') || /^\d/.test(t) ||
    /^[^\s:]+:(\s|$)/.test(t)
  const odd = lines.filter((l) => l.trim() && !okLine(l.trim()))
  ok(`${label} 没有 tab 缩进`, !badTab)
  ok(`${label} 有入口条目`, hasEntry)
  ok(`${label} 每行格式正常`, odd.length === 0, odd.slice(0, 2).join(' | '))
  return true
}
yamlCheck('profile 的 cordis.patch.yml', join(profile, 'cordis.patch.yml'))
yamlCheck('插件自带的 cordis.patch.yml', join(profile, 'node_modules', PLUGIN, 'cordis.patch.yml'))

// 3) id 不重复：neuron-memory 只能挂一次
try {
  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') +
    readFileSync(join(profile, 'node_modules', PLUGIN, 'cordis.patch.yml'), 'utf8')
  const hits = (patch.match(/id:\s*(?:dsh-)?neuron-memory/g) || []).length
  ok('neuron-memory 只挂一次', hits === 1, `出现 ${hits} 次`)
} catch { /* 上面已经报过存在性 */ }

// 4) 真正 import 一遍：加载失败才最可能拖垮宿主
const entry = join(profile, 'node_modules', PLUGIN, 'index.js')
if (existsSync(entry)) {
  try {
    const mod = await import(pathToFileURL(entry).href)
    ok('插件能被 import', typeof mod.apply === 'function')
    const registered = []
    const routes = []
    const ctx = {
      tools: { register: (t) => { registered.push(t); return t } },
      webServer: { register: (r) => { routes.push(r); return () => {} } },
      effect: (fn) => fn(),
    }
    await mod.apply(ctx, {})
    ok('注入后注册 7 个工具', registered.length === 7, String(registered.length))
    ok('挂载 HTTP 路由', routes.length === 1)
  } catch (e) {
    ok('插件能被 import', false, e.message)
  }
} else {
  ok('插件入口存在', false, entry)
}

console.log(fails ? `\n重启前自检：${fails} 项没过，先别重启` : '\n重启前自检：全过，可以重启（原配置已备份）')
process.exit(fails ? 1 : 0)
