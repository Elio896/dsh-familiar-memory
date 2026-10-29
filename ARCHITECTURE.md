# 开发者文档 · dsh-neuron-memory

面向想改代码、想接自己记忆库、或者想看懂它为什么这么写的人。

---

## 1. 它是什么

一个 DeepSeek Harness（cordis）插件：给 AI 提供「图记忆 + 激活扩散」的召回层。

不依赖任何外部服务，数据是一个 SQLite 文件（`node:sqlite`，Node ≥22.5 内置）。

## 2. 目录与职责

```
index.js            cordis 插件入口：注册 7 个工具 + HTTP 路由 + 配置解析
lib/neuron.mjs      核心：NeuronStore（SQLite、图、激活、权重、整理）
client.js           设置页面板（window.__ModuleLoader__ 注入，走 /api/neuron-memory/*）
cordis.patch.yml    bundle 挂载声明（id/name 必须等于包名）
test-core.mjs       核心逻辑单测（临时库）
test-plugin.mjs     插件契约测试（假 ctx + 临时 DSH_HOME）
test-install.mjs    安装前静态自检
test-host.mjs       从 profile/node_modules 真实 import 的加载模拟
check-host.mjs      重启前只读自检（profile 配置/YAML/id 唯一性）
install.mjs         一条命令安装（复制、登记、自检）
```

## 3. 数据模型

```sql
nodes(
  id INTEGER PRIMARY KEY,
  kind TEXT,            -- fact / event / lesson / feeling / quote / preference / self
  text TEXT,            -- 压缩过的一句话
  ts TEXT,              -- 创建时间 YYYY-MM-DDTHH:MM
  importance REAL,      -- 基础分（3.0 / 2.5 / 1.6 / 1.3）
  last_active TEXT,     -- 最后一次被想起来 / 被学的时间（决定当前权重）
  tags TEXT,            -- 可选标签，参与基础分判断
  status TEXT,          -- 'active' | 'sunk'（沉底，不删）
  source_id INTEGER     -- 原文库 memories.id，可为空
)

edges(
  id INTEGER PRIMARY KEY,
  a INTEGER, b INTEGER, -- 两端节点 id（a < b）
  weight REAL,          -- 0.15（弱主题）/ 0.4（强主题）/ 0.3~0.6（共享词）
  rel TEXT,             -- '共享N词' / '主题:x' / '弱主题:x'
  last_active TEXT,     -- 这条连接最后一次被走过
  UNIQUE(a,b)
)
```

没有外键、没有 FTS 依赖（`nodes_fts` 是 Python 版遗留，Node 版不用）。

## 4. 写入路径（learn）

1. 计算基础分：`baseWeight(kind, tags)` —— 约定/情绪/身份/边界 3.0；偏好/作息/教训 2.5；梗/事件 1.6；其余 1.3。
2. 插入节点，`status='active'`，`last_active=now`。
3. 连边（`_syncEdges`）：与每条已有节点比 2-gram 共享数：
   - 共享 ≥ 阈值（learn 是 5，replay 是 3）→ `0.3 + 0.03×min(shared,10)`
   - 命中强主题词（显卡/抖音/记忆…）→ 0.4
   - 只命中弱主题词（妈妈/阿姨/QQ…）→ 0.15
4. 逐条插入 `edges`，`UNIQUE(a,b)` 去重。

## 5. 读取路径（recall）

```
query
  → termsOf(): 整词 + 中文 2-gram + 英文整词
  → 每个查询词算 IDF：df 从 nodes_vec 查，idf = ln(1 + N/df)
  → 种子：FTS5 倒排（unicode61 + 预切 2-gram）用 bm25 捞候选 50 条；FTS 不可用退回 LIKE
       rel = Σidf(命中的词) / Σidf(全部词)；整词命中直接 rel = 1
       rel >= minRel(0.30) 才当种子；活跃记忆取前 5，沉底记忆要精确命中 ≥2 词才进
  → 扩散 hops 跳（**默认 0，图未启用**；实验显示 1 跳只会把噪音从 33% 拉到 64%）：
       每条边 ew = weight × decay(last_active, halfLifeDays)
       ew < 0.05 不扩；rel 以「弱主题」开头不扩（防止泛词把整库拖出来）
       强度 = 父强度 × ew（max 传播，不累加）
  → 排序：score = rel × 权重/3 × 温度系数 × 沉底折扣
       权重 = importance × 0.5^(天数/半衰期)     ← 指数衰减，恒正
       沉底节点：权重地板 1.5，分数 ×0.4
  → 复习：只刷「真正返回」的节点 + 它回种子的路径；last_active 只回血一半（不是重置到 now）
  → 前 limit 条，附带：
       source   —— 回查 source_db 的原文（与节点文本相同则不带；只对导入了原文库的老库有用）
       context  —— 同一天前后各一条（只给前 2 条）
```

