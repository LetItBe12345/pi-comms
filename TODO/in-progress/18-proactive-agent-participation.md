# 阶段 18：Proactive Agent Participation

目标：允许用户明确开启 Proactive 后，由 Broker 根据公开群聊和 Agent 简介，主动选择最多一个合适 Agent 参与讨论；默认关闭，不影响现有显式 `@Agent`、审批和 Agent-to-Agent 链路。

## 产品规则

- Proactive 默认关闭。
- 每个用户只控制自己的 Agent 是否允许主动参与。
- 只有 `proactiveEnabled = true` 的 Agent 才能成为主动路由候选。
- `AgentPermission = auto | approval | blocked` 继续只控制显式 `@Agent` 请求；Proactive 使用独立开关，不复用现有权限语义。
- Proactive 开启本身即表示用户允许该 Agent 被主动唤醒，不再进入 `approval` 流程。
- MVP 只对普通人类群聊消息进行 Proactive 判断。
- 显式 `@Agent` 消息不触发 Proactive。
- Agent 公开消息不触发下一轮 Proactive，避免形成自动循环。
- 每次 Router 最多选择一个 Agent，也允许选择 `NONE`。
- Proactive 请求是短时、可丢弃的工作；Agent 忙碌、离线、关闭 Proactive 或请求过期时直接丢弃，不进入现有 `RemoteQueue`。
- Router 失败、超时、限流或返回无效结果时 fail closed：不唤醒任何 Agent，普通群聊继续正常工作。
- 主 Agent 被主动唤醒后仍可选择不发言。
- 主 Agent 的主动回答在广播前必须通过 freshness 检查。
- MVP 不允许 Proactive 回答继续自动触发 Agent-to-Agent 链路。

## 1. Agent Profile 与 UI

- [ ] 加入群组/创建群组时，在用户名称和 Agent 名称之外要求填写 `Agent Description`。
- [ ] Description 用于公开描述 Agent 的能力，例如“负责 Node.js、Broker、SQLite 和消息协议”。
- [ ] Description 为公开群组元数据，不上传 Pi 私人 Session、System Prompt、AGENTS.md、cwd、源码或私人对话。
- [ ] Description 做 trim，限制合理长度，MVP 建议最多 240 字符。
- [ ] 保存本地默认 Agent Profile；后续加入其他群组时自动复用并允许修改。
- [ ] `SavedMembership`、`DesiredMembership` 和默认 Profile 状态增加 `agentDescription`。
- [ ] 成员详情中显示 Agent Description。
- [ ] 增加“编辑 Agent 简介”入口。

## 2. Proactive 权限管理

- [ ] 新增独立状态：

```ts
proactiveEnabled: boolean;
```

- [ ] 默认值必须为 `false`。
- [ ] TUI 将现有接收权限和 Proactive 权限明确分开：

```text
被 @ 时
- 自动接受
- 需要批准
- 禁止接受

主动参与
- 关闭
- 开启
```

- [ ] 开启时发送 `proactive.update { enabled: true }`。
- [ ] 关闭时发送 `proactive.update { enabled: false }`。
- [ ] 用独立 Session entry 保存，例如 `pi-comms-proactive`。
- [ ] `/resume`、Extension reload 和 Broker reconnect 后恢复该状态。
- [ ] 其他群成员只能看到 Agent 是否允许 Proactive，不能修改。
- [ ] `AgentPermission` 与 `proactiveEnabled` 各自独立测试，避免语义耦合。

## 3. 类型、协议与持久化

- [ ] `Member` 增加：

```ts
agentDescription?: string;
proactiveEnabled?: boolean;
```

- [ ] `GroupMembership` / Broker `StoredMembership` 增加 `agentDescription` 和 `proactiveEnabled`。
- [ ] `group.create` 和首次 `group.join` 支持 Agent Description。
- [ ] 增加 `proactive.update` Client → Broker 消息。
- [ ] 增加独立的 `proactive.deliver` Broker → Client 消息，不复用 `agent.deliver`。
- [ ] 增加 `proactive.result` / `proactive.decline` 回执语义。
- [ ] 协议字段落定后 bump `BROKER_PROTOCOL_VERSION`。
- [ ] SQLite `group_memberships` 增加：

