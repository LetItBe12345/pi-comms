# 阶段 18：Proactive Agent Participation 决策记录

本文档记录针对 [阶段 18 TODO](../done/18-proactive-agent-participation.md) 已经确认的设计决定。未完成的讨论不写入本文档。

## 群组授权与 Agent Profile

1. 不增加群组级 Proactive 开关。
2. 不增加“群聊内容会发送给外部 Router”的额外提示或成员列表状态。
3. `Agent Description` 在创建或加入群组时必填，不受 Proactive 开关影响。
4. `Agent Description` 按 Pi Session 和群组独立保存，使用该 Session 加入该群时填写的内容，不从其他群组继承。
5. `proactiveEnabled` 按 Pi Session 和 `groupId` 保存。阶段 19 将首次加入新群的默认值改为开启；恢复同一群组时恢复该群的原状态，已明确保存的关闭状态不变。
6. 显式 `@Agent` 永远只走现有定向链路。目标 Agent 离线、忙碌、拒绝或处理失败时，Proactive 不改选其他 Agent。

## Broker 模型与本机配置

7. Broker 模型与 Pi Session 模型严格分开。Session 模型及其 Key 继续由 Pi 自行管理，Pi Comms 不读取、修改或复用。
8. Broker 的 Router 和 Freshness 默认且只使用 `deepseek-v4-flash`。
9. Broker 所有者提供并承担 DeepSeek API Key 的调用费用。Key 不下发给 Extension、Pi Session 或群成员。
10. DeepSeek API Key 是运行 Broker 的机器级配置，不属于某个群组。配置后持久化保存在该机器，后续重启 Broker、恢复群组或创建新群组时继续复用。
11. 首次建群时如果尚未配置 Key，允许跳过。跳过后普通群聊和显式 `@Agent` 正常工作，可以稍后补充配置。
12. 写入配置前先通过 DeepSeek 官方 API 验证 Key。Key 无效时不保存；网络不可用时可保存为“未验证”，但验证成功前不能开启 Proactive。
13. 只有 Broker 本机用户可以配置、更换或删除 Key。远程客户端只能读取 `proactiveAvailable: true | false`，不能查看或修改 Key。
14. Broker 缺少已验证的 Key 时，TUI 保留 Proactive 开关并显示“群聊主机未配置 Proactive Router”。开关可以保存，但 Broker 不调用 Router。

## Router 调度

15. 每个群组最多每 5 秒调用一次 Router。限制期间的新消息合并进下一批，不影响普通群聊和显式 `@Agent`。
16. 整个 Broker 同时最多运行一个 DeepSeek Router 或 Freshness 请求。正在执行的请求不取消；等待中的 Freshness 优先于 Router。
17. 同一群组允许多个 Agent 同时处理 Proactive 邀请，不设“同一群同时最多一个活跃 Proactive”的限制。
18. 每次 Router 调用最多选择一个 Agent。后续消息批次可以继续选择其他 idle Agent，因此不同 Agent 仍可以并行工作，但不会因一次 Router 调用同时唤醒一批 Agent。

## Proactive Session 行为

19. 本条原定的“Proactive 只读、不能修改项目”已被第 44～45 条替代。
20. Proactive 和显式 `@Agent` 的行为差异通过提示词控制，不做工具层硬拦截。稳定 Session 提示词和每次 delivery 都要明确当前触发方式。
21. 不额外加入“群聊内容是不可信引用”或类似的提示词优先级规则。
22. Broker 决定是否邀请和邀请哪个 Agent。Pi Session 保留最终沉默权，可以根据自己的项目上下文决定不发言。
23. 沉默时的最终完整输出严格为 `[PI_COMMS_NO_REPLY]`。Extension 只做完整相等判断，不做包含匹配，不把该标记广播到群聊。接受该标记逐 token 生成的少量开销，以及在 Session 本地可能短暂显示。
24. 本机用户在 Agent 生成 Proactive 回答时输入新消息，Extension 立即取消 Proactive，让用户输入正常进入 Session。该次回报 `interrupted_by_user`，不进入 cooldown。
25. Proactive 生成期间收到显式 `@当前 Agent` 远程任务时，Extension 取消 Proactive，将显式任务加入现有 `RemoteQueue` 并立即处理。该次回报 `interrupted_by_explicit_request`，不进入 cooldown。
26. Proactive 生成不设独立的硬超时。依赖 Pi 自身的取消和错误处理，Agent 完成后再做 Freshness 判断。

