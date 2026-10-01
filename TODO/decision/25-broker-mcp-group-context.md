# 阶段 25：Broker MCP 群聊上下文读取 决策记录

本文档记录针对 [阶段 25 TODO](../done/25-broker-mcp-group-context.md) 已经确认的设计决定。未完成的讨论不写入本文档。

## Pi 与 MCP 形态

1. Pi 升级到当前支持原生 MCP 的版本；现有 Pi Comms Extension 同步适配新版 API。
2. MCP Server 放在 Broker 进程内，不增加独立 MCP sidecar。
3. 当前 Pi Session 是 MCP Client。
4. Broker 的现有 TCP 协议继续负责实时连接、消息和其他现有写路径；MCP 负责 Agent 按需读取。
5. Agent 不直接打开 Broker 的 SQLite。MCP handler 继续经过 Broker 的身份、membership、上下文和数据库逻辑。
6. MCP 使用 Pi 原生支持的 Streamable HTTP 连接方式。
7. Local 和 LAN 都支持 MCP；远程 Session 读取其当前连接 Broker 上的数据。

## Tool 与 Resource

8. 第一版只提供两个 MCP Tool：`get_group_context` 和 `read_group_messages`。
9. 两个 Tool 全部使用 `direct` exposure，不使用 `deferred`、`codemode` 或 Tool 级渐进式披露。
10. 第一版提供两个 Resource：`pi-comms://group/current` 和 `pi-comms://group/context`。
11. 第一版不增加发送消息、Agent 转交、群管理、全文搜索、RAG 或向量检索 Tool。
12. 第一版 MCP 是只读能力。

## 当前群与身份

13. MCP 只能读取当前 Pi Session 已加入的当前群。
14. Tool 不接收任意 `groupId` 参数；Broker 根据已认证 Session 决定可访问群。
15. Broker 基于现有已认证 TCP Session 为当前 Session 签发短期 MCP access token。
16. MCP access token 只用于 MCP HTTP 读取，不复用 TCP `resumeToken`。
17. Token 映射回 Broker 已知的 Session 身份和当前 membership。
18. Session 离群、Session 结束或 Broker 重启后，该 MCP token 失效。
19. Broker 不可用、未入群或 token 无效时直接返回明确错误，不从 MCP cache 提供旧数据。

## 群聊 Context

20. `get_group_context()` 永远读取调用时的最新群状态，不提供“冻结到某个历史 seq”的参数。
21. `get_group_context()` 包含当前群信息、最新 `groupSeq`、现有角色目录、已有滚动摘要和最近公开消息窗口。
22. 角色目录直接复用阶段 21 的 `participantContext()`，不新建第二套 member schema。
23. Context 只读取已有摘要快照，不调用 `GroupContextSummary.prepare()`，不因为 MCP read 触发 DeepSeek。
24. 当已有摘要不足以覆盖省略区间时，返回 `summaryIncomplete`；Agent 可以再调用 `read_group_messages` 获取原始历史。
25. 阶段 25 保留现有 Remote Request 和 Proactive Invitation 的上下文注入，不立即改成只发送小 trigger 后完全依赖 MCP pull。

## 历史消息读取

26. `read_group_messages` 使用 `afterSeq`、`throughSeq` 和 `limit`。
27. `afterSeq` 是排他下界；`throughSeq` 是包含上界。
28. 不传边界时返回当前最新一页。
29. `limit` 默认 20，最大 50。
30. 历史读取直接复用当前 SQLite `publicMessages()` 的按 `groupSeq` 查询语义。
31. 不增加 `beforeSeq`、`aroundSeq`、timestamp 分页或全文搜索作为第一版要求。
32. Tool 只返回稳定公开字段，不返回 `agent_requests` 内部状态、长期 membership credential、MCP token、API Key、其他 Session 私有状态或私有 Proactive 状态。

## Proactive 与触发锚点

33. MCP read 不推进 `lastSeenGroupSeq`。
34. MCP read 不改变 Proactive cursor、cooldown、ACK、投递状态或其他写状态。
35. 显式 Agent 请求增加 `sourceGroupSeq`，记录触发该请求的公开群消息序号。
36. 第一版只增加 `sourceGroupSeq`，不额外增加 `sourceMessageId`。
37. `sourceGroupSeq` 用于让 Agent 在需要时通过 `read_group_messages({ throughSeq: sourceGroupSeq })` 回看触发点之前的群聊历史。
