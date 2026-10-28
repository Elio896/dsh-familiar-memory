#!/usr/bin/env node
/**
 * install.mjs —— 一条命令把本插件装进 DSH 的桌面 profile
 *
 * 用法：
 *   node install.mjs                 # 装进默认 profile（desktop）
 *   node install.mjs --profile web   # 装进别的 profile
 *
 * 它做四件事（都可重复执行，幂等）：
 *   1. 把插件目录复制进 <profile>/node_modules/dsh-neuron-memory
 *      （注意是复制，不是 junction —— 跨盘链接宿主解析不到，踩过）
 *   2. 在 profile 的 package.json 里登记 bundle 和 file 依赖（先备份）
 *   3. 跑一遍安装前自检
 *   4. 打印下一步（重启宿主）
 */
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const profileArg = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : 'desktop'
const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileArg)
const pkgPath = join(profileDir, 'package.json')
const PLUGIN = 'dsh-neuron-memory'
const dst = join(profileDir, 'node_modules', PLUGIN)

const fail = (m) => { console.error('✗ ' + m); process.exit(1) }
const ok = (m) => console.log('✓ ' + m)

// 1) profile 在不在
if (!existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}\n  先启动一次 DSH，或者指定 --profile <名字>`)
if (!existsSync(pkgPath)) fail(`profile 里没有 package.json：${pkgPath}`)
ok(`profile：${profileDir}`)

// 2) 复制插件（先删旧副本，避免残留旧文件）
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
cpSync(here, dst, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) && !/[\\/].*\.db(-wal|-shm)?$/.test(src),
})
ok(`插件已复制到 ${dst}`)

// 3) 登记 bundle + file 依赖（先备份 package.json）
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
copyFileSync(pkgPath, pkgPath + '.bak-install-' + Date.now())
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = (pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [])
if (!bundles.includes(PLUGIN)) bundles.push(PLUGIN)
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[PLUGIN] = 'file:' + resolve(here).replace(/\\/g, '/')
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
ok(`已在 profile 的 bundles / dependencies 里登记 ${PLUGIN}`)

// 4) 跑自检
console.log('\n跑安装前自检…')
const { spawnSync } = await import('node:child_process')
const t = spawnSync(process.execPath, [join(here, 'test-install.mjs')], { stdio: 'inherit', cwd: here })
if (t.status !== 0) fail('自检没过，先别重启')

console.log(`\n装好了。下一步：重启 DSH（托盘退出再打开），设置页里就会出现「神经元记忆」。`)
console.log(`回滚：删 ${dst}，再把 ${pkgPath} 旁边的 .bak-install-* 还原回去。`)