```sql
agent_description TEXT NOT NULL DEFAULT ''
proactive_enabled INTEGER NOT NULL DEFAULT 0
```

- [ ] 老数据库 migration 后一律保持 `proactive_enabled = 0`。
- [ ] 老 membership 缺少 Description 时不自动生成私人信息；由用户下一次进入时补充。

## 4. Group Sequence

- [ ] 为群组消息增加单调递增的 `groupSeq` / `seq`。
- [ ] SQLite 对 `(group_id, group_seq)` 建唯一约束。
- [ ] Broker 写入消息时生成下一 seq。
- [ ] Snapshot 和 Extension `history` 保留 seq。
- [ ] 老消息按既有时间线顺序补 seq。
- [ ] 后续 Proactive trigger、lastSeen、freshness 和 stale 判断统一使用 seq，不依赖纯 timestamp。

## 5. Broker 候选过滤

Router 调用前先做零成本硬过滤。

候选 Agent 必须同时满足：

```ts
member.type === "agent"
&& member.online === true
&& member.agentStatus === "idle"
&& member.proactiveEnabled === true
```

- [ ] 没有候选时不调用模型。
- [ ] 不把关闭 Proactive、busy 或 offline Agent 的 Description 发给 Router。
- [ ] 显式 `@Agent` 消息直接走现有路由，不调用 Proactive Router。
- [ ] Agent 发送的公开消息不触发 Proactive Router。
- [ ] Router 结果回来后重新读取 GroupState；目标已 busy/offline/disabled 时直接丢弃，不选第二名。

## 6. Group Debounce

- [ ] 普通人类消息先正常落库并广播，不等待 Router。
- [ ] 按 `groupId` 做短 debounce，避免连续输入触发多次模型调用。
- [ ] MVP 初始参数：`debounce = 800ms`，`maxWait = 2s`。
- [ ] 同一个 batch 保存 `triggerFromSeq` 和 `triggerToSeq`。
- [ ] batch 到期后只调用一次 Router。

## 7. Proactive Router 抽象

Broker 不直接依赖某个厂商调用细节。

```ts
interface ProactiveRouter {
  select(input: ProactiveRouteInput): Promise<ProactiveRouteResult>;
}

interface ProactiveRouteResult {
  targetAgentId: string | null;
  reason?: string;
}
```

- [ ] `server.ts` 只依赖 `ProactiveRouter` 接口。
- [ ] 先实现 `FakeProactiveRouter`，跑通协议、状态、Session 注入和 freshness 生命周期。
- [ ] 再接真实 DeepSeek provider。
- [ ] Router 一次看到全部 eligible Agent，一次返回 `0 或 1` 个目标。
- [ ] 不实现 per-Agent 小模型评分、竞价、offer 或 Top-N election。

## 8. Router 输入

MVP 输入只包含公开且必要的信息：

- 当前 batch 的触发消息。
- 最近约 12 条公开群聊消息。
- eligible Agent 的 `{ agentId, name, description }`。

Router Prompt 的核心规则：

- 最多选一个 Agent。
- 没有明显价值时必须选择 `NONE`。
- “话题相关”不等于“应该发言”。
- 只有能回答未解决问题、纠正重要错误、补充缺失专业知识或明显推进讨论时才选择 Agent。
- 避免重复已有回答、附和、寒暄和无意义插话。

## 9. DeepSeek-V4-Flash 官方 Provider

MVP 的第一个真实 Router provider 使用 DeepSeek 官方 API。

固定默认配置：

```text
provider: deepseek
baseURL: https://api.deepseek.com
model: deepseek-v4-flash
apiKey: DEEPSEEK_API_KEY
stream: false
thinking.type: disabled
response_format.type: json_object
```

- [ ] 只支持官方 `api.deepseek.com` 作为 MVP DeepSeek endpoint，不默认接第三方转发服务。
- [ ] 环境变量使用 `DEEPSEEK_API_KEY`。
- [ ] Router 默认模型使用 `deepseek-v4-flash`。
- [ ] Router 使用非思考模式：`thinking: { type: "disabled" }`，避免为简单分类增加不必要延迟。
- [ ] Router 使用 DeepSeek JSON Output：`response_format: { type: "json_object" }`。
- [ ] Prompt 中明确包含 `json` 字样和合法 JSON 示例，满足 DeepSeek JSON Output 要求。
- [ ] JSON 示例固定为：

