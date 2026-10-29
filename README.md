# dsh-neuron-memory

**本地记忆抽屉**：字面命中 + 情绪桶 + 同日上下文 + 指数衰减。

给 DeepSeek Harness（cordis 插件）用。数据是一个本地 SQLite 文件，不联网、不上传、你能打开、能改、能删。

图记忆（激活扩散）已否决——实测 1 跳噪音 33% → 64%，增量 0%。见 [FINDINGS.md](FINDINGS.md)。

## Status：v0.2.0

这一版的定位是「修好 bug、说真话、装得上」，外加一件原计划留到 0.3.0 的事：**换会话之后，她还是同一个人。**

- **修了三个 bug**：`grams()` 用 `\W` 会吞掉所有中文（「共享词建边」从上线起就没工作过）；`/mode` 空 body 会静默切模式；HTTP 写操作原本是 GET（任意网页能触发）
- **承认两件事**：排序以前其实是按重要度、不是按相关度（现在 `rel` 进了 score）；文档里三条功能之前并不存在
- **新增**：开场认人 `neuron_opening`、收尾交接 `neuron_handoff`、工作状态 `decided_at` / `supersedes`、自动录入
- **图仍然是关的**：`hops=0`，扩散实测纯亏损

### breaking changes

1. **权重从线性衰减改成指数衰减**（`base × 0.5^(天/半衰期)`）——所有分数尺度变了，`sinkBelow` 从 1.0 调到 0.5。
2. **默认行为变了**：排序 = 相关度 × 权重（`warmBoost` 再加一点温度）；零命中**默认返回空**（`noFallback: true`），不再拿 `top()` 充数。
3. **HTTP 写操作从 GET 改成 POST**（`/tidy` `/prune` `/replay` `/handoff`）——旧面板会收到 405，需同步升级 `client.js`。
4. **工具默认只暴露 7 个**：`sync / raw / consume / replay / prune` 收进 `config.advanced: true` 后面。

### 迁移

首次启动会把旧库自动复制成 `neuron.db.bak-v<旧版本>`，然后按 `user_version` 逐级迁移（**当前 schema v4**）。迁移幂等，连开两次不会重复改。

## 它现在真的在做什么

坦白说：**bm25 种子（IDF 加权）+ 情绪桶 + 同日窗口 + 指数衰减**。没有向量，也没有图。

- **种子**：FTS5 倒排（unicode61 + 预切 2-gram）捞候选；`rel = Σidf(命中)/Σidf(全部)`，整词命中直接视为 1；`rel ≥ minRel(0.30)` 才算数
- **排序**：`score = rel × 权重/3 × 温度系数`；权重 = `基础分 × 0.5^(天/半衰期)`，恒正、永不归零
- **温度桶**：感受 / 原话 / 偏好 / 回味 3.0，教训 2.5，事件 1.6，档案 1.3；聊天时感受先亮
- **同日上下文**：想起一件事，顺手带出那天前后各一条（只给最前两条）
- **复习只回血一半**：被想起来时把「已流逝天数」折半，不是重置到现在（防口头禅记忆）
- **沉底不删**：低于 0.5 沉进归档区，不参与普通召回；你精确问起（命中 ≥2 词）仍会被翻出来
- **场景隔离**：`scope` 默认 `private`；`work` 不衰减、不沉底；群聊召回不到私聊

## 换会话，她还是同一个人

两个工具，把「会话」这个概念挡在插件外面——插件只负责存和交：

```
会话开始  → neuron_opening()            返回一段 ≤250 字，直接塞进 system prompt
会话结束  → neuron_handoff({topic, phase, nextAsk, mood, name})   只写三行 + 一个情绪数
```

`neuron_opening()` 的输出长这样：

```
你正在和周舟说话。
今天还见过面（有点闷）。
你们正聊到：换工作，卡在钱不够。
你上次想问她：面试结果出来没。
你记得：她说周三要交材料；她讨厌豆包腔。
开场先认出她——用对的称呼、接上上次的话题。不要重新自我介绍，不确定的事就问，不要编。
```

工作会话传 `includeWork: true`，会追加一段「项目状态（按拍板时间）」；**两个块互斥，不叠加**。

## 工作状态：要「最新」，不要「最像」

向量检索分不清「哪个方案是现在的」。所以工作记忆用两列解决：

```js
neuron_learn("走方案 B，A 的迁移成本太高", "fact", "work", { supersedes: 12 })
// → 12 号那条自动 status='sunk'，不再被当成「现在的」
```

- `decided_at`：什么时候拍板的（`scope=work` 时默认写入时间）
- `supersedes`：覆盖了哪条旧决定；**跨 scope 或 id 不存在时只警告，不静默沉**

## 装

要求：Node ≥ 22.15（`node:sqlite` + zstd）、DSH ≥ 0.1.7

```bash
node install.mjs                 # 复制进 profile、登记 bundle、跑自检
dsh plugin add link:<本目录>     # 或者走官方命令
node test-all.mjs                # 四层测试
```

