// 第三层：安装前自检。不启动 DSH，只做静态检查：
// 该有的文件在不在、依赖是不是可选的、数据路径是不是在 DSH_HOME 下。
// 跑：node test-install.mjs —— 全绿才建议真装
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✅', name)
  else { fails++; console.log('  ❌', name, extra) }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
ok('package.json 有 name', !!pkg.name, pkg.name)
ok('main 指向的文件存在', existsSync(join(ROOT, pkg.main || 'index.js')), pkg.main)
ok('type 是 module', pkg.type === 'module')
ok('dsh.engines 声明了版本', !!pkg.engines?.dsh, JSON.stringify(pkg.engines))
ok('宿主依赖都是 peer + optional（不硬装）',
  !Object.keys(pkg.dependencies || {}).length &&
  Object.values(pkg.peerDependenciesMeta || {}).every((v) => v.optional === true))
ok('files 字段没有漏掉入口', (pkg.files || []).includes('index.js') && (pkg.files || []).includes('lib'))

const patch = join(ROOT, 'cordis.patch.yml')
ok('cordis.patch.yml 存在', existsSync(patch))
const index = readFileSync(join(ROOT, 'index.js'), 'utf8')
ok('数据路径走 DSH_HOME（没有硬编码用户目录）',
  index.includes('DSH_HOME') && !/C:\\\\Users|C:\/Users/.test(index))
ok('工具 execute 有 try/catch 兜底', index.includes('catch (e)') && index.includes('ok: false'))
ok('webServer 注册有 try/catch 兜底', index.includes("try {") && index.includes('// 没有 webServer 也能用工具') || index.includes('没有 webServer 也能用工具'))

// 原生模块能不能用（node:sqlite 是内置的，跟着 node 版本走）
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t(x)')
  ok('node:sqlite 可用', true)
} catch (e) {
  ok('node:sqlite 可用', false, e.message)
}

console.log(fails ? `\n安装前自检：${fails} 项没过，先别装` : '\n安装前自检：全部通过，可以装')
process.exit(fails ? 1 : 0)