```json
{
  "targetAgentId": "agent:...",
  "reason": "short reason"
}
```

或：

```json
{
  "targetAgentId": null,
  "reason": "no agent should speak"
}
```

- [ ] 输出 token 上限保持很小，MVP 建议 128～256 tokens。
- [ ] 请求 timeout 初始值 3 秒。
- [ ] Router 不自动 retry；timeout、429、5xx、空 content、非法 JSON、未知 agentId 均视为 `NONE`。
- [ ] 不使用 tools / function calling；Router 只做分类和选择。
- [ ] 不因为 DeepSeek 支持 1M context 就扩大输入；仍保持最近约 12 条消息和简短 Agent Description。
- [ ] 不记录或保存模型推理过程。
- [ ] Router provider 配置通过小接口隔离，未来需要时可增加其他 provider，而不修改 Proactive 主流程。

建议配置接口：

```ts
interface RouterModelConfig {
  provider: "deepseek";
  model: string;
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
}
```

建议默认环境配置：

```text
PI_COMMS_ROUTER_PROVIDER=deepseek
PI_COMMS_ROUTER_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=...
```

MVP 不需要先实现多 provider UI；Broker 从环境/config 读取即可。

## 10. Proactive Delivery

建议协议负载：

```ts
interface ProactiveDeliverPayload {
  proactiveId: string;
  groupId: string;
  groupName: string;
  targetAgentId: string;
  targetAgentName: string;
  triggerFromSeq: number;
  triggerToSeq: number;
  createdAt: number;
  expiresAt: number;
}
```

- [ ] Broker 发送前再次确认目标 online、idle、proactiveEnabled。
- [ ] Proactive 请求带短 TTL。
- [ ] Extension 收到后再次检查真实 `context.isIdle()`。
- [ ] Extension 有显式远程任务、active request 或 Session busy 时立即 `proactive.decline`。
- [ ] Proactive 不进入 `RemoteQueue`，不等待 Session 以后空闲。
- [ ] 请求过期直接丢弃。

## 11. Stable Context 与 Agent Description

Agent 自己长期稳定的信息进入稳定 Pi Comms System Prompt：

- Agent 群聊名称。
- 自己的公开 Description。
- Proactive 行为规则：只有能推进讨论时回答；允许保持沉默；不要重复其他成员。

- [ ] 使用 Pi `before_agent_start` 在固定位置追加稳定 Pi Comms prompt。
- [ ] Description 未修改时保持文本稳定，避免不必要破坏 provider KV Cache 前缀。
- [ ] 其他 Agent 的 Description 不长期复制到 System Prompt。

## 12. Group Context 与 Session History

Agent 真正观察到的群聊按增量写入其 Pi Session，保持 append-only。

- [ ] 每个 Agent / Group 保存 `lastSeenGroupSeq`。
- [ ] 下一次主动唤醒只注入 `lastSeenGroupSeq` 之后的新消息。
- [ ] 不重复发送“最近 10 条”已经看过的消息。
- [ ] `delta <= 20` 时直接发送 raw delta。
- [ ] `delta > 20` 时 MVP 先发送最近约 12 条 raw，并标记前面有消息省略；摘要模型放到后续阶段。
- [ ] Group Observation 使用一次 `pi.sendUserMessage()` 进入真实 Session History。
- [ ] 不把动态 Group Context 临时插入旧 Session History 中间。
- [ ] `lastSeenGroupSeq` 作为 Session custom entry 持久化并可在 `/resume` 后恢复。
- [ ] Agent 确实处理完 observation 后再推进 cursor。
- [ ] 即使 Agent 最终选择沉默，已经看过的 seq 仍推进。

建议 observation：

```text
[Pi Comms Group Observation]

Group: agent-comms

New group messages:
#121 Alice: ...
#122 Bob: ...
#123 Alice: ...

You were proactively invited to participate.
Only respond if you can add concrete value.
```

## 13. 主 Agent 沉默权

