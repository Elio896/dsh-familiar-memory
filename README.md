# dsh-neuron-memory

**本地记忆抽屉**：字面命中 + 情绪桶 + 同日上下文 + 指数衰减。

给 DeepSeek Harness（cordis 插件）用。数据是一个本地 SQLite 文件，不联网、不上传。

图记忆（激活扩散）已否决——实测 1 跳噪音 33% → 64%，增量 0%。见 [FINDINGS.md](FINDINGS.md)。

## Status：v0.2.0

这一版的定位是「修好 bug、说真话、装得上」，不是加功能：

- **修了三个 bug**：`grams()` 用 `\W` 会吞掉所有中文（「共享词建边」从上线起就没工作过）；`/mode` 空 body 会静默切模式；HTTP 写操作原本是 GET（任意网页能触发）
- **承认两件事**：排序以前其实是按重要度、不是按相关度（现在 `rel` 进了 score）；文档里三条功能之前并不存在
- **图仍然是关的**：`hops=0`，扩散实测纯亏损
- **场景隔离**：`scope` 默认 `private`，群聊召回不到私聊

### 0.2.0 的 breaking changes

1. **权重从线性衰减改成指数衰减**（`base × 0.5^(天/半衰期)`）——所有分数尺度变了，`sinkBelow` 从 1.0 调到 0.5。
2. **默认行为变了**：排序 = 相关度 × 权重；零命中仍给兜底但带 `fallback` 标记。
3. **HTTP 写操作从 GET 改成 POST**（`/tidy` `/prune` `/replay`）——旧面板会收到 405，需要同步升级 `client.js`。

### 迁移

首次启动会把旧库自动复制成 `neuron.db.bak-v<旧版本>`，然后按 `user_version` 逐级迁移（当前 schema v4）。迁移是幂等的，连开两次不会重复改。

## 三条腿，同一个字符预算

每题允许的预算是「neuron 腿实际用掉的字符数」，另两条腿截到同一个预算。18 题，fixtures 由作者自拟、样本小，数字只能看方向，不能当 benchmark。

| 腿 | 命中 | 条目 | 噪音率 | 字符 | 每千字符命中 |
|---|---|---|---|---|---|
| neuron（种子 + 同日上下文，默认 0 跳） | 100% | 70 | 33% | 6137 | 2.93 |
| bm25（同样 2-gram + IDF） | 94% | 66 | 26% | 5478 | 3.10 |
| weight（完全不检索） | 22% | 90 | 96% | 4389 | 0.91 |

> 扩散从 2 跳降到 0 跳之后：命中率不变，噪音 65% → 33%，字符 10303 → 6137。图在主路径上已经关掉了，只剩种子命中和同一天上下文。

归因（`eval/attribute.mjs`）：neuron 比 bm25 多出来的那 6 个点里，**0 个来自扩散**——唯一的差距是空查询走了 `top()` 兜底，而 bm25 那条腿没实现兜底。所以「图更准」不成立。

## 它现在真的在做什么

- **温度桶**：感受 / 原话 / 偏好 / 回味基础分 3.0，教训 2.5，事件 1.6，档案 1.3；聊天时感受先亮，档案排后面。
- **原文回查**：节点存的是压缩句，点亮时回原文库取原话（和节点文本重复就不带）。
- **同日上下文**：想起一件事，顺手把那天前后各一件带出来（只给最前两条）。
- **每日衰减**：权重 = 基础分 − 0.1 × 天数；被想起来（或同一件事再被提到）就重新计分。
- **沉底不删**：低于 1.0 沉进归档区，不参与普通召回；但你精确问起（命中 ≥2 个词）时仍会被翻出来（有测试锁住）。
- **复习只算被采用的**：扩散阶段纯读，只有真正返回的节点、以及它回种子的路径上的边会被刷新。

## 装

```bash
node install.mjs                 # 复制进 profile、登记 bundle、跑自检
dsh plugin add link:<本目录>     # 或者走官方命令
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
```

## 工具

| 工具 | 作用 |
|---|---|
| `neuron_recall(query, limit?, mode?, scope?)` | 相关性召回；`mode=full` 带原文与同日上下文，`mode=lite` 只回文本（省约 80% 字符） |
| `neuron_learn(text, kind?, scope?)` | 学一条 |
| `neuron_stats()` | 节点 / 连接 / 待沉 / 已沉 / 最老沉底日期 |
| `neuron_story(day?)` | 按天串叙事线 |
| `neuron_replay(day?)` | 回放当天、重新连边 |
| `neuron_tidy()` | 沉掉最淡的几条（沉 ≠ 删） |
| `neuron_prune()` | 剪掉快忘光的旧连接 |

## 自动录入（0.2.0 新增）

插件每 10 分钟扫一次 DSH 的会话记录（`~/.dsh/sessions/` 下最近 2 天的文件，多帧 zstd），把**用户消息**抓进本地 `raw_log` 表。

**只抓，不判断、不写记忆。** 哪句值得记仍由模型决定——插件不知道「好的」和「我明天要去面试」的区别。

- `raw_log` 带 `scope` 列，群聊/私聊的原文不混池
- 提炼完后用 `neuron_consume` 标记，不重复处理
- 关掉：`config.autoSync: false`
- 周期可调：`config.autoSyncMinutes`（默认 10）

⚠️ 数据全在本机 `neuron.db` 里，不上传。但**它会读你本地所有会话文件**——这是这个功能的代价，关掉就是纯手动。

## 文档

- [FEATURES.md](FEATURES.md)：功能详单（每条都标了入口，写的是代码里实际在跑的）
- [ARCHITECTURE.md](ARCHITECTURE.md)：数据模型、读写路径、设计权衡、已知坑
- [FINDINGS.md](FINDINGS.md)：三条腿评测、跳数实验、归因方法、为什么砍图
- `eval/`：可复现的实验脚本（仓库里是脱敏 fixtures，真实题放本地 `fixtures.local.json`）

## Roadmap

- [ ] 种子换成 IDF 加权（2-gram 预切 + FTS5 unicode61）
- [ ] 只留 `temporal` 边（同一天相邻）做 1 跳实验，增量低于 50% 就把图降为可选
- [ ] 冷启动误命中（2-gram 拆太碎）单独处理
- [ ] `stats` 加窗口：最近 7 天被点亮次数

## 许可

MIT。详见 [LICENSE](LICENSE)。