## Delivery、Freshness 与 Cooldown

27. `proactive.deliver` 从 Broker 创建起 10 秒内有效。Extension 收到时已过期就回复 `expired`，不注入 Session，不进入 cooldown。Session 在有效期内接受后，生成时间不受这 10 秒限制。
28. Freshness 使用 Broker 的同一个 `deepseek-v4-flash` 和 API Key。Agent 生成期间如果群里没有新消息就直接发布；如果有新消息，Freshness 判断回答是否仍有价值。Freshness 超时、限流、空内容或无效 JSON 时丢弃回答。
29. cooldown 中的 Agent 从 Router 候选列表中完全移除，名称和 Description 也不发送给 DeepSeek。所有 Agent 都在 cooldown 时不调用 Router。
30. Pi Session 只要已经接受并处理 Proactive Observation，无论最终发布、返回 `[PI_COMMS_NO_REPLY]` 或被 Freshness 丢弃，都进入 30 秒 cooldown。在 Extension 端因 busy、离线、Proactive 已关闭或 delivery 过期而未处理时，不进入 cooldown。

## 并行结果与上下文进度

31. 多个 Agent 并行完成时，Broker 按结果到达顺序串行处理。先发布的回答写入新的 `groupSeq`；后续回答做 Freshness 时必须把它作为新增群消息。
32. Agent 未观察的群消息超过 20 条时，只注入最近约 12 条并明确标记前文省略。处理后 cursor 直接推进到本次最新 `groupSeq`，不再补发被省略的旧消息。
33. Proactive Observation 成功写入 Pi Session History 后，立即持久化 `lastSeenGroupSeq = triggerToSeq`。之后被本机用户输入或显式任务中断时不回滚 cursor。`sendUserMessage()` 抛错或注入失败时不推进。

## Broker 配置生命周期

34. Broker 配置文件使用 `~/.pi/comms/config.json`，通过临时文件原子替换。macOS/Linux 文件权限为 `0600`，日志和错误信息不得输出完整 Key。
35. 已验证 Key 在 Router 或 Freshness 调用中收到 `401/403` 时，立即持久化标记为无效，停止后续模型调用并更新 `proactiveAvailable = false`。超时、`429` 和 `5xx` 只算临时失败，不改变 Key 状态。
36. 因网络不可用而保存为“未验证”的 Key，在 Broker 每次启动时自动验证一次。本机设置页同时提供“重新验证”按钮。自动验证失败后不在后台循环重试。
37. Broker 为模型配置维护递增版本。Router/Freshness 请求返回时，如果当前配置版本已与请求发出时不同，直接丢弃结果。已经进入 Pi Session 生成的 Proactive 不强制中止；完成后使用当前有效配置做 Freshness。如果期间有新消息但当前无有效 Key，则丢弃回答。
38. Key 验证必须实际发送一次最小 `deepseek-v4-flash` 请求，同时验证 Key、账户状态和目标模型访问权限。
39. Key 删除或失效时，保留各 Session 在各群中已保存的 `proactiveEnabled`，只把 Broker 能力设为不可用并暂停 Router。新 Key 验证成功后，原先开启的 Agent 自动恢复候选资格。
40. Broker 从无可用 Key 恢复为可用后，不追溯触发停用期间的旧群消息。只有恢复后的下一条新普通人类消息触发 Router；停用期间的历史仍可作为最近上下文。

## 触发、Agent 链与 Description