装完重启一次 DSH，工具和设置页就出现了。首次运行自动建空库；想接已有记忆库，在 profile 的 `cordis.patch.yml` 里配：

```yaml
- id: dsh-neuron-memory
  name: dsh-neuron-memory
  config:
    db: /path/to/neuron.db
    source_db: /path/to/memory.db   # 可选：原文库（一张 memories(id,text) 表即可）
    halfLifeDays: 10
    sinkBelow: 0.5
    sinkLimit: 3
    hops: 0                   # 默认 0 = 图未启用
    minRel: 0.30
    noFallback: true
    advanced: false           # true 才放出 sync/raw/consume/replay/prune
    autoSync: true            # 自动录入会话（见下，含代价说明）
```

## 工具（默认 7 个）

| 工具 | 作用 |
|---|---|
| `neuron_opening(scope?, includeWork?)` | 会话开场：认人 + 上次聊到哪 + 下次问什么（≤250 字） |
| `neuron_handoff(topic, phase, nextAsk, mood, name?)` | 会话交接：只写三行 + 情绪数 |
| `neuron_recall(query, limit?, mode?, scope?)` | 相关性召回；`mode=lite` 只回文本，省约一半字符 |
| `neuron_learn(text, kind?, scope?, supersedes?)` | 学一条；`supersedes` 会沉掉被覆盖的旧决定 |
| `neuron_stats()` | 节点 / 连接 / 待沉 / 已沉 / 最老沉底日期 |
| `neuron_story(day?)` | 按天串叙事线 |
| `neuron_tidy()` | 沉掉最淡的几条（沉 ≠ 删） |

`advanced: true` 时额外放出：`neuron_sync`（扫会话抓原文）、`neuron_raw`（读待提炼）、`neuron_consume`（标记已提炼）、`neuron_replay`、`neuron_prune`。

## 自动录入（0.2.0 新增）

插件每 10 分钟扫一次 DSH 的会话记录（`~/.dsh/sessions/` 下最近 2 天的文件，多帧 zstd），把**用户消息**抓进本地 `raw_log` 表。

**只抓，不判断、不写记忆。** 哪句值得记仍由模型决定——插件不知道「好的」和「我明天要去面试」的区别。

- `raw_log` 带 `scope` 列，群聊/私聊的原文不混池
- 用 sha1(文本+时间) 去重，同一条不会重复入库
- 提炼完后用 `neuron_consume` 标记，不重复处理
- 关掉：`config.autoSync: false`；周期可调：`config.autoSyncMinutes`（默认 10）

⚠️ 数据全在本机 `neuron.db` 里，不上传。但**它会读你本地所有会话文件**——这是这个功能的代价，关掉就是纯手动。

## 评测：三条腿 + 诱捕题

18 题（作者自拟、样本小，只能看方向），预算 = neuron 腿实际用掉的字符数：

| 腿 | 命中 | 条目 | 噪音率 | 字符 | 每千字符命中 |
|---|---|---|---|---|---|
| neuron（种子 + 同日上下文，0 跳） | 100% | 70 | 33% | 6137 | 2.93 |
| bm25（同样 2-gram + IDF） | 94% | 66 | 26% | 5478 | 3.10 |
| weight（完全不检索） | 22% | 90 | 96% | 4389 | 0.91 |

归因：neuron 比 bm25 多的那 6 个点里，**0 个来自扩散**——唯一差距是空查询走了 `top()` 兜底，而 bm25 那条腿没实现兜底。所以「图更准」不成立。

**诱捕测试**（`eval/traps.json`，20 题 5 类）：问「没发生过的事」，看它会不会顺着编。脚本只能查「库里有没有支撑」这一半；模型会不会编，要人判——所以这里不报通过率。

## 文档

- [FEATURES.md](FEATURES.md)：功能详单（写的是代码里实际在跑的；未实现的会明确标注）
- [ARCHITECTURE.md](ARCHITECTURE.md)：数据模型、读写路径、设计权衡、已知坑
- [FINDINGS.md](FINDINGS.md)：三条腿评测、跳数实验、归因方法、为什么砍图
- `eval/`：实验脚本（仓库里是脱敏 fixtures，真实题放本地 `fixtures.local.json`）

## Roadmap

- [x] 种子换成 IDF 加权（2-gram 预切 + FTS5 unicode61）——0.2.0 已做
- [x] 1 跳实验：命中不变、噪音 33% → 64%，增量 0 —— 图退出主路径
- [ ] 「+0.5 合并」（惊讶门控写入）：先在 `write_log` 里记一周 jaccard 分布，再定阈值
- [ ] `digest`：每天的碎记忆压成 3~5 行摘要，原条目折进去（复用 `sunk`）
- [ ] 冷启动误命中（2-gram 拆太碎）单独处理
- [ ] `stats` 加窗口：最近 7 天被点亮次数

## 许可

MIT。详见 [LICENSE](LICENSE)。

本项目为第三方插件，与深度求索（DeepSeek）官方无关，未获其背书。
请不要用它储存别人的隐私；群聊场景必须开启 `scope` 隔离。
