/**
 * client.js —— 神经元记忆面板（设置页里的一项：神经元记忆）
 */
window.__ModuleLoader__.load({
  id: 'dsh-neuron-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/neuron-memory'
    const PANEL_BUILD = 1

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-nm-page]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px;max-width:640px;font-size:13px;}
[data-nm-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-nm-title]{font-size:13px;font-weight:600;}
[data-nm-sub]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-nm-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-nm-input]{flex:1;min-width:0;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-nm-input]:focus{outline:none;border-color:#3b82f6;}
[data-nm-btn]{padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-nm-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-nm-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-nm-btn][data-danger]{color:#f87171;}
[data-nm-list]{display:flex;flex-direction:column;gap:6px;}
[data-nm-item]{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.18));font-size:12px;line-height:17px;}
[data-nm-score]{flex:none;font-variant-numeric:tabular-nums;color:#3b82f6;font-weight:600;}
[data-nm-kind]{flex:none;font-size:10px;padding:1px 6px;border-radius:5px;margin-top:1px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.2));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-nm-text]{flex:1;min-width:0;word-break:break-all;}
[data-nm-msg]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-nm-msg][data-ok]{color:#22c55e;}
[data-nm-msg][data-warn]{color:#f59e0b;}
[data-nm-hint]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-nm-bar]{height:4px;border-radius:2px;background:#3b82f6;margin:3px 0 2px 0;opacity:.75;}
`

    function Panel() {
      const [stats, setStats] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [nodes, setNodes] = React.useState([])
      const [topNodes, setTopNodes] = React.useState([])
      const [sunkNodes, setSunkNodes] = React.useState([])
      const [recent, setRecent] = React.useState([])
      const [mode, setMode] = React.useState('chat')
      const [msg, setMsg] = React.useState('')

      const refresh = React.useCallback(async () => {
        try { setStats(await jget('/stats')) } catch (e) { setMsg('读状态失败：' + e.message) }
        try { setTopNodes((await jget('/top?n=10')).nodes || []) } catch (e) { /* 旧版没有这条路由，忽略 */ }
        try { setSunkNodes((await jget('/sunk')).nodes || []) } catch (e) { /* 同上 */ }
        try { setRecent((await jget('/recent')).items || []) } catch (e) { /* 同上 */ }
        try { setMode((await jget('/mode')).mode || 'chat') } catch (e) { /* 同上 */ }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const switchMode = async (m) => {
        try {
          const r = await jpost('/mode', { mode: m })
          setMode(r.mode || m)
          setMsg(m === 'work' ? '工作模式：recall 只回节点文本，省 token' : '聊天模式：recall 带原文和同日上下文')
        } catch (e) { setMsg('切模式失败：' + e.message) }
      }

      const doRecall = async () => {
        if (!q.trim()) return
        try {
          const r = await jget('/recall?q=' + encodeURIComponent(q.trim()))
          setNodes(r.nodes || [])
          setMsg(`点亮 ${r.count} 个节点`)
          refresh()
        } catch (e) { setMsg('激活失败：' + e.message) }
      }

      const doAction = async (path, label) => {
        try {
          const r = await jpost(path, {})   // 写操作走 POST（服务端只认 POST）
          setMsg(label + '：' + JSON.stringify(r).slice(0, 120))
          refresh()
        } catch (e) { setMsg(label + '失败：' + e.message) }
      }

      return h('div', { 'data-nm-page': true }, [
        h('div', { 'data-nm-card': true }, [
          h('div', { 'data-nm-title': true }, '神经元记忆'),
          h('div', { 'data-nm-sub': true }, stats ? `节点 ${stats.nodes} · 连接 ${stats.edges}` : '加载中…'),
          h('div', { 'data-nm-row': true }, [
            h('button', { 'data-nm-btn': true, 'data-primary': mode === 'chat', onClick: () => switchMode('chat') }, '聊天模式'),
            h('button', { 'data-nm-btn': true, 'data-primary': mode === 'work', onClick: () => switchMode('work') }, '工作模式'),
          ]),
          h('div', { 'data-nm-hint': true }, mode === 'chat'
            ? '聊天：recall 带原文和同一天前后（完整，但花 token）'
            : '工作：recall 只回节点文本（省 token，约 1/5）'),
          h('div', { 'data-nm-row': true }, [
            h('input', {
              'data-nm-input': true, value: q, placeholder: '输入两三个关键词，点亮相关记忆…',
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doRecall() },
            }),
            h('button', { 'data-nm-btn': true, 'data-primary': true, onClick: doRecall }, '点亮'),
          ]),
          nodes.length
            ? h('div', { 'data-nm-list': true }, nodes.map((n) => h('div', { 'data-nm-item': true, key: n.id }, [
              h('span', { 'data-nm-score': true }, Number(n.score).toFixed(2)),
              h('span', { 'data-nm-kind': true }, n.kind || ''),
              h('span', { 'data-nm-text': true }, n.text || ''),
            ])))
            : h('div', { 'data-nm-hint': true }, '输入关键词，看看它点亮哪些记忆。'),
          msg ? h('div', { 'data-nm-msg': true }, msg) : null,
        ]),
        topNodes.length
          ? h('div', { 'data-nm-card': true }, [
            h('div', { 'data-nm-title': true }, '最重的 10 条'),
            h('div', { 'data-nm-sub': true }, '权重 = 基础分 - 每天 0.1；被想起来就重新计分'),
            h('div', { 'data-nm-list': true }, topNodes.map((n) => h('div', { 'data-nm-item': true, key: 't' + n.id }, [
              h('div', { 'data-nm-row': true }, [
                h('span', { 'data-nm-kind': true }, n.kind || ''),
                h('span', { 'data-nm-score': true }, String(n.weight)),
              ]),
              h('div', { 'data-nm-bar': true, style: { width: Math.min(100, Math.max(4, (Number(n.weight) / 4) * 100)) + '%' } }),
              h('div', { 'data-nm-text': true }, n.text || ''),
            ]))),
          ])
          : null,
        sunkNodes.length
          ? h('div', { 'data-nm-card': true }, [
            h('div', { 'data-nm-title': true }, '沉底的 ' + sunkNodes.length + ' 条'),
            h('div', { 'data-nm-sub': true }, '权重低于 1.0 就沉下来；沉 ≠ 删，还在库里'),
            h('div', { 'data-nm-list': true }, sunkNodes.slice(0, 8).map((n) => h('div', { 'data-nm-item': true, key: 's' + n.id }, [
              h('span', { 'data-nm-kind': true }, n.kind || ''),
              h('span', { 'data-nm-text': true }, n.text || ''),
            ]))),
          ])
          : null,
        recent.length
          ? h('div', { 'data-nm-card': true }, [
            h('div', { 'data-nm-title': true }, '最近点亮'),
            h('div', { 'data-nm-sub': true }, '它刚才想起过什么事（只在内存里，重启就清空）'),
            h('div', { 'data-nm-list': true }, recent.slice(0, 12).map((r, i) => h('div', { 'data-nm-item': true, key: 'r' + i }, [
              h('span', { 'data-nm-score': true }, r.t || ''),
              h('span', { 'data-nm-kind': true }, String(r.count)),
              h('span', { 'data-nm-text': true }, r.q || ''),
            ]))),
          ])
          : null,
        h('div', { 'data-nm-card': true }, [
          h('div', { 'data-nm-title': true }, '维护'),
          h('div', { 'data-nm-row': true }, [
            h('button', { 'data-nm-btn': true, onClick: () => doAction('/replay', '回放') }, '回放今天'),
            h('button', { 'data-nm-btn': true, onClick: () => doAction('/tidy', '整理') }, '整理'),
            h('button', { 'data-nm-btn': true, onClick: () => doAction('/prune', '剪枝') }, '剪旧连接'),
            h('button', { 'data-nm-btn': true, onClick: refresh }, '刷新'),
          ]),
          h('div', { 'data-nm-hint': true }, '回放 = 把今天的记忆重新连一遍；整理 = 把最淡的沉底；剪枝 = 清理快忘光的旧连接。'),
        ]),
        h('div', { 'data-nm-hint': true }, 'v' + PANEL_BUILD + ' · 数据全在本地，不上传'),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-neuron-memory')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-neuron-memory: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'neuron-memory', order: 40, label: '神经元记忆' },
          () => h(Panel),
        ))
      },
    }
  },
})
