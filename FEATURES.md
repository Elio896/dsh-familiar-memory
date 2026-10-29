# FEATURES · 功能详单

这份写的是**代码里实际在跑的东西**，不是设想。每条都标了入口（工具 / HTTP / 面板）。

---

## 一、记忆怎么存

### 1. 学一条记忆（`neuron_learn` / `POST /learn`）

- 参数：`text`（一句话）、`kind`（可选）
- 自动做两件事：入库 → 算基础分（`hops=0` 时不建边）
- `kind` 七种：`fact` `event` `lesson` `feeling` `quote` `preference` `self`

### 2. 基础分（写死，可按标签微调）

| kind / 标签 | 基础分 | 例子 |
|---|---|---|
| 约定 / 承诺 / 情绪 / 身份 / 边界 / feeling / quote / preference / self | 3.0 | “她讨厌豆包腔” |
| 偏好 / 作息 / 规矩 / 教训 | 2.5 | “摔过的跟头” |
| 梗 / 表情 / event | 1.6 | “那天发生了什么” |
| 其余 | 1.3 | 档案：“QQ 号是多少” |

### 3. 自动连边

- 与已有记忆比较 2-gram 重叠：≥5 个 → 权重 0.3~0.6（`共享N词`）
- 命中强主题词（显卡/抖音/记忆/语音…）→ 0.4（`主题:x`）
- 只命中泛词（妈妈/阿姨/QQ…）→ 0.15（`弱主题:x`，只做种子不扩散）
- 连边的意义现在只剩“沉底后还能被带出来”，主路径已不用（见 `hops=0`）

### 4. 同一件事再被提到：+0.5 —— **未实现，0.3.0 再做**

> ⚠️ 0.2.0 的 `learn` 只有 INSERT，没有相似度检测、没有 +0.5、没有合并。
> 这条是**设计意图**，不是现状。写在说明书里但没写进代码，是我上一版的错，这行专门留着提醒。

---

## 二、记忆怎么取

### 5. 两种模式（面板按钮 / `POST /mode`）

| 模式 | recall 返回 | 字符量（实测） |
|---|---|---|
| 聊天（默认） | 节点 + 分数 + 原文 + 同日上下文 | 约 6300/18 题 |
| 工作 | 只回 `id/kind/text(前 60 字)` | 约 1/5 |

模式写进 `$DSH_HOME/neuron-memory/config.json`，重启保留。

### 6. 关键词拆词

- 整词保留
- 中文再拆成 2-gram（“妈妈辛苦” → 妈妈 / 妈辛 / 辛苦）
- 英文按整词（`code`、`whisper`）

### 7. 种子（`neuron_recall` / `GET /recall`）

- `text LIKE` 任意拆出来的词
- 活跃记忆参与排序，取前 5
- **沉底记忆只有「精确命中 ≥2 个查询词」时才允许当种子**——你明确问起，它才去翻旧箱子
- 命中词数多的优先，其次基础分
- 空查询 → 不走检索，直接按权重取前几条（兜底，不空手）
- 有词但零命中 → 也走兜底，返回带 `fallback: true` 标记，明说“不是相关结果”

### 8. 召回排序

```
score = 强度 × 权重 / 3
权重 = 基础分 − 0.1 × 天数（被想起来 / 再提到会刷新）
沉底节点：权重冻结在 1.5，分数 ×0.4（只在被精确问起时出现）
score < 0.15 丢弃
```

### 9. 原文回查（只对导入了原文库的老库有效）

节点带 `source_id`，指向原文库（默认同目录 `memory.db` 的 `memories` 表）。点亮时取原话；和节点文本相同则不重复带。

> ⚠️ 新库自己 `learn` 的节点 `source_id` 为空，所以这条对**从零开始用**的库永远不触发——它只在接入了老原文库时有用。

### 10. 同日上下文

返回结果里最前两条，各带「同一天前后各一条」。想起一件事，把那天前后也带出来。

### 11. 复习（写库只有这一步）