41. 普通人类消息显式 `@人类成员` 时仍可触发 Proactive Router。只有显式 `@Agent` 跳过 Router。
42. Proactive Agent 的公开最终回答如果以有效 `@OtherAgent` 开头，自动创建 Agent-to-Agent 请求。
43. 该 Agent-to-Agent 请求复用现有链路，包括目标 Agent 的 `auto | approval | blocked` 权限、忙碌队列和连续 10 轮后暂停确认。
44. 只区分当前 Agent 是收到 `proactive.deliver` 还是 `agent.deliver`。不向下游 Agent 传播整条链最初来自 Proactive 还是人类 `@`，不增加 `chainOrigin`。Proactive 和显式 `@Agent` 都允许使用工具和修改本地项目；Proactive 保留沉默权，显式 `@Agent` 按普通定向任务处理。
45. Proactive 允许修改本地项目和运行测试，但不主动执行 `git push`、创建 PR、发布 Release、发邮件等外部写操作。该限制只写入提示词，不做工具层硬拦截。
46. Proactive 处理完成后直接回传 Pi Session 的最后一条 assistant message，与显式 `@Agent` 使用同样的结果提取逻辑，不强制增加专用修改摘要格式。
47. 人类、普通 Agent 和 Proactive Agent 都只解析最终消息开头的一个 `@名称`，一次只创建一个目标请求。正文中其他 `@` 只作为普通文本。
48. Proactive Agent 发起的 Agent-to-Agent 链达到 10 轮后，由最初被 Broker 选中的 Agent 所属 Pi Session 的控制用户决定继续或结束。
49. `Agent Description` 由程序自动规范化：去掉首尾空白，将换行和连续空白合并为一个空格，超过 240 个字符时自动截断。只有规范化后为空才要求用户重新填写。系统只保存规范化结果。
50. `Agent Description` 在 Pi Session 加入群组时确定，加入后不允许修改。因此删除原 TODO 中的“编辑 Agent 简介”入口，也不需要处理 Router 在途时 Description 变更的竞态。

## Session 恢复、中断与结果发布

51. 用户只有主动退出群组并重新加入时，才能重新填写 `Agent Description`。普通断线、关闭 Pi、`/resume` 和 Broker 重启都恢复原 membership 及原 Description，不重新询问。
52. Pi Comms 稳定提示词只在当前 Session 已加入群组时注入。未加入或主动退出后停止注入；恢复原群时恢复。
53. 关闭 `/comms` TUI 不停止 Proactive。只要 Pi Session 仍在群组中且开关为开启，就继续作为 Router 候选。只有关闭 Proactive、主动离群或 Session 结束才停止。
54. Agent 正在生成 Proactive 回答时，本机用户关闭 Proactive 会立即取消当前生成、丢弃结果并回报 `proactive_disabled`，不进入 cooldown。
55. Proactive 被用户输入、显式任务或关闭开关中断时，不自动回滚已经完成的本地修改。Extension 在 Session 本地提示“Proactive 已中断，可能留下未完成修改”，群聊不发布残缺回答。
56. Proactive 只要使用过工具或修改过本地状态，就不得返回 `[PI_COMMS_NO_REPLY]`，必须生成正常最终消息。该规则通过提示词约束，不做工具层硬检查。
57. Proactive 回答因 Freshness 判定为过时而丢弃后，不向 Session 本机额外发送通知，即使 Agent 已经修改了本地项目。
58. 只有 Proactive 回答通过 Freshness 并成功写入公开群聊后，才解析开头的 `@Agent` 并创建 Agent-to-Agent 下一跳。被 Freshness 丢弃的回答不产生后续任务。

## Duplicate Gate

59. Proactive 回答在 Freshness 之前先做本地 exact duplicate 检查。命中后直接丢弃，不调用 DeepSeek，不创建 Agent-to-Agent 下一跳；因为 Session 已经处理完成，仍进入 30 秒 cooldown。
60. exact duplicate 只比较当前群最近 20 条公开 Agent 回答。对文本 trim 并统一连续空白后做完全相等比较，不比较人类消息，不做语义相似度检查。

## Router 输入、日志与故障处理

