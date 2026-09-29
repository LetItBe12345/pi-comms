# 阶段 20：群聊上下文摘要与 12 条窗口

状态：已完成

目标：只压缩 Pi Comms 的公开群聊上下文，用滚动摘要和最近 12 条原始消息为 Router、Proactive Agent 和 Freshness 提供稳定背景；不接管 Pi Session 自身的压缩。

依赖：阶段 19

## 实施项

- [x] 先把最终产品规则、摘要边界、故障行为和验收要求写入 `SPECIFICATION.md`。
- [x] 将 Router 的公开消息窗口从最近 20 条统一为最近 12 条。
- [x] 将 Proactive Observation 的原始消息窗口统一为最近 12 条，不再保留“超过 20 条后取最近约 12 条”的双重阈值。
- [x] 将 Freshness 的新增原始消息窗口从最近 20 条统一为最近 12 条。
- [x] 保留 Duplicate 对最近 20 条 Agent 回答的本地比较；它不属于模型上下文窗口。
- [x] 摘要只处理公开用户消息和公开 Agent 回答。系统通知、成员变化、错误、权限状态、私人 Session、工具调用和本地文件内容不得进入摘要。
- [x] 定义持久化的群聊滚动摘要，至少记录 `groupId`、摘要正文、`fromSeq`、`throughSeq`、Prompt 版本和更新时间。
- [x] 原始群聊消息继续完整保存在 SQLite；摘要不删除、不覆盖原始消息。
- [x] 摘要输入使用“上一次摘要 + 尚未纳入摘要且已落出最近 12 条窗口的公开消息”，一次批量更新到新的连续 `throughSeq`。
- [x] 摘要保留已确认目标、约束、决定及其修改、关键事实、已完成结果、正在处理的工作和未解决问题；保留说话者与必要的文件名、接口名、错误信息和消息编号。
- [x] Prompt 明确禁止把计划写成已完成、把 Agent 建议写成用户决定、凭空补充事实或遗漏后来对旧决定的修改。
- [x] 摘要与最近 12 条原始消息不得在 `groupSeq` 上重叠或留下未标记的缺口。
- [x] Router 和同一批多 Agent 邀请复用同一份已生成摘要，不为每个 Agent 重复调用模型。
- [x] Freshness 输入保留原始触发内容、完整候选回答、Agent 当时的 `observedToSeq`、可用的群聊摘要和最近最多 12 条新增消息。
- [x] 摘要失败时，Router 和 Proactive Delivery 使用上一次成功摘要与最近 12 条，并明确标记摘要不完整；Freshness 缺少必要的省略区间时继续 fail closed。
- [x] 摘要生成不得阻塞普通群聊和显式 `@Agent` 投递。
- [x] 群组解散时删除对应摘要；Broker 重启后从 SQLite 恢复摘要并校验覆盖范围。
- [x] 为 Provider 增加独立的 Summary Prompt、返回校验、超时、重试和结构化日志；日志不得包含群聊副本。
- [x] 将 Broker 使用的模型名从兼容名称 `deepseek-v4-flash` 更新为官方当前名称 `deepseek-flash`，Router、Freshness、Summary 和 Key 验证保持一致。
- [x] 更新 Provider 调度，使 Key 验证、Freshness、Summary 和 Router 使用明确优先级，并避免 Summary 长期饿死或阻塞 Freshness。
- [x] 增加数据库迁移、Provider、摘要滚动、断点恢复、缺口检测、并发复用、失败降级和 Prompt 格式测试。
- [x] 更新 README 中的群聊上下文和 DeepSeek 数据边界说明。

## 完成条件

- [x] Router、Proactive Agent 和 Freshness 的原始群聊窗口均不超过 12 条。
- [x] 超出窗口的公开群聊可通过带连续 `groupSeq` 范围的滚动摘要提供给模型。
- [x] Pi Session 私人内容、工具调用和项目文件不会进入群聊摘要。
- [x] 摘要失败不影响普通群聊和显式 Agent 请求，Freshness 不会在缺少关键新增上下文时误发布。
- [x] 原始群聊历史完整保留，Broker 重启后摘要可继续滚动。
- [x] `npm run check` 通过。
