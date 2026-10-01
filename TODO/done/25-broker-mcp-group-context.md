# 阶段 25：Broker MCP 群聊上下文读取

状态：已完成（2026-10-01）

目标：让当前 Pi Session 通过 Broker 内置的 MCP Server 按需读取当前群的最新上下文和公开消息历史；继续复用 Broker 的身份、权限、SQLite 和群聊上下文逻辑，不新增第二套状态。

依赖：阶段 20、阶段 21、阶段 24

设计选择见 [阶段 25 决策记录](../decision/25-broker-mcp-group-context.md)。

## 实施项

- [x] 先把 MCP 的产品行为、权限边界、Tool / Resource 接口和数据范围写入 `SPECIFICATION.md`。
- [x] 将 Pi 依赖升级到当前支持原生 MCP 的版本，并适配 Extension API、测试桩和现有 Pi Comms 行为。
- [x] 在 Broker 进程内增加 MCP Server。Pi Session 作为 MCP Client；不创建独立 MCP sidecar，不让 Agent 直接读取 SQLite。
- [x] MCP 使用 Pi 原生支持的 Streamable HTTP 连接方式；Broker 负责 MCP endpoint 的启动、关闭和运行时地址管理。
- [x] 复用现有已认证 TCP Session，由 Broker 为当前 Session 签发短期 MCP access token。Token 只绑定当前 Session 和其当前群，不允许 Tool 自行指定任意 `groupId`。
- [x] MCP access token 在离群、Session 结束或 Broker 重启后失效；无效或过期 token 返回明确错误。
- [x] Pi Comms Extension 自动用 `pi.registerMcpServer()` 注册当前 Broker MCP Server，并把两个 Tool 暴露为 `direct`；不要求用户手工修改 `mcp.json`。
- [x] 实现只读 Tool `get_group_context()`。它永远返回当前最新群状态，并包含群信息、`latestGroupSeq`、阶段 21 的 `participantContext()`、已有滚动摘要、摘要覆盖范围、`summaryIncomplete` 和最近最多 12 条公开消息。
- [x] `get_group_context()` 只使用现有快照读取路径，不调用摘要 Provider，不触发 DeepSeek，不产生额外模型费用。
- [x] 实现只读 Tool `read_group_messages({ afterSeq?, throughSeq?, limit? })`。默认返回最新 20 条，最大 50 条；`afterSeq` 为排他下界，`throughSeq` 为包含上界。
- [x] `read_group_messages` 直接复用现有 `publicMessages()` 查询语义，不增加全文搜索、向量检索或第二套历史存储。
- [x] Tool 返回只包含稳定公开字段：`groupSeq`、`messageId`、`timestamp`、`senderName`、`senderType`、`text`、`mentionIds`，以及存在时的 `chainId`、`round`。不得暴露内部请求状态、凭证、API Key、其他 Session 私有状态或私有 Proactive 状态。
- [x] 增加两个只读 Resource：`pi-comms://group/current` 和 `pi-comms://group/context`。它们只提供当前已授权群的可读状态，不增加新的写能力。
- [x] MCP read 不推进 `lastSeenGroupSeq`，不改变 Proactive cursor、cooldown、ACK、投递状态或任何群聊写状态。
- [x] 在 `AgentRequestPayload` 增加 `sourceGroupSeq`，记录触发显式 Agent 请求的公开消息序号；Broker 重启后的请求恢复也必须保留该值。
- [x] 保留现有 `[Pi Comms Remote Request]`、`[Pi Comms Proactive Invitation]` 和当前上下文注入行为。阶段 25 只新增 MCP pull 能力，不立即删除旧注入。
- [x] Local Broker 和 LAN Broker 都支持 MCP。远程 Pi Session 继续连接其当前已选择的 Broker，不回退读取本机 SQLite。
- [x] Broker 不可用、当前 Session 未入群或 MCP token 无效时返回明确错误；MCP 不维护旧 context cache。
- [x] 第一版 MCP 只读，不增加 `send_group_message`、Agent 转交、群管理或其他写 Tool。
- [x] 覆盖 MCP 注册、身份绑定、错误 token、离群失效、Broker 重启失效、Local/LAN、最新 context、摘要不触发 Provider、消息分页、50 条上限、公开字段过滤、Resource 读取、cursor 不推进和 `sourceGroupSeq` 的自动测试。
- [x] 使用真实新版 Pi Session 完成一次 MCP 验收：自动注册成功、两个 direct Tool 可见、两个 Resource 可读、Local 和 LAN 至少各验证一次读取路径。
- [x] 更新 README 中 Agent 按需读取群聊上下文的说明。

## 完成条件

- [x] 当前 Pi Session 可以通过 Broker MCP 读取当前群最新上下文和公开历史。
- [x] MCP 无法读取其他群，也不能绕过 Broker 的 Session 与 membership 权限边界。
- [x] 两个 Tool 均为 `direct`，两个 Resource 可正常读取。
- [x] MCP read 不触发 DeepSeek、不推进 Proactive cursor、不修改群聊状态。
- [x] Local 与 LAN 使用同一套 Broker 权限和查询逻辑。
- [x] 现有显式 Agent、Proactive、群聊和 TUI 行为保持兼容。
- [x] `npm run check` 通过。

## 验收记录

- [实现与双 TUI 端到端报告](../../docs/reports/25-broker-mcp-report.md)。
- Node 22.23.3 下 npm run check 通过；187 个测试通过，1 个既有环境条件测试跳过。
- 真实 Pi 0.99.2 双 TUI 分别完成 Local 和本机 LAN IPv4 路径，四个 Session 共 16 次原生 MCP Tool / Resource 调用成功。模型层为确定性测试 Provider；两台物理设备验收仍由阶段 16B 跟踪。