61. Freshness 只由 Agent 生成期间新增的公开人类消息或公开 Agent 回答触发。成员上线、离线、加入、退出、系统通知和错误提示不触发 Freshness。
62. Router Context 的最近群聊也只包含人类和 Agent 的公开文本消息。成员变化、在线状态、错误提示和权限通知不发送给 DeepSeek。
63. Router 和 Freshness 判断不写入 SQLite。只记录结构化运行信息，不记录完整 prompt、群聊副本或 DeepSeek 返回的 `reason`。
64. Router 和 Freshness 使用同一套自动重试。最多共请求 3 次，只对网络错误、超时、`429` 和 `5xx` 重试；`400`、`401/403`、空内容、非法 JSON 和未知 Agent ID 不重试。每次请求超时 3 秒。第一次重试 full jitter 为 `0～500ms`，第二次为 `0～1000ms`。`429` 含 `Retry-After` 时优先采用，单次等待最多 5 秒。重试期间持续占用 Broker 唯一 DeepSeek 调用槽位。
65. 一组 3 次请求全部失败后，Broker 进入 30 秒暂停。暂停期间不调用 DeepSeek；到期后只由新的普通人类消息触发下一次 Router，不追溯处理暂停期间的旧消息。
66. 上述 30 秒暂停是整个 Broker 共用的全局状态，不按群组分开。暂停期间所有群组跳过 Router；需要 Freshness 的回答立即按 fail closed 丢弃，不等待暂停结束。
67. Broker 对外提供 `proactiveStatus: "ready" | "unconfigured" | "unverified" | "invalid_key" | "temporarily_unavailable"`。只有 `ready` 时实际调用 Router；状态变化不自动清除用户已保存的 Proactive 开关。
68. Proactive 始终允许关闭。`ready` 和 `temporarily_unavailable` 时允许打开；`unconfigured`、`unverified` 和 `invalid_key` 时禁止新打开。已经打开的状态在任何故障状态下都保留。
69. 30 秒临时暂停及失败计数只保存在 Broker 内存，不写入配置文件。Broker 重启后清空暂停状态，由下一条新消息重新尝试。
70. Router 每次重试前都重新读取当前 GroupState、eligible Agent、Description 和最新公开消息。重试期间到达的新普通人类消息合并进当前 batch。已关闭 Proactive、变 busy 或离线的 Agent 必须从重试输入中立即移除。

## 上下文上限与旧数据恢复

71. Freshness 每次重试前都重新读取当前最新公开消息。候选回答保持不变，但判断上下文必须包含重试等待期间新增的群消息。
72. Agent 生成期间新增的公开消息超过 20 条时，Freshness 只发送最近 20 条并标记更早消息已省略。原始触发内容和完整候选回答仍保留。
73. Router 的公开消息输入总计最多 20 条，按最新 `groupSeq` 取值。不再把当前 batch 全量与最近历史重复拼接；超出部分明确标记省略。
74. Freshness 始终向 DeepSeek 发送 Pi Session 的完整候选回答，不做字符截断。Freshness 允许发布时，群聊也发布同一份完整回答。
75. Router 每次发送全部 eligible Agent 的名称和 Description，不设候选数量上限。每个 Description 仍受 240 字符上限约束。
76. 旧数据库升级后，缺少 Description 的旧 membership 必须先由用户填写并完成规范化，之后才能恢复进群。Proactive 开关默认保持关闭。
77. 旧 Pi Session 在无人操作时自动启动或重连，但 membership 缺少 Description 时，不根据 cwd、仓库名或 `AGENTS.md` 自动生成。Session 保持未加入，用户下次打开 `/comms` 时补填后再恢复。

## Broker 设置入口

78. `DEEPSEEK_API_KEY` 环境变量只作为首次迁移来源。`config.json` 尚无 Key 且环境变量存在时，提示 Broker 本机用户是否验证并保存；配置文件已有 Key 时忽略环境变量。
79. `/comms` 首页只对 Broker 本机用户显示“Broker 设置”入口，提供当前 Proactive 状态、遮罩 Key、配置或更换、重新验证和删除操作。远程客户端不显示该入口。
80. 删除 Broker Key 前显示一次普通确认，明确说明“删除后所有群组的 Proactive 暂停，但不会关闭各 Session 已保存的开关”。不要求输入确认词。

## 调度、可见性与中断

