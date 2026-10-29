## 0.2.0 — 修好三个 bug，承认两件事

修：
- `grams()` 用 `\W` 会吞掉所有中文 → 「共享词建边」从上线起就没工作过
- `/mode` 空 body 会静默切模式
- HTTP 写操作（tidy/prune/replay）原本是 GET，任意网页可触发 → 改 POST + Origin 校验 + body 上限

承认：
- 排序其实一直是按重要度，不是按相关度（现在 rel 进了 score）
- **「+0.5 合并」「digest」「原文回查」三条功能之前就没实现。这次一条都没补——0.3.0 再做。**
  上一版 CHANGELOG 写成「补了 +0.5 合并」，是错的，这里更正。

改：
- 权重改指数衰减（base × 0.5^(天/半衰期)），sinkBelow 1.0 → 0.5
- 复习只回血一半（防「口头禅记忆」）。5 天前的节点被想起一次后剩约 2.5 天
- **breaking：`noFallback` 升为默认 `true`** —— 零命中返回空，不再拿 top() 充数
- **breaking：`minRel = 0.30`** —— 相关性低于门限的记忆不再注入
- scope 场景隔离，默认 private（群聊召回不到私聊）
- schema 迁移框架（user_version + 迁移前自动备份 .bak-vN），幂等
- lite 模式不截断文本，只减条数，并带 compact: true
- 索引 idx_nodes_ts / idx_nodes_scope；top() 排序挪进 SQL

加（原本打算留到 0.3.0，后来决定并入 0.2.0）：
- **开场认人** `neuron_opening`：≤250 字，含称呼 / 上次心情 / 聊到哪 / 下次问什么 / 记得什么；`includeWork` 才追加「项目状态」
- **收尾交接** `neuron_handoff`：只写三行（话题 / 卡在哪 / 下次问什么）+ 情绪数，暗号「收工」，每天 23:00 提醒
- **工作状态**：`decided_at`（什么时候拍板）+ `supersedes`（覆盖了哪条）——新决定写入时旧的自动沉底，防止把旧方案当成现在的
- **工作 / 闲聊分家**：`scope='work'` 不衰减、不沉底、必须精确；`scope='private'` 正常衰减
- **自动录入**：每 10 分钟扫 `~/.dsh/sessions`（最近 2 天、多帧 zstd），只抓用户消息进本地 `raw_log`，**不自动写记忆**（提炼仍由模型做）；`config.autoSync=false` 可关，`autoSyncMinutes` 调周期。代价：它会读你本地所有会话文件。
- 迁移 v4：decided_at / supersedes 两列

迁移：首次启动自动把旧库复制成 `neuron.db.bak-v<旧版本>`，按 user_version 逐级迁移（当前 v4）。
已知问题：
- 图记忆仍默认关闭（`hops=0`），0.3.0 前不会改
- 诱捕测试目前只能做「库里有 / 没有支撑」这一半，模型会不会顺着编需要人判