空查询走 `top(limit)`：按权重降序取活跃记忆，不空手。

## 6. 维护路径

| 操作 | 做什么 | 安全吗 |
|---|---|---|
| `tidy` | 权重 < sinkBelow 的活跃节点，按最淡取前 sinkLimit 条，`status='sunk'` | 沉 ≠ 删 |
| `prune` | 边 `weight × decay < 0.05` 的物理删除 | 只删连接 |
| `replay(day)` | 当天节点用阈值 3 重新连边 | 只加边 |
| `story(day)` | 按时间列出当天节点 | 只读 |

## 7. 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `neuron_recall` | `query`、`limit?`、`mode?`（lite/full） | `{ok, mode, count, nodes[]}` |
| `neuron_learn` | `text`、`kind?` | `{ok, id, edges}` |
| `neuron_stats` | — | `{ok, nodes, edges}` |
| `neuron_story` | `day?` | `{ok, items[]}` |
| `neuron_replay` | `day?` | `{ok, nodes, edges}` |
| `neuron_tidy` | — | `{ok, sunk, left}` |
| `neuron_prune` | — | `{ok, pruned}` |

`mode=lite` 只回 `{id, kind, text(前60字)}`，默认 3 条；`full` 带分数、原文、同日上下文，默认 6 条。

## 8. HTTP 路由（面板用）

前缀 `/api/neuron-memory`：

```
GET  /stats   /top?n=  /sunk   /recall?q=&limit=   /story?day=   /replay?day=   /tidy   /prune
POST /learn   {text, kind?}
```

全部包在 try/catch 里，异常一律 `{ok:false, error}`，不会把 500 抛给宿主。

## 9. 配置

优先级：环境变量 `NEURON_DB` / `NEURON_SOURCE_DB` > 插件 config > `$DSH_HOME/neuron-memory/config.json` > 默认。

```yaml
config:
  db: /path/to/neuron.db
  source_db: /path/to/memory.db
  halfLifeDays: 10          # 半衰期（节点和边共用同一条指数曲线）
  weightDecayPerDay: 0.1    # 保留字段（指数衰减后不再使用）
  sinkBelow: 0.5            # 低于它沉底（指数衰减下从 1.0 调到 0.5）
  sinkLimit: 3              # 一次最多沉几条
  hops: 0                   # 扩散跳数（默认 0 = 图未启用）
  minRel: 0.30              # 相关性门限
  noFallback: true          # 零命中返回空，不拿 top() 充数
  warmBoost: 1.15           # 温度桶在排序里的加权
```

## 10. 设计权衡（为什么不做别的）

| 选择 | 为什么 | 代价 |
|---|---|---|
| 不上向量库 | 记忆 <100 条时全量注入更准；embedding 要外部服务或模型 | 语义相近但用词不同的记忆点不亮 |
| 中文 2-gram | 零依赖、不用分词器 | 同义不同字就漏；长文本噪声多 |
| 沉底不删 | 沉掉的细节以后还想得起来 | 库会缓慢变大 |
| 两套实现（Node + Python） | Python 版是我本地日常用的，Node 版是插件交付物 | 会分叉，靠测试对齐 |
| 插件主动 recall | 宿主没有「消息进来改上下文」的钩子 | 模型得自己记得调 |

## 11. 测试

```bash
node test-all.mjs     # 前三层：核心 / 契约 / 安装自检
node test-host.mjs    # 从 profile 真实加载（需要已安装）
node check-host.mjs   # 重启前只读检查（需要已安装）
```

四层都过才建议重启；`boot.log`（`$DSH_HOME/neuron-memory/boot.log`）记录每次加载的脚印。

## 12. 已知坑

- `parameters` 不是标准 JSON Schema，是 dsh-tools 的 per-property 格式：`{ query: { type: 'string', required: true } }`。写错会在 defineTool 阶段抛 `JsonSchemaError`。
- 装本地目录必须**复制**进 `node_modules`，跨盘 junction 宿主解析不到。
- `cordis.patch.yml` 的 `id` 要等于包名 / export name，否则不激活。
- PowerShell 的 `Set-Content -Encoding UTF8` 会加 BOM，别用来改 JSON。