81. Freshness 请求优先于 Router。多个群组同时等待 Router 时，按 `groupId` 做 round-robin，每群一次后移到队尾，不允许单个活跃群长期占用唯一 DeepSeek 调用槽位。
82. 多个 Agent 回答同时等待 Freshness 时，按结果到达 Broker 的时间 FIFO 处理。每次检查都重新读取该群最新消息，因此后处理的回答可以看到先发布的回答。
83. 群聊中最终发布的 Agent 消息不显示“主动”标记，不向群成员区分显式 `@Agent` 回答和 Proactive 回答。内部仍使用不同 delivery 类型执行提示词、沉默、Freshness 和中断规则。
84. Broker 选中 Agent、Agent 开始生成、返回沉默或回答被丢弃时，群里都不显示过程系统消息。只显示最终成功发布的 Agent 回答。
85. Proactive Agent 自身执行失败、模型报错或 Session 没有产生文本时，不在群里显示失败提示，只回报 Broker 并写结构化日志。显式 `@Agent` 任务继续使用现有公开失败逻辑。
86. Session 存在任何等待主人批准的显式 `@Agent` 请求时，Extension 拒绝 Proactive，回报 `explicit_approval_pending`，不进入 cooldown。
87. Agent 处理 Proactive 时，用户主动离群或群主解散群组会立即取消生成并丢弃回答，不进入 cooldown。已发生的本地修改不回滚，Session 本地提示可能存在未完成修改。
88. Agent 处理 Proactive 时 Extension 与 Broker 断开连接，会立即取消生成，不等待重连，不恢复该任务。已发生的本地修改不回滚。
89. Agent cooldown 只保存在 Broker 内存，不持久化。Broker 重启或 membership 真正断开后清除 cooldown。
90. 30 秒 cooldown 从 Broker 收到 `proactive.result` 或 `silent` 时开始计算，在 Duplicate/Freshness 之前就把 Agent 移出 Router 候选。Extension 端拒绝或中断的请求不启动 cooldown。

## Proactive 传输与去重

91. Extension 发送 `proactive.result` 后如果未收到 Broker ACK 就断线，不持久化该结果，重连后不重发。Broker 仍按 `proactiveId` 去重。显式 `@Agent` 结果继续使用现有可靠重发机制。
92. Broker 在内存中保留已完成 `proactiveId` 10 分钟。重复结果只回 ACK，不再发布。去重记录不写 SQLite，Broker 重启后清空。
93. Broker 发送 `proactive.deliver` 后没有收到 Extension ACK 时不重发 delivery，等 10 秒 TTL 到期后清理。显式 `agent.deliver` 继续使用现有可靠投递机制。
94. Router 判断完成后、发送 delivery 前，Broker 把当前最新公开消息补入 Observation。协议同时保留 Router 的 `triggerToSeq` 和 Agent 实际观察的 `observedToSeq`。Freshness 只检查 `observedToSeq` 之后的新消息。
95. 用户 fork 或 clone 一个已加群的 Pi Session 时，新 Session 不继承 membership、Description 或 Proactive 开关。必须独立加入群组并重新填写 Description；独立加入后使用阶段 19 定义的默认开启状态。

## DeepSeek JSON 输出规则

96. Router 输出的 `reason` 为可选字段。只严格校验 `targetAgentId` 是当前 eligible Agent ID 或 `null`。
97. Freshness 输出的 `reason` 为可选字段。`publish` 必须是 JSON 布尔值；字符串 `"true"`、数字、缺失或其他类型都视为非法结果，并按第 64 条不重试。
98. Router 只接受 `{ "targetAgentId": null }` 表示不选择 Agent。`"NONE"`、空字符串和缺少 `targetAgentId` 都是非法结果。
99. DeepSeek Provider 只接受纯 JSON 响应。Markdown 代码块或其他包裹不自动剥离或修复，直接视为非法结果。
100. Router 和 Freshness 的 JSON 可以包含额外顶层字段。Provider 忽略未知字段，但必需字段仍按第 96～98 条严格校验。

## Key 更换与配置修复

101. 更换 Broker Key 使用两阶段流程：先在内存中验证新 Key，成功后再原子替换配置文件。新 Key 验证失败或用户取消时继续使用原有效 Key，不影响正在运行的 Proactive。
102. 当前已有有效 Key 时，新 Key 因网络故障无法验证不能保存为“未验证”并覆盖旧 Key。只有首次配置且当前没有任何 Key 时，才允许暂存未验证值。
103. `proactiveStatus` 增加 `"config_error"`。`~/.pi/comms/config.json` 损坏、JSON 非法或无法读取时，Broker 禁用 Proactive，但继续提供普通群聊和显式 `@Agent`。本机设置页显示可读错误，远程客户端只看到 Proactive 不可用。
104. `config_error` 时，Broker 设置页提供“重建配置”。用户确认后先把损坏文件重命名为带时间戳的备份，再创建新的空配置，不直接覆盖或删除旧文件。
105. 损坏配置的备份保留在 `~/.pi/comms/`，权限继续为 `0600`，不自动删除。设置页显示备份路径；日志只记录路径，不读取或输出文件内容。
106. Broker Key 保存后，设置页只显示遮罩值，例如 `****abcd`，不提供“显示完整 Key”按钮。更换时必须重新输入新 Key。
107. Broker 的 DeepSeek 槽位忙碌时，本机用户发起的 Key 验证优先于等待中的 Freshness 和 Router，但不取消当前正在执行的请求。当前请求结束后先处理用户验证。
108. 本机用户删除 Key 时，立即取消正在执行的 Router/Freshness HTTP 请求，结果仍按配置版本规则丢弃。已经进入 Pi Session 的 Proactive 生成不强制中止。