- [ ] 主 Agent Prompt 明确允许不发言。
- [ ] 定义内部 sentinel，例如 `[PI_COMMS_NO_REPLY]`。
- [ ] Extension 检测到 sentinel 后返回 `proactive.result { action: "silent" }`。
- [ ] silent 不在群聊中产生公开消息。
- [ ] silent 仍推进 `lastSeenGroupSeq`。

## 14. Freshness Gate

Agent 思考期间群聊可能继续变化。

- [ ] Broker 记录 Proactive 的 `triggerToSeq`。
- [ ] Proactive result 返回时读取最新 group seq。
- [ ] 没有新消息时直接进入广播前检查。
- [ ] 有新消息时调用 Freshness Checker。
- [ ] Freshness Checker 复用同一个 `deepseek-v4-flash` provider，不增加第二套模型依赖。
- [ ] Freshness 也使用非思考模式和 JSON Output。
- [ ] Freshness 输入只包含原 trigger、候选回答和 trigger 之后新增的消息。
- [ ] 输出：

```json
{
  "publish": true,
  "reason": "still useful"
}
```

或：

```json
{
  "publish": false,
  "reason": "discussion already resolved"
}
```

- [ ] Freshness timeout、限流、空 content 或非法 JSON 时 fail closed：不广播 Proactive 回答。

## 15. Duplicate Gate 与 Cooldown

- [ ] 广播前先做零成本 exact duplicate 检查：trim、统一空白后比较近期 Agent reply。
- [ ] 已有更新消息时由 Freshness Checker 同时判断语义是否已经被其他成员覆盖。
- [ ] MVP 不引入 embedding 或 vector DB。
- [ ] Agent 主动发言后设置短 cooldown，初始建议 30 秒。
- [ ] cooldown 只限制 Proactive，不影响显式 `@Agent`。

## 16. Agent-to-Agent 隔离

- [ ] Proactive reply 默认只作为普通公开 Agent 消息。
- [ ] Proactive reply 即使以 `@OtherAgent` 开头，也不自动创建下一轮 Agent request。
- [ ] 现有显式 Agent-to-Agent chain 和 10 轮暂停机制保持不变。
- [ ] 后续如需“主动 Agent 链”，单独设计权限、预算和循环控制，不在本阶段加入。

## 17. Observability

至少记录结构化事件，不默认记录完整 prompt：

```text
proactive.router.called
proactive.router.none
proactive.router.selected
proactive.router.error
proactive.delivery.busy
proactive.delivery.disabled
proactive.delivery.expired
proactive.agent.silent
proactive.result.published
proactive.result.stale
router_latency_ms
```

- [ ] 默认不持久化 Router 完整群聊输入。
- [ ] 默认不保存模型 reasoning。
- [ ] Debug 模式可记录短 `reason` 和 route metadata。

## 18. 自动测试

### Profile / Permission

- [ ] Description 创建、加入、修改和恢复。
- [ ] 老 DB migration。
- [ ] Proactive 默认关闭。
- [ ] 开启/关闭后 Session restore 正确。
- [ ] `AgentPermission` 与 Proactive 独立。

### Router

- [ ] 无 candidate 时不调用模型。
- [ ] disabled/busy/offline Agent 不进入 Router input。
- [ ] Router 最多返回一个目标。
- [ ] `NONE` 不产生 delivery。
- [ ] 未知 agentId 被拒绝。
- [ ] 显式 `@` 不触发 Proactive。
- [ ] Agent 公开消息不触发 Proactive。

### DeepSeek Provider

- [ ] 使用 `https://api.deepseek.com` 和 `deepseek-v4-flash`。
- [ ] 发送 `thinking.type = disabled`。
- [ ] 发送 `response_format.type = json_object`。
- [ ] 缺少 `DEEPSEEK_API_KEY` 时 Broker 明确禁用 Router，但群聊仍可用。
- [ ] timeout fail closed。
- [ ] 429 / 5xx fail closed。
- [ ] 空 content fail closed。
- [ ] 非法 JSON fail closed。
- [ ] 合法 `NONE` 正常解析。
- [ ] 合法 target 正常解析。

### Debounce / Delivery

- [ ] 连续多条消息只触发一个 Router batch。
- [ ] Extension idle 时可执行。
- [ ] Session busy 时直接 drop。
- [ ] RemoteQueue 有显式任务时直接 drop。
- [ ] delivery 后关闭 Proactive 时 drop。
- [ ] TTL 过期时 drop。
- [ ] Proactive 永不进入 RemoteQueue。

