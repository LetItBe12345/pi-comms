# 阶段 18：Proactive Agent Participation

状态：未开始

产品规则见 [Specification 第 19 节](../../SPECIFICATION.md#19-proactive-agent-participation)。完整设计选择及原因见 [阶段 18 决策记录](../decision/18-proactive-agent-participation.md)。本文件只保留实施步骤、测试和完成条件。

## 1. 文档同步

- [x] 将最终产品规则、协议行为和验收要求写入 `SPECIFICATION.md`。
- [x] 将 141 条已确认决定写入 Decision 文件。
- [x] 删除旧 TODO 中与最终决定冲突或重复的方案。

## 2. Broker 配置与 Provider 接口

- [ ] 增加 Broker 机器级配置模块，固定配置路径为 `~/.pi/comms/config.json`。
- [ ] 配置写入使用同目录临时文件和原子替换；macOS/Linux 权限设为 `0600`。
- [ ] 配置保存 Key 状态和递增版本。状态包含：`ready`、`unconfigured`、`unverified`、`invalid_key`、`temporarily_unavailable`、`config_error`。
- [ ] 日志、错误、协议消息和 Snapshot 不得包含完整 Key。设置页只显示 `****abcd` 形式的遮罩值。
- [ ] 增加仅 Broker 本机可见的设置入口：配置或更换、重新验证、删除、配置损坏时重建。
- [ ] 首次建群按以下顺序执行：用户名称 → Agent 名称 → Agent Description → 群组名称 → 加入方式 → 检查或配置 Broker Key → 创建群组。Key 可以跳过，失败或取消不能留下半创建群组。
- [ ] `DEEPSEEK_API_KEY` 只作为配置文件没有 Key 时的首次迁移来源，并要求本机用户确认后再验证和保存。
- [ ] 定义 `ProactiveProvider` 接口和 `FakeProactiveRouter`。Router 与 Freshness 共用 Provider，但使用独立 Prompt 和返回类型。
- [ ] DeepSeek Provider 固定使用 `https://api.deepseek.com` 和 `deepseek-v4-flash`，不得复用 Pi Session 的模型、Key 或配置。
- [ ] Key 验证实际发送一次最小模型请求，同时验证 Key、账户状态和模型权限。
- [ ] 更换 Key 使用两阶段写入：新值验证成功后才替换旧值。首次配置遇到网络错误可以保存为未验证；已有有效 Key 时不得被未验证的新值覆盖。
- [ ] 删除 Key 时取消在途 Router/Freshness HTTP 请求。请求返回时校验配置版本，旧版本结果一律丢弃。
- [ ] `401/403` 将 Key 持久化标记为无效；网络、超时、`429` 和 `5xx` 不改变 Key 状态。
- [ ] 未验证 Key 在 Broker 启动时自动验证一次。自动失败后不循环重试。
- [ ] 配置损坏时保留普通群聊和显式 `@Agent`。用户确认重建后，先把旧文件改名为带时间戳的 `0600` 备份，再创建空配置。

## 3. Description、Proactive 状态与 `groupSeq`

- [ ] 创建或加入群组时收集 Agent Description。trim 首尾空白，将换行和连续空白合并为一个空格，截断到 240 个字符，规范化后为空才重新输入。
- [ ] Description 按 Pi Session 和群组独立保存。加入后不可编辑；主动离群再加入时才允许重新填写。
- [ ] 成员详情向已入群成员显示 Description，离线后仍显示。附近发现、邀请摘要和未入群客户端不得得到 Description。
- [ ] 增加 Session/群组级 `proactiveEnabled` custom entry，首次加入默认 `false`，恢复同一群时恢复保存值，fork/clone 不继承。
- [ ] Proactive 开关独立于 `AgentPermission`。只允许对应 Session 的控制用户修改；不增加群组总开关。
- [ ] 切换时先保存 Session custom entry，再发送 Broker 更新。本地保存失败不更新 Broker；Broker 拒绝时回滚本地值和 UI。
- [ ] 重连时以 Session custom entry 的 `proactiveEnabled` 为准；以 Broker membership 的 Description 为准。
- [ ] SQLite `group_memberships` 增加：

```sql
agent_description TEXT NOT NULL DEFAULT ''
proactive_enabled INTEGER NOT NULL DEFAULT 0
```

- [ ] 老 membership 缺 Description 时保持未加入，等用户下次打开 `/comms` 补填；不得从 cwd、仓库名或 `AGENTS.md` 自动生成。老数据的 Proactive 一律默认关闭。
- [ ] 每群公开消息增加从 1 开始单调递增的 `groupSeq`，并建立 `(group_id, group_seq)` 唯一索引。
- [ ] 老消息在一个事务中按每群 `timestamp ASC, rowid ASC` 补齐 `groupSeq`，再建立索引。
- [ ] history、Snapshot 和 TUI 统一按 `groupSeq ASC` 排序。`timestamp` 只用于显示。
- [ ] 每个 Session/群组持久化 `lastSeenGroupSeq`。

## 4. 协议 v5 与可见性

- [ ] 将 `BROKER_PROTOCOL_VERSION` 从 4 升到 5。v4 与 v5 混用时握手直接拒绝，并显示明确版本错误。
- [ ] membership 创建与首次加入请求增加 `agentDescription`。
- [ ] 公开消息增加 `groupSeq`。
- [ ] 增加 Client → Broker 消息：

  - `proactive.update`
  - `proactive.deliver.ack`
  - `proactive.result`
  - `proactive.decline`
  - `broker.config.validate`
  - `broker.config.update`
  - `broker.config.delete`

- [ ] 增加 Broker → Client 消息：

  - `proactive.deliver`
  - `proactive.result.ack`
  - `proactive.update.ack`
  - `broker.config.status`

- [ ] `proactive.deliver` 至少包含 `proactiveId`、`groupId`、`triggerFromSeq`、`triggerToSeq`、`observedToSeq`、Observation 和过期时间。
- [ ] `proactive.result` 与 `proactive.decline` 使用明确枚举表示发布候选、沉默、过期、busy、关闭、中断、断线和失败。
- [ ] 对其他成员发送的 Snapshot、presence 和成员详情不得包含 `proactiveEnabled`。只向该 Agent 主人返回自己的开关状态。
- [ ] 远程客户端只能读取 Proactive 能力状态，不能查看或修改 Broker Key。

## 5. Fake Router 跑通主链路

- [ ] 只有新的普通人类公开消息创建 batch。开头第一个显式 `@Agent` 跳过 Router；`@人类`、正文中的 `@Agent`、短消息和寒暄仍进入 Router。
- [ ] Agent 消息、系统通知、成员变化、权限变化和错误不创建 batch。
- [ ] 没有 eligible Agent 时不创建调用。Agent 后来开启、上线、变 idle 或 cooldown 到期时不追溯旧消息。
- [ ] Router 每次调用前从实时 GroupState 构建候选。候选必须是 Agent、online、idle、Proactive 开启且不在 cooldown。
- [ ] 只把 eligible Agent 的 ID、名称和 Description 发送给 Router。候选数量不设上限。
- [ ] Router 每次最多选择一个 Agent，也可以返回 `null`。同一群允许多个不同 Session 同时生成 Proactive 回答。
- [ ] 每群实现 800ms trailing debounce、从首条消息起最多 2 秒等待、按 Router 请求开始时间计算的 5 秒最小间隔。
- [ ] Broker 同时只运行一个 Provider 请求。优先级为本机 Key 验证 → Freshness → Router；多群 Router 使用 round-robin，多个 Freshness 使用 FIFO。
- [ ] Router 输入取最近 20 条公开人类或 Agent 文本，按 `groupSeq` 去重排序，超出时标记省略。
- [ ] Router 返回后再次检查目标授权、online、idle 和 membership。目标已失效时丢弃，不改选。
- [ ] Broker 发送前补入最新公开消息，并区分 `triggerToSeq` 与 `observedToSeq`。
- [ ] `proactive.deliver` TTL 为 10 秒，不重发，不进入现有 `RemoteQueue`。
- [ ] Extension 注入前检查本地开关、Session idle、显式活动任务、等待批准请求和 TTL。不满足时 decline，不进入 cooldown。
- [ ] 未观察增量不超过 20 条时全部注入；超过时只注入最近约 12 条，并标记前文省略。
- [ ] Observation 通过 `pi.sendUserMessage()` 写入真实 Session History。格式为 `#seq [user|agent] Name: text`。写入成功后立即保存 `lastSeenGroupSeq=observedToSeq`，失败时不推进。
- [ ] Session 已入群时注入稳定 Pi Comms 提示词；离群后停止。两类 delivery 使用固定标题：`[Pi Comms Remote Request]` 和 `[Pi Comms Proactive Invitation]`。
- [ ] Prompt 明确：两类任务都可使用工具、修改本地项目和运行测试；Proactive 不主动 push、建 PR、发 Release、发邮件或执行其他外部写操作。只通过 Prompt 约束，不增加工具层硬规则。
- [ ] Proactive 可以用最终完整文本 `[PI_COMMS_NO_REPLY]` 沉默。Extension 只用 `text.trim() === "[PI_COMMS_NO_REPLY]"` 判断；使用过工具或修改过状态时，Prompt 要求正常回复。
- [ ] 本机用户输入、显式 `@当前 Agent`、关闭开关、主动离群、群解散或 Broker 断线时取消 Proactive。显式请求进入现有 `RemoteQueue` 并优先处理。
- [ ] 中断不回滚本地修改；只在 Session 本地提示可能存在未完成修改，不向群聊发布残缺结果。
- [ ] 只回传 Session 最后一条 Assistant 文本，与显式请求共用结果提取逻辑。
- [ ] `proactive.result` 和 delivery 都不做可靠重发。Broker 对已完成 `proactiveId` 内存去重 10 分钟，重复结果只 ACK。

## 6. 真实 DeepSeek、重试与故障状态

- [ ] Router 和 Freshness 固定使用 JSON Output：`thinking: { type: "disabled" }`、`response_format: { type: "json_object" }`、`temperature: 0`、`max_tokens: 128`、`stream: false`。
- [ ] Prompt 使用固定版本 `router-v1` 和 `freshness-v1`，明确包含 `json` 字样和合法示例。
- [ ] Router 只要求 `targetAgentId`；Freshness 只要求布尔 `publish`。`reason` 可选并忽略。
- [ ] 只接受纯 JSON，不修复 Markdown 包裹。严格校验目标 ID、`null` 和布尔类型，忽略其他顶层字段。
- [ ] 每次请求 3 秒超时。网络错误、超时、`429` 和 `5xx` 最多共请求 3 次；两次 full jitter 分别为 `0～500ms`、`0～1000ms`。
- [ ] `429` 的 `Retry-After` 优先，单次等待最多 5 秒。`400`、`401/403`、空内容、非法 JSON 和未知 Agent ID 不重试。
- [ ] Router 每次重试前重建候选和最新 batch；Freshness 每次重试前重读最新公开消息。
- [ ] 一组重试耗尽后，Broker 全局暂停 30 秒。暂停只存内存；期间 Router 跳过，Freshness fail closed。到期后只由新的人类消息触发，不追溯。
- [ ] 结构化日志只记录 Prompt 版本、目标 ID、结果类型、错误码和耗时，不记录 Prompt、群聊副本、模型 reasoning 或 `reason`。

## 7. Duplicate、Freshness、Cooldown 与 Agent 链

- [ ] Broker 收到正常结果或 `silent` 时立即开始 30 秒 cooldown，在 Duplicate/Freshness 前移出候选。
- [ ] 成功发布、沉默、Duplicate 命中或 Freshness 丢弃都进入 cooldown；Extension 拒绝、过期或中断不进入。cooldown 只存内存。
- [ ] 先比较当前群最近 20 条公开 Agent 回答。对文本 trim 并统一连续空白后做 exact duplicate；命中后直接丢弃，不调用 Freshness。
- [ ] `observedToSeq` 之后没有新的人类或 Agent 公开文本时直接发布；有新文本时调用 Freshness。
- [ ] Freshness 输入包含原始触发、完整候选回答和最近 20 条新增公开文本；超出时标记省略，不截断候选回答。
- [ ] Freshness 超时、限流、暂停、空内容或非法结果时 fail closed。丢弃后不通知群聊或本地 Session。
- [ ] 并行结果按到达 Broker 的顺序串行处理。先发布的回答分配新 `groupSeq`，后续回答的 Freshness 能看到它。
- [ ] 只有成功写入群聊的 Proactive 回答才解析开头的一个 `@Agent` 并创建下一跳。Duplicate/Freshness 丢弃的结果不创建链。
- [ ] 下一跳复用现有权限、FIFO 队列和 10 轮暂停确认规则，不传播 `chainOrigin`。达到上限时由最初被 Router 选中 Agent 所属 Session 决定继续或结束。
- [ ] 最终群消息不显示 Proactive 标记。Router 选择、生成、沉默、失败和丢弃过程对群成员不可见。

## 8. 自动测试

- [ ] Description：规范化、240 字符截断、按群保存、加入后不可编辑、离线可见、旧数据补填、fork 不继承。
- [ ] 配置：首次保存、未验证、两阶段更换、删除、`401/403`、配置版本、损坏备份、权限和日志脱敏。
- [ ] 数据迁移：membership 字段、`groupSeq` 回填事务、唯一索引、排序和重连权威数据。
- [ ] 协议：v5 握手拒绝、所有新消息、TTL、ACK、decline、结果去重和 Proactive 状态隐藏。
- [ ] 调度：触发边界、实时候选、800ms/2s debounce、5 秒间隔、全局单槽、优先级、round-robin 和并行 Agent。
- [ ] Session：Observation 增量与省略、cursor 推进、两种 Prompt、严格沉默标记、工具修改、中断和显式任务优先。
- [ ] Provider：固定参数、纯 JSON 校验、超时、full jitter、`Retry-After`、重试分类、全局暂停和配置状态。
- [ ] 结果：Duplicate、Freshness、fail closed、cooldown、并行发布顺序和 Agent-to-Agent 下一跳。
- [ ] CI 全部使用 `FakeProactiveRouter` 或本地 HTTP mock，不读取真实 Key，不访问 DeepSeek API。

## 9. 人工验收

- [ ] 使用三个彼此独立的一次性仓库，不在真实工作仓库执行主动修改、Agent-to-Agent 接力或中断残留测试。
- [ ] 使用本地 bare Git remote，不连接 GitHub。验证 Proactive 可以修改本地项目，但不会主动 push。
- [ ] 使用真实 `deepseek-v4-flash` 验证：专业问题选中对应 Agent；寒暄返回 `null`；关闭、busy 或 offline Agent 不进候选；多个 Agent 可以并行。
- [ ] 验证 Freshness 丢弃过时回答、Duplicate 不重复发布、沉默不显示、群内不显示 Proactive 过程状态。
- [ ] 验证 Router 缺 Key、配置错误、暂停或请求失败时，普通群聊和显式 `@Agent` 仍正常工作。
- [ ] 验收报告只记录脱敏结果和 commit SHA，不记录 API Key。

## 10. 完成条件

- [ ] 本文件第 2～9 节全部完成。
- [ ] `npm test`、类型检查和仓库 CI 通过。
- [ ] Specification、协议类型、数据库迁移、TUI 文案和测试行为一致。
- [ ] 人工验收通过，且没有向 GitHub 或其他外部服务写入测试内容。
- [ ] 将本文件移入 `TODO/done/`，并同步更新 `TODO/README.md` 的状态和链接。