## Debounce 与调用间隔

109. 每群 5 秒 Router 最小间隔按请求开始时间计算。例如上次请求在 `10:00:00` 开始、`10:00:03` 完成，下次最早可在 `10:00:05` 开始。
110. 每群第一条普通人类消息启动 batch；后续新消息把 debounce 延后到最后一条后 800ms，但从第一条起最多等 2 秒。debounce 到期时如果仍受 5 秒最小间隔限制，就继续合并新消息，间隔到期后立即调用 Router。

## 触发边界与 groupSeq

111. 普通人类消息到达时没有 eligible Agent，之后某个 Session 从关闭切换为开启 Proactive，不追溯触发旧消息。必须等下一条新普通人类消息。
112. Agent 从 offline 变 online、busy 变 idle 或 cooldown 到期时，也不自动处理之前错过的消息。这些状态变化只影响下一次新人类消息创建的 batch。
113. Broker 不用关键词、消息长度或本地词表跳过“好的”“哈哈”“收到”等短消息。只要存在 eligible Agent 就交给 Router，通过 Router Prompt 和验收测试约束返回 `null`。
114. 只有人类消息开头的第一个 `@Agent` 算显式定向并跳过 Proactive。正文中间出现的 `@Agent` 只是普通文本，该消息仍可触发 Router。
115. 公开 Agent 消息不创建 Proactive batch。它可以进入正在等待回答的 Freshness 上下文，或在开头 `@OtherAgent` 时走现有 Agent-to-Agent 链路。
116. 旧数据库迁移时，每个群组的历史消息按 `timestamp ASC, rowid ASC` 排序，然后从 1 开始补齐 `groupSeq`。迁移在一个事务中完成，随后建立 `(group_id, group_seq)` 唯一索引。
117. 迁移后，群聊历史、Snapshot 和 TUI 统一按 `groupSeq ASC` 排序。timestamp 只用于显示时间，不再用于判断消息先后。
118. 阶段 18 把 `BROKER_PROTOCOL_VERSION` 从 4 升级为 5。旧 Extension 与新 Broker 或新 Extension 与旧 Broker 都拒绝混用，握手时明确提示协议版本不匹配。

## 重连时的权威数据

119. Session 重连时，`proactiveEnabled` 以该 Session 针对当前 `groupId` 保存的 custom entry 为准。Extension 在加入或重连时发送该值，Broker 立即更新 SQLite 和 GroupState。阶段 19 起，Session 没有记录时按 `true`；已有的 `false` 记录仍保持关闭，Broker 不得用 SQLite 值覆盖 Session 设置。
120. `Agent Description` 在首次加入后以 Broker membership 中的值为准。重连时 Broker 返回该值，Extension 用它构建稳定提示词。只有 Broker 记录为空的旧数据才要求用户补填。

## Session 开关同步与建群流程

121. 用户切换 Proactive 开关时，Extension 先持久化 Session custom entry，再发送 `proactive.update`。本地保存失败时不更新 Broker；Broker 断线时保留本地值，重连后重新发送。
122. Extension 本地保存开关后，Broker 只在 Session 不属于目标群组时拒绝 `proactive.update`，并返回 ACK 和原因。Key 失效或配置错误只改变 Broker 能力状态，不清除开关。Broker 拒绝时，Extension 把 custom entry 和 UI 回滚到切换前状态并显示原因。
123. 创建群组时按顺序收集用户名称、Agent 名称、Agent Description、群组名称和加入方式，然后检查 Broker Key，允许配置或跳过，最后才真正写入并创建群组。Key 验证失败或用户取消时仍可选择跳过，不留下半创建群组。

