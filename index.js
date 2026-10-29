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

const MAX_BODY = 64 * 1024
const readBody = (req) => new Promise((resolve) => {
  let d = ''
  let tooBig = false
  req.on('data', (c) => {
    if (tooBig) return
    d += c
    if (d.length > MAX_BODY) { tooBig = true; resolve({ __tooBig: true }) }
  })
  req.on('end', () => {
    if (tooBig) return
    try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) }
  })
})

/** 只接受本机来源的写请求（防任意网页用 <img src> / fetch 触发） */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i

export function apply(ctx, config) {
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  // 启动脚印：宿主加载失败只打 console.warn、不落盘，我们自己留一份好排查
  const bootLog = (m) => {
    try { appendFileSync(join(home, 'neuron-memory', 'boot.log'), `[${new Date().toISOString()}] ${m}\n`) } catch { }
  }
  bootLog(`apply 开始 v0.2.0 inject=${JSON.stringify(inject)} dshTools=${defineTool !== ((x) => x) ? '宿主' : '本地兜底'}`)
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
    warmBoost: optNum(c.warmBoost),
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
  // 维护/管道类工具默认不注册：对她说话时毫无用处，只会稀释选择。
  // 需要时在 config 里写 advanced: true 全放出来。
  const ADVANCED = new Set(['neuron_sync', 'neuron_raw', 'neuron_consume', 'neuron_replay', 'neuron_prune'])
  const tool = (spec) => {
    if (ADVANCED.has(spec.name) && cfg.advanced !== true) return null
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
      scope: {
        type: 'string',
        description: '场景隔离，默认 private。群聊/工作等场景各自独立，跨场景不会互相召回',
      },
      tag: {
        type: 'string',
        description: '只查某类记忆：工作 / 闲聊（不传=不筛）',
      },
    },
    async execute(args) {
      // 没显式指定就跟着模式走：聊天=full，工作=lite
      const mode = args.mode === 'lite' ? 'lite' : args.mode === 'full' ? 'full' : modeOf()
      const limit = Number(args.limit) || (mode === 'lite' ? 3 : 6)
      const r = db().recall(String(args.query || ''), limit, { scope: args.scope || 'private', tag: args.tag || '' })
      pushRecent(args.query, r, mode)
      return {
        ok: true,
        mode,
        count: r.count,
        ...(mode === 'lite' ? { compact: true } : {}),
        ...(r.fallback
          ? {
            fallback: true,
            hint: r.nodes.length
              ? '没有相关记忆；下面是最近活跃的几条，不是相关结果'
              : '没有相关记忆（这块是空的）',
          }
          : {}),
        nodes: r.nodes.map((n) => (mode === 'lite'
          // 不截断文本：截断会把“下半句才是重点”的记忆切废。省 token 靠减条数（默认 3 条）。
          ? { id: n.id, kind: n.kind, text: String(n.text || '') }
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
      scope: {
        type: 'string',
        description: '场景隔离，默认 private。群聊/工作等场景各自独立',
      },
      tag: {
        type: 'string',
        description: '类别：工作 / 闲聊（用来分开查，不传=不分类）',
      },
      decidedAt: {
        type: 'string',
        description: '什么时候拍板的（work scope 默认=写入时间）。查状态时按它取最新，不按“最像”',
      },
      supersedes: {
        type: 'number',
        description: '覆盖了哪条旧决定的 id（旧的那条会自动沉底，不许再被当成“现在的”）',
      },
    },
    async execute(args) {
      return {
        ok: true,
        ...db().learn(String(args.text), args.kind || 'fact', undefined, args.tag || '', args.scope || 'private', {
          decidedAt: args.decidedAt,
          supersedes: args.supersedes,
        }),
      }
    },
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

  tool({
    name: 'neuron_opening',
    description: '会话开场：返回一段可直接放进 system prompt 的文字（称呼、上次心情、聊到哪、下次要问什么、记得什么），硬上限 250 字。换会话不是重新认识，是接着上次。',
    parameters: {
      scope: { type: 'string', description: '场景，默认 private' },
      includeWork: { type: 'boolean', description: '工作会话传 true：追加「项目状态」（按拍板时间排序）。闲聊不要传，两个块互斥不叠加' },
    },
    async execute(args) {
      return { ok: true, text: db().opening(args.scope || 'private', { includeWork: !!args.includeWork }) }
    },
  })

  tool({
    name: 'neuron_handoff',
    description: '会话交接：只记三行——话题 / 卡在哪 / 下次我要问什么，加一个情绪数（-2 到 +2）。别写总结，三行就够。',
    parameters: {
      topic: { type: 'string', description: '这次聊的是什么' },
      phase: { type: 'string', description: '卡在哪 / 到哪一步了' },
      nextAsk: { type: 'string', description: '下次想问她什么' },
      mood: { type: 'number', description: '她的情绪 -2（很难过）到 +2（挺开心）' },
      name: { type: 'string', description: '称呼（写进关系表，下次开场第一句就是「你正在和 XX 说话」）' },
      scope: { type: 'string', description: '场景，默认 private' },
    },
    async execute(args) {
      return { ok: true, ...db().handoff({
        topic: args.topic, phase: args.phase, nextAsk: args.nextAsk, mood: args.mood, name: args.name,
      }, args.scope || 'private') }
    },
  })

  tool({
    name: 'neuron_sync',
    description: '扫会话记录，把新的用户消息抓进 raw_log（自动录入的「抓」）。插件每 10 分钟自己也会跑一次，不用手动。',
    parameters: {
      days: { type: 'number', description: '扫最近几天，默认 3' },
    },
    async execute(args) {
      return { ok: true, ...db().syncSessions({ days: Number(args.days) || 3 }) }
    },
  })

  tool({
    name: 'neuron_raw',
    description: '读还没提炼的原始消息（提炼的原料）。提炼完用 neuron_consume 标记掉。',
    parameters: {
      limit: { type: 'number', description: '最多回几条，默认 30' },
    },
    async execute(args) {
      return { ok: true, pending: db().pendingRaw(), items: db().rawPending(Number(args.limit) || 30) }
    },
  })

  tool({
    name: 'neuron_consume',
    description: '把已提炼的原始消息标记掉。ids 不传=全部标记。',
    parameters: {
      ids: { type: 'string', description: '逗号分隔的 raw_log id；不传=全部标记' },
    },
    async execute(args) {
      const ids = String(args.ids || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0)
      return { ok: true, ...db().markConsumed(ids) }
    },
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
          // 写请求只认本机来源：有 Origin/Referer 但不是 127.0.0.1/localhost 一律 403
          if (req.method !== 'GET') {
            const origin = String(req.headers?.origin || req.headers?.referer || '')
            if (origin && !LOCAL_ORIGIN.test(origin)) {
              return send(403, { ok: false, error: 'cross-origin write rejected' })
            }
          }
          if (p === '/api/neuron-memory/stats') return send(200, { ok: true, ...db().stats() })
          if (p === '/api/neuron-memory/top') {
            const n = Number(url.searchParams.get('n')) || 20
            return send(200, { ok: true, nodes: db().top(n) })
          }
          if (p === '/api/neuron-memory/sunk') return send(200, { ok: true, nodes: db().sunk() })
          if (p === '/api/neuron-memory/recent') return send(200, { ok: true, items: recent })
          if (p === '/api/neuron-memory/opening') {
            return send(200, { ok: true, text: db().opening(url.searchParams.get('scope') || 'private') })
          }
          if (p === '/api/neuron-memory/mode') {
            if (req.method === 'POST') {
              const body = await readBody(req)
              if (body.__tooBig) return send(413, { ok: false, error: 'body too large' })
              const m = String(body.mode || '')
              if (!['chat', 'work', 'lite', 'full'].includes(m)) {
                return send(400, { ok: false, error: 'mode must be chat|work|lite|full' })
              }
              setMode(m)
            }
            return send(200, { ok: true, mode: currentMode, recall: modeOf() })
          }
          if (p === '/api/neuron-memory/recall') {
            const q = url.searchParams.get('q') || ''
            const r = db().recall(q, Number(url.searchParams.get('limit')) || 6)
            return send(200, { ok: true, ...r })
          }
          if (p === '/api/neuron-memory/story') return send(200, { ok: true, items: db().story(url.searchParams.get('day') || undefined) })
          // 以下三个会写库：只认 POST
          if (p === '/api/neuron-memory/replay') {
            if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST' })
            return send(200, { ok: true, ...db().replay(url.searchParams.get('day') || undefined) })
          }
          if (p === '/api/neuron-memory/prune') {
            if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST' })
            return send(200, { ok: true, ...db().prune() })
          }
          if (p === '/api/neuron-memory/tidy') {
            if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST' })
            return send(200, { ok: true, ...db().tidy() })
          }
          if (req.method === 'POST' && p === '/api/neuron-memory/learn') {
            const body = await readBody(req)
            if (body.__tooBig) return send(413, { ok: false, error: 'body too large' })
            return send(200, { ok: true, ...db().learn(String(body.text || ''), body.kind || 'fact', undefined, '', body.scope || 'private') })
          }
          if (req.method === 'POST' && p === '/api/neuron-memory/handoff') {
            const body = await readBody(req)
            if (body.__tooBig) return send(413, { ok: false, error: 'body too large' })
            return send(200, { ok: true, ...db().handoff(body, body.scope || 'private') })
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

  // 自动录入：插件自己定时扫会话记录，把用户消息抓进 raw_log。
  // 只「抓原文」，不判断、不写库——提炼仍由我按规矩做（插件不知道哪句值得记）。
  // 想让它顺手提炼，显式调 neuron_sync 时传 autoExtract。
  try {
    const autoOn = cfg.autoSync !== false
    if (autoOn) {
      const mins = Math.max(1, Number(cfg.autoSyncMinutes) || 10)
      const timer = setInterval(() => {
        try {
          const r = db().syncSessions({ days: 2, autoExtract: false })
          if (r.added) bootLog(`自动录入 +${r.added} 条（待提炼 ${r.pending}）`)
        } catch (e) { bootLog(`自动录入失败: ${e?.message || e}`) }
      }, mins * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      ctx.effect(() => () => clearInterval(timer))
      bootLog(`自动录入定时器已挂（每 ${mins} 分钟扫一次）`)
    } else {
      bootLog('自动录入已关（config.autoSync=false）')
    }
  } catch (e) {
    bootLog(`自动录入定时器没挂上: ${e?.message || e}`)
  }
  bootLog('apply 结束')
}