### Context

- [ ] 第一次只观察当前 delta。
- [ ] 下一次不重复之前 seq。
- [ ] cursor `/resume` 后恢复。
- [ ] silent 仍推进 cursor。
- [ ] stale/drop 后如果 Session 已经观察过消息，cursor 仍保持已读状态。

### Freshness

- [ ] 无新消息直接 publish。
- [ ] 有新消息调用 DeepSeek freshness。
- [ ] 已有人回答时 drop。
- [ ] 新消息不影响回答时 publish。
- [ ] Freshness provider 失败时 drop。

## 19. 真实验收

准备至少三个 Pi Session：

```text
Backend-Pi
Description: 负责 Broker、SQLite、Node.js 和消息协议
Proactive: ON

Frontend-Pi
Description: 负责 TUI、交互和前端
Proactive: ON

Research-Pi
Description: 负责文档、调研和资料搜索
Proactive: OFF
```

验收：

- [ ] 后端问题优先选择 Backend-Pi。
- [ ] UI 问题优先选择 Frontend-Pi。
- [ ] Research-Pi 关闭时即使最相关也不能被主动选择。
- [ ] 打开 Research-Pi 后，相同类型问题可以选择它。
- [ ] “好的”“哈哈”“没问题”等消息应返回 `NONE`。
- [ ] 多个 Agent 同时相关时仍最多唤醒一个。
- [ ] 被选 Agent 在 Router 期间变 busy 时不唤醒第二名。
- [ ] Agent 思考期间讨论已解决时，旧回答不会迟到广播。
- [ ] DeepSeek API 不可用时普通群聊和显式 `@Agent` 完全不受影响。

## 20. 实施顺序

1. Agent Description。
2. `proactiveEnabled` 数据模型和 TUI。
3. SQLite migration。
4. 协议升级。
5. Group seq。
6. `ProactiveRouter` + `FakeProactiveRouter`。
7. Broker candidate filter + group debounce。
8. `proactive.deliver` + Extension busy/drop 语义。
9. Group Context cursor 和 append-only Session Observation。
10. 主 Agent `NO_REPLY`。
11. DeepSeek 官方 `deepseek-v4-flash` Router provider。
12. Freshness Gate，复用 DeepSeek provider。
13. Duplicate Gate + cooldown。
14. Observability。
15. 单元/E2E 测试。
16. 三个真实 Pi Session 验收。
17. 更新 `SPECIFICATION.md`、README、领域文档和手工验收文档。

## 完成条件

- [ ] Proactive 默认关闭，只有用户明确开启的 Agent 可以被主动选择。
- [ ] 普通消息始终先正常落库和广播，Router 不阻塞群聊。
- [ ] Router 一次最多唤醒一个 Agent，也能稳定选择 `NONE`。
- [ ] 官方 `deepseek-v4-flash` 可以完成 Router 与 Freshness 判断。
- [ ] DeepSeek 失败不会影响普通群聊、显式 `@Agent` 或现有 Agent-to-Agent 功能。
- [ ] Proactive 请求忙碌时直接丢弃，不进入 `RemoteQueue`。
- [ ] Agent Group Context 按 seq 增量进入 Session，不重复注入已有群聊。
- [ ] stale / duplicate 主动回答不会迟到广播。
- [ ] Proactive 不产生自动 Agent-to-Agent 链。
- [ ] 自动测试、真实多 Session 验收和文档更新完成。

## DeepSeek 官方依据

实现时以 DeepSeek 官方 API 文档为准：

- 模型 ID：`deepseek-v4-flash`。
- OpenAI-compatible Base URL：`https://api.deepseek.com`。
- V4 Flash 支持 Thinking / Non-Thinking；本阶段 Router/Freshness 使用 Non-Thinking。
- 支持 JSON Output；请求使用 `response_format: { "type": "json_object" }`，Prompt 必须明确要求 JSON 并给出 JSON 示例。
- 官方 V4 Flash 上下文为 1M，但本阶段仍严格限制 Router 输入，避免无意义扩大成本和延迟。
