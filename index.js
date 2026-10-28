/**
 * index.js —— dsh-neuron-memory 插件入口
 * 神经元记忆：图记忆 + 激活扩散 + 遗忘衰减。数据全存本地（DSH_HOME/neuron-memory）。
 */
import { join, dirname } from 'node:path'
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { NeuronStore } from './lib/neuron.mjs'

// 顶层脚印：宿主一旦 import 这个模块就写一行。
// 用来分清两件事：是「根本没加载」，还是「加载了但 apply 没被调用」。
try {
  const _home0 = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  appendFileSync(join(_home0, 'neuron-memory', 'boot.log'), `[${new Date().toISOString()}] 模块已 import\n`)
} catch { /* 日志失败不影响加载 */ }

export const name = 'dsh-neuron-memory'
export const inject = ['webServer', 'tools']

/** 同步拿宿主的 defineTool（cordis 加载器不认顶层 await，这里不能 await） */
const require = createRequire(import.meta.url)
let defineTool = (x) => x
try {
  const mod = require('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch { /* 用本地兜底 */ }

const readBody = (req) => new Promise((resolve) => {
  let d = ''
  req.on('data', (c) => { d += c })
  req.on('end', () => {
    try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) }
  })
})

export function apply(ctx, config) {
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  // 启动脚印：宿主加载失败只打 console.warn、不落盘，我们自己留一份好排查
  const bootLog = (m) => {
    try { appendFileSync(join(home, 'neuron-memory', 'boot.log'), `[${new Date().toISOString()}] ${m}\n`) } catch { }
  }
  bootLog(`apply 开始 inject=${JSON.stringify(inject)} dshTools=${defineTool !== ((x) => x) ? '宿主' : '本地兜底'}`)
  // 库位置优先级：环境变量 > 插件 config（cordis.patch.yml）> config.json > 默认空库
  const c = config || {}
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(join(home, 'neuron-memory', 'config.json'), 'utf8')) } catch { cfg = {} }

  // 两种模式：聊天（full，带原文和同日上下文）/ 工作（lite，只回节点文本，省 token）
  const normalizeMode = (m) => (m === 'work' || m === 'lite' ? 'work' : 'chat')
  let currentMode = normalizeMode(process.env.NEURON_MODE || c.mode || cfg.mode)
  const modeOf = () => (currentMode === 'work' ? 'lite' : 'full')
  const setMode = (m) => {
    currentMode = normalizeMode(m)
    try {
      const p = join(home, 'neuron-memory', 'config.json')
      const next = { ...cfg, mode: currentMode }
      writeFileSync(p, JSON.stringify(next, null, 2) + '\n')
      cfg = next
    } catch { /* 写不进去就只在内存里切 */ }
    bootLog(`模式切到 ${currentMode}（recall 默认 ${modeOf()}）`)
    return currentMode
  }
  bootLog(`启动模式 ${currentMode}（recall 默认 ${modeOf()}）`)
  const dbPath = String(process.env.NEURON_DB || c.db || cfg.db || '').trim() || join(home, 'neuron-memory', 'neuron.db')
  // 原文库默认跟主库放一起（memory/neuron.db 旁边就是 memory/memory.db）；没有这个文件会静默跳过
  const sourcePath = String(process.env.NEURON_SOURCE_DB || c.source_db || cfg.source_db || '').trim() || join(dirname(dbPath), 'memory.db')
  let store = null
  // 可调参数：config 里给了才覆盖，没给就用 lib 里的默认值
  const optNum = (v) => (v === undefined || v === null || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined))
  const storeOpts = Object.fromEntries(Object.entries({
    halfLifeDays: optNum(c.halfLifeDays),
    weightDecayPerDay: optNum(c.weightDecayPerDay),
    sinkBelow: optNum(c.sinkBelow),
    sinkLimit: optNum(c.sinkLimit),
    hops: optNum(c.hops),
  }).filter(([, v]) => v !== undefined))
  const db = () => (store || (store = new NeuronStore(dbPath, sourcePath, storeOpts)))
  bootLog(`库: ${dbPath} 原文: ${sourcePath}`)

  // 最近点亮：内存里留 20 条，面板打开就知道它刚才想起过什么（不落盘）
  const recent = []
  const pushRecent = (q, r, mode) => {
    try {
      recent.unshift({ t: new Date().toISOString().slice(11, 19), q: String(q || '（敞开聊）'), count: r.count, mode })
      if (recent.length > 20) recent.pop()
    } catch { /* 记录失败不影响召回 */ }
  }

  // 工具输出格式（defineTool 需要 output.render，不传会启动失败）
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => {
    try {
      return ctx.tools.register(defineTool({
        ...spec,
        output: textOutput,
        async execute(args, exec) {
          // 工具出错返回 {ok:false}，绝不把异常抛给宿主（插件崩了不能拖垮会话）
          try {
            return safe(await spec.execute(args, exec))
          } catch (e) {
            return { ok: false, error: e?.message ?? String(e) }
          }
        },
      }))
    } catch (e) {
      bootLog(`工具注册失败 ${spec.name}: ${e?.stack || e}`)
      return null
    }
  }

  tool({
    name: 'neuron_recall',
    description: '神经元记忆：按关键词激活相关记忆节点（种子 + 关联扩散），返回按相关度排好序的子图。比整段 RAG 检索省 token。',
    parameters: {
      query: { type: 'string', description: '两三个关键词', required: true },
      limit: { type: 'number', description: '最多返回几个节点' },
      mode: {
        type: 'string',
        enum: ['lite', 'full'],
        description: 'lite = 省 token（只回节点文本，默认 3 条）；full = 带原文和同日上下文（默认 6 条）',
      },
    },
    async execute(args) {
      // 没显式指定就跟着模式走：聊天=full，工作=lite
      const mode = args.mode === 'lite' ? 'lite' : args.mode === 'full' ? 'full' : modeOf()
      const limit = Number(args.limit) || (mode === 'lite' ? 3 : 6)
      const r = db().recall(String(args.query || ''), limit)
      pushRecent(args.query, r, mode)
      return {
        ok: true,
        mode,
        count: r.count,
        ...(r.fallback
          ? { fallback: true, hint: '没有相关记忆；下面是最近活跃的几条，不是相关结果' }
          : {}),
        nodes: r.nodes.map((n) => (mode === 'lite'
          ? { id: n.id, kind: n.kind, text: String(n.text || '').slice(0, 60) }
          : {
            id: n.id, kind: n.kind, score: n.score, text: n.text, ts: n.ts,
            source: n.source, context: n.context,
          })),
      }
    },
  })

  tool({
    name: 'neuron_learn',
    description: '往神经元记忆里学一条（自动生成节点并连边）。kind 分温度桶：fact/event/lesson 是档案，feeling 是感受、quote 是原话、preference 是偏好雷区、self 是当晚回味。',
    parameters: {
      text: { type: 'string', description: '一句话，压缩过的事实/感受，带时间、动作、画面更好', required: true },
      kind: {
        type: 'string',
        enum: ['fact', 'event', 'lesson', 'feeling', 'quote', 'preference', 'self'],
        description: '存档的桶，默认 fact',
      },
    },
    async execute(args) { return { ok: true, ...db().learn(String(args.text), args.kind || 'fact') } },
  })

  tool({
    name: 'neuron_stats',
    description: '看神经元记忆的节点数和连接数。',
    parameters: {},
    async execute() { return { ok: true, ...db().stats() } },
  })

  tool({
    name: 'neuron_story',
    description: '把某天的记忆按时间串成一条叙事线（回忆一天）。',
    parameters: {
      day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
    },
    async execute(args) { return { ok: true, items: db().story(args.day) } },
  })

  tool({
    name: 'neuron_replay',
    description: '回放某天：把当天节点之间按更松的阈值重新连边（像睡眠重播巩固记忆）。',
    parameters: {
      day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
    },
    async execute(args) { return { ok: true, ...db().replay(args.day) } },
  })

  tool({
    name: 'neuron_tidy',
    description: '整理记忆：把权重最淡的几条沉底（最多 sinkLimit 条）。沉 ≠ 删，沉底的还查得到，只是排后面。',
    parameters: {},
    async execute() { return { ok: true, ...db().tidy() } },
  })

  tool({
    name: 'neuron_prune',
    description: '剪掉很久没用、衰减到快忘光的连接（清理旧突触）。',
    parameters: {},
    async execute() { return { ok: true, ...db().prune() } },
  })

  // ---- 给前端面板的 HTTP API ----
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/neuron-memory',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const p = url.pathname
          if (p === '/api/neuron-memory/stats') return send(200, { ok: true, ...db().stats() })
          if (p === '/api/neuron-memory/top') {
            const n = Number(url.searchParams.get('n')) || 20
            return send(200, { ok: true, nodes: db().top(n) })
          }
          if (p === '/api/neuron-memory/sunk') return send(200, { ok: true, nodes: db().sunk() })
          if (p === '/api/neuron-memory/recent') return send(200, { ok: true, items: recent })
          if (p === '/api/neuron-memory/mode') {
            if (req.method === 'POST') {
              const body = await readBody(req)
              setMode(body.mode)
            }
            return send(200, { ok: true, mode: currentMode, recall: modeOf() })
          }
          if (p === '/api/neuron-memory/recall') {
            const q = url.searchParams.get('q') || ''
            const r = db().recall(q, Number(url.searchParams.get('limit')) || 6)
            return send(200, { ok: true, ...r })
          }
          if (p === '/api/neuron-memory/story') return send(200, { ok: true, items: db().story(url.searchParams.get('day') || undefined) })
          if (p === '/api/neuron-memory/replay') return send(200, { ok: true, ...db().replay(url.searchParams.get('day') || undefined) })
          if (p === '/api/neuron-memory/prune') return send(200, { ok: true, ...db().prune() })
          if (p === '/api/neuron-memory/tidy') return send(200, { ok: true, ...db().tidy() })
          if (req.method === 'POST' && p === '/api/neuron-memory/learn') {
            const body = await readBody(req)
            return send(200, { ok: true, ...db().learn(String(body.text || ''), body.kind || 'fact') })
          }
          return send(404, { ok: false, error: `unknown ${req.method} ${p}` })
        } catch (e) {
          send(500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'neuron-memory: /api/neuron-memory 路由')
    bootLog('HTTP 路由已挂 /api/neuron-memory')
  } catch (e) {
    bootLog(`HTTP 路由没挂上: ${e?.stack || e}`) /* 没有 webServer 也能用工具 */
  }
  bootLog('apply 结束')
}