## Description 和 Proactive 状态的可见性

124. Agent Description 是公开群组元数据，在成员详情中对所有已入群成员可见。其他成员只能查看，不能修改；Router 使用同一份公开文本。
125. Agent 离线后，成员详情继续显示其 Description。Description 作为长期 membership 元数据保留，但离线 Agent 不进入 Router 候选，Description 也不发送给 DeepSeek。
126. 未加入群组的附近设备不能从附近群组摘要或完整邀请信息中查看成员或 Agent Description。只有成功入群并收到群组 Snapshot 后才可查看。
127. 其他群成员看不到某个 Agent 的 Proactive 开关是开还是关。
128. 上述不只是 TUI 隐藏。Broker 不得在发送给其他客户端的 Snapshot 或 presence 更新中包含 `proactiveEnabled`。Agent 主人可以看自己的状态，Broker 内部保留真实值供 Router 过滤。
129. Broker 所有者即使承担 API 费用，也不能单独修改或关闭其他成员 Agent 的 `proactiveEnabled`。Broker 所有者只能管理全局 Key，或使用现有成员管理操作移出成员。
130. MVP 不增加 Broker 每日 DeepSeek 请求数或 token 费用上限。先依赖单调用槽位、每群 5 秒限频、Agent cooldown 和失败暂停；Broker 所有者可随时删除 Key。

## Prompt、测试与实施顺序

131. Extension 判断沉默时使用 `text.trim() === "[PI_COMMS_NO_REPLY]"`。只允许标记前后存在空白；Markdown 包裹、附加说明或其他文本都不算沉默。
132. Proactive Observation 的每条群消息都明确标注发送者类型，例如 `#121 [user] Alice: ...` 和 `#122 [agent] Backend-Pi: ...`。
133. Router 和 Freshness 固定使用 `temperature: 0`、`max_tokens: 128`、`thinking: { type: "disabled" }` 和 `stream: false`，不向用户开放这些参数。
134. Router 和 Freshness Prompt 分别使用代码内固定版本号，初始为 `router-v1` 和 `freshness-v1`。结构化日志只记录版本号，不记录完整 Prompt。
135. Extension 向 Pi Session 注入的两类消息使用不同的固定标题：`[Pi Comms Proactive Invitation]` 和 `[Pi Comms Remote Request]`。Agent 通过 Extension 标注区分触发方式，不通过搜索正文中的 `@` 猜测。
136. Router Prompt 只要求输出 `targetAgentId`，Freshness Prompt 只要求输出 `publish`，不要求生成 `reason`。模型额外返回 `reason` 时按可选未知字段接受并忽略。
137. CI 不读取真实 DeepSeek Key，不调用真实 API。单元测试和 E2E 全部使用 `FakeProactiveRouter` 或本地 HTTP mock；真实 `deepseek-v4-flash` 只用于人工验收。
138. Proactive 真实验收必须使用三个彼此独立的一次性测试仓库。主动修改、Agent-to-Agent 接力和中断残留不得在真实工作仓库中执行。验收报告只记录脱敏结果和 commit SHA，不记录 API Key。
139. 验收“Proactive 可以修改本地项目，但不主动 push”时，一次性仓库使用本地 bare Git remote，不连接 GitHub。先验证 Proactive 只修改本地且不 push，再用显式 `@Agent` 路径单独验证明确授权后的处理。
140. 阶段 18 按以下顺序实施：先同步 Specification、TODO 和 Decision；然后实现 Broker 配置与 Provider 接口；实现 Description、Proactive 和 `groupSeq` 迁移；升级协议 v5 及状态可见性；用 Fake Router 跑通调度、delivery、cursor、提示词和并行结果；接入真实 DeepSeek、重试和故障状态；实现 Duplicate、Freshness、cooldown 和 Agent-to-Agent；最后完成自动测试与一次性仓库真实验收。
141. 文档分工固定为：`TODO/decision/18-proactive-agent-participation.md` 保留完整决策记录；`SPECIFICATION.md` 写最终产品规则和协议行为；阶段 18 TODO 只写可执行实施步骤、测试和完成条件。不把 140 条决策全量复制进 TODO；同步时直接修正旧 TODO 中与决策冲突的内容。