- 扩散阶段纯读
- 只刷新**真正返回**的节点，以及它回种子的路径上的边
- 精确命中（≥2 个查询词）的种子另算一次弱复习，防止在榜外一路滑死
- 整个刷新包在一个事务里

---

## 三、记忆怎么管

| 功能 | 工具 | HTTP | 做什么 |
|---|---|---|---|
| 回放 | `neuron_replay` | `GET /replay` | 当天节点按更松阈值重新连边 |
| 整理 | `neuron_tidy` | `GET /tidy` | 权重 < 1.0 的活跃节点，最淡的最多 3 条 → `status='sunk'` |
| 剪枝 | `neuron_prune` | `GET /prune` | 边 `weight × decay < 0.05` → 物理删除 |
| 按天串线 | `neuron_story` | `GET /story` | 列出某天所有节点（含沉底） |

沉 ≠ 删：`sunk` 不参与普通召回，但查询精确命中 ≥2 个词时仍会当种子被翻出来（有测试锁住“沉底 90 天后被精确问起仍能翻出”）。

---

## 四、看得见

面板（设置页 →「神经元记忆」），六块：

1. **聊天 / 工作模式**：两个按钮，切换 recall 的返回形态
2. **查库**：输入关键词点「点亮」，看这次召回结果（分数 + 类型 + 文本）
3. **最近点亮**：内存里留 20 条，每次 recall 的查询词、命中数、时间（重启清空）
4. **最重的 10 条**：权重条 + 类型 + 文本
5. **沉底的 N 条**：`tidy` 沉下去的，证明“沉 ≠ 删”
6. **维护**：回放 / 整理 / 剪枝 / 刷新

状态字段（`stats`）：`nodes`、`edges`、`backlog`（跌破沉底线但限速没沉）、`sunk`、`oldestSunk`。

---

## 五、可配置项

优先级：环境变量 > 插件 config（`cordis.patch.yml`）> `config.json` > 默认。

| 键 | 默认 | 作用 |
|---|---|---|
| `db` | `$DSH_HOME/neuron-memory/neuron.db` | 主库 |
| `source_db` | 主库同目录 `memory.db` | 原文库（可选） |
| `mode` | `chat` | `chat` / `work` |
| `halfLifeDays` | 10 | 边半衰期 |
| `weightDecayPerDay` | 0.1 | 节点权重每天掉多少 |
| `sinkBelow` | 1.0 | 低于它沉底 |
| `sinkLimit` | 3 | 一次最多沉几条 |
| `hops` | **0** | 扩散跳数；0 = 只用种子。实测调回 1/2 只会多噪音 |

环境变量：`NEURON_DB`、`NEURON_SOURCE_DB`、`NEURON_MODE`。

---

## 六、工具清单（7 个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `neuron_recall` | `query`、`limit?`、`mode?` | `{ok, mode, count, nodes[]}` |
| `neuron_learn` | `text`、`kind?` | `{ok, id, edges}` |
| `neuron_stats` | — | `{ok, nodes, edges, backlog, sunk, oldestSunk}` |
| `neuron_story` | `day?` | `{ok, items[]}` |
| `neuron_replay` | `day?` | `{ok, nodes, edges}` |
| `neuron_tidy` | — | `{ok, sunk, left}` |
| `neuron_prune` | — | `{ok, pruned}` |

## 七、HTTP（面板走这些）

```
GET  /api/neuron-memory/stats | top?n= | sunk | recent | mode | recall?q=&limit= | story?day= | replay?day= | tidy | prune
POST /api/neuron-memory/learn  {text, kind?}
POST /api/neuron-memory/mode   {mode: 'chat' | 'work'}
```

全部包 try/catch，异常一律 `{ok:false, error}`。

---

## 八、它不做什么

- 不自动触发：用户发消息时它不会自己出来查，得模型主动调
- 不语义检索：中文只做 2-gram，同义不同字会漏
- 不主动写：记什么、什么时候记，还是模型（或人）的判断
- 不压缩：试过自动合并，拼出来是清单不是摘要，回滚了（见 FINDINGS）
- 不碰网络：全本地 SQLite
