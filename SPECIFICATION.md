# Pi Comms MVP Specification

本文档描述 Pi Comms MVP 的产品行为、技术约束和验收标准。具体实施任务见 [TODO 总览](./TODO/README.md)。

## 1. 产品目标

先证明以下链路稳定可用：

```text
Pi Session A
    ↓
Local Broker
    ↓
Pi Session B
    ↓
B 的 Pi Agent 处理消息
    ↓
最终回答返回 A
```

第一阶段只验证四件事：

1. A 能找到并连接 B。
2. A 的定向消息只进入 B 的 Pi Session。
3. B 的最终回答只回传一次。
4. 普通私人 Session 内容不会进入群聊。

完整 TUI、复杂群组和跨设备通信不属于第一阶段目标。

## 2. 已确认的设计决策

- 不修改 Pi 源码，也不把 Pi 仓库克隆为运行依赖。
- 使用 Pi 正式发行版，单独开发 TypeScript Extension。
- Extension 安装到 `~/.pi/agent/extensions/`，开发时通过 `/reload` 热加载。
- MVP 支持同一设备和同一普通网络中的 macOS/Linux 设备、Pi Agent 和纯文本。
- 一个 Pi Session 对应一个用户；Pi Session 保存 Agent 上下文。
- Local Broker 管理群聊状态，群聊数据集中保存在本机。
- MVP 使用 SQLite，不使用分布式数据库。
- 先打通通信闭环，再实现完整 TUI。

## 3. MVP 范围

### 3.1 必须支持

- 同一设备上的 Pi Agent。
- 同一普通网络中的多设备 Pi Agent。
- mDNS 自动发现附近群组，发现失败时使用完整邀请信息加入。
- 群主、可选的按群邀请码、长期成员和群组级附近可见范围。
- 一个 Pi Session 对应一个用户，一个用户同时只加入一个群组。
- 用户和 Agent 作为两个独立群成员出现。
- 人对人、人对 Agent、Agent 对 Agent 通信。
- 所有群聊消息公开显示。
- 显式 `@Agent` 消息注入目标 Agent；阶段 18 起，用户明确开启 Proactive 后，Broker 也可以按第 19 节主动邀请最多一个 Agent。
- Agent 忙碌时排队，不抢占当前任务。
- Agent 最终回答自动回传，且只回传一次。
- Agent 每连续自动通信 10 轮必须暂停，由原发起 Session 决定继续或结束。
- Session 关闭后，对应用户和 Agent 同时离线。

### 3.2 暂不支持

- 跨子网、公网和需要中继的通信。
- Windows。
- IPv6 和主机名连接。
- Pi 以外的 Agent Harness。
- 图片、文件和私聊。
- 全局可读和 Agent 持续监听所有消息；Proactive 只在 Broker 选中后按 `groupSeq` 增量注入公开上下文。
- 群聊摘要和上下文压缩。
- 消息优先级和多个远程请求的并行处理。

## 4. 技术栈与运行约束

- 语言：TypeScript。
- 运行时：Node.js 22.19+。
- Agent：Pi 正式发行版。
- Pi 依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。
- 通信：Node.js `node:net`、TCP 和 mDNS/DNS-SD；当前正式支持局域网 IPv4。
- 默认连接端点：`127.0.0.1:43127`。
- `0.0.0.0` 只能作为监听地址；客户端不能把它作为连接目标。
- IPv6 和主机名连接暂不支持，输入后必须给出可读提示，不能进入模糊超时。
- 连接模式分为 `local`、`lan-host` 和 `lan-client`；配置按 Pi Session 保存。
- 传输协议：JSON Lines。
- 连接必须先完成 `broker.probe` / `broker.ready` 握手，并严格匹配 `service: pi-comms` 和 `protocolVersion: 5`。
- 数据库：SQLite + `better-sqlite3`，开启 WAL 模式。
- 数据库默认路径：`~/.pi/comms/comms.db`。
- 只有 Local Broker 可以读写数据库，Extension 不直接访问数据库。
- 不引入 PostgreSQL、Redis、MongoDB 或分布式数据库。
- 测试框架：Vitest。

## 5. 总体架构

```text
Pi Session A Extension ─┐
                        ├── loopback TCP ── Local Broker ── SQLite
Pi Session B Extension ─┘

Nearby Pi Extension ─────── LAN TCP ───────┘
```

### 5.1 Pi Extension

- 注册 `/comms` 并获取当前 Session 信息。
- 连接 Broker，打开和维护群聊 TUI。
- 接收远程 Agent 请求并调用 `pi.sendUserMessage()`。
- 监听 Agent 输出，在 `agent_settled` 后回传最终回答。
- 在 `session_shutdown` 时注销成员、关闭连接并清理本地状态。

### 5.2 Local Broker

- 管理群组、在线连接、用户成员和 Agent 成员。
- 检查名称冲突，广播公开消息和成员状态。
- 解析 `@` 目标，路由 Agent 请求并返回发送状态。
- 保存消息历史、请求结果和 Agent 通信轮数。
- 统一读写 SQLite。
- 同一数据目录同时最多运行一个 Broker；数据库级原子锁负责跨进程互斥。
- 默认端口被兼容 Broker 占用时复用该 Broker；被无关服务占用时明确失败，不自动更换端口。

### 5.3 TUI

- 设置用户名称和 Agent 名称。
- 从“我的群组”“已加入”“附近群组”中选择，或创建新群组。
- 显示群组、成员、公开消息和发送状态。
- 复用 Pi Editor 的编辑和中文输入行为，输入普通文本和 `@` 消息。
- 修改 Agent 接收权限并处理待批准请求。

## 6. Session 与 TUI

进入 `/comms` 不创建新的 Pi Session，只把当前界面切换为群聊 TUI：

```text
当前 Pi Session
    ├── Agent 上下文继续存在
    ├── Extension 继续运行
    └── 界面切换为群聊 TUI
```

两类输入的流向不同：

```text
普通群聊消息 → Broker → SQLite → 所有 TUI

@Agent 消息 → Broker → 目标 Extension → 目标 Pi Session
             → Agent 回答 → Broker → SQLite → 所有 TUI
```

## 7. 数据边界

### 7.1 Pi Session 保存

- 被 `@Agent` 的任务输入。
- Agent 处理任务产生的上下文。
- Agent 的最终回答。
- 默认用户名称和 Agent 名称。
- 已加入群组的长期成员凭证和最近进入时间。
- 当前 Session 创建群组的群主凭证。
- 群组内名称覆盖和未发送草稿。
- 按 `groupId` 保存的 `proactiveEnabled`。
- Proactive 群聊观察进度 `lastSeenGroupSeq`。

### 7.2 SQLite 保存

- 群组信息、群主凭证摘要、可见范围、可选的群组邀请码摘要和后台设置。
- 长期成员、成员凭证摘要、群组内名称、最后活跃时间和移出状态。
- 每个 membership 的 Agent Description 和最后同步的 Proactive 状态。
- 公开群聊消息。
- 每群单调递增的 `groupSeq`。
- 消息状态。
- Agent 请求和结果。
- `chainId` 和通信轮数。
- 最近确认的普通网络身份和用户级自启状态。
- 默认路径为 `~/.pi/comms/comms.db`，只有 Broker 可以访问。
- 使用 WAL、`synchronous=FULL` 和 `PRAGMA user_version`。
- 不持久化在线状态、Socket 和临时队列。

### 7.3 Broker 内存保存

- 在线连接和当前在线成员。
- Socket 状态。
- 临时请求队列。
- mDNS 浏览结果、群组目录缓存和空闲关闭计时器。
- Proactive batch、Router/Freshness 调度队列、Agent cooldown、临时失败暂停和 `proactiveId` 去重记录。

### 7.4 禁止行为

- 不把全部群聊历史写入每个 Pi Session。
- 不把 Pi Session 当作群聊数据库。
- 除第 19 节的 Proactive Observation 外，不把未 `@Agent` 的普通群聊消息注入 Agent。
- 不保存模型推理过程。

## 8. 数据模型

### 8.1 Group

```ts
interface Group {
  groupId: string;
  groupName: string;
  ownerSessionKey: string;
  visibility: "local" | "nearby";
  inviteRequired: boolean;
  keepAvailableWhenEmpty: boolean;
  openAtLogin: boolean;
}
```

### 8.2 PersistentMembership

```ts
interface PersistentMembership {
  groupId: string;
  sessionKey: string;
  userName: string;
  agentName: string;
  agentDescription: string;
  proactiveEnabled: boolean;
  status: "active" | "removed";
  lastActiveAt: number;
}
```

### 8.3 Member

```ts
interface Member {
  memberId: string;
  clientId: string;
  type: "user" | "agent";
  displayName: string;
  groupId: string;
  online: boolean;
  agentDescription?: string;
}
```

### 8.4 Message

```ts
interface Message {
  messageId: string;
  groupId: string;
  groupSeq: number;
  senderId: string;
  senderName: string;
  senderType: "user" | "agent";
  text: string;
  mentionIds: string[];
  timestamp: number;
  status: "sent" | "processing" | "completed" | "failed" | "interrupted";
  failureReason?: string;
  requestId?: string;
  chainId?: string;
  round?: number;
}
```

### 8.5 AgentRequest

```ts
interface AgentRequest {
  requestId: string;
  groupId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  senderType: "user" | "agent";
  senderOwnerUserName?: string;
  targetAgentId: string;
  targetAgentName: string;
  ownerUserName: string;
  onlineMembers: Array<{
    displayName: string;
    type: "user" | "agent";
  }>;
  text: string;
  chainId: string;
  round: number;
}
```

## 9. 协议

- 阶段 18 的协议版本为 `5`。版本 4 与版本 5 不允许混用。
- 每台设备在 `~/.pi/comms/device-id` 保存稳定 UUID。
- Broker 内部使用 `JSON.stringify([deviceId, sessionId])` 作为统一 `SessionKey`。
- `clientId` 只表示当前 Broker 实例中的逻辑客户端；群成员 ID 仍基于 `clientId`。
- 单个 JSONL 帧最大为 8 MiB，超限后返回 `frame_too_large` 并关闭连接。

### 9.1 Client → Broker

- `broker.probe`
- `broker.shutdown`（仅本机生命周期管理）
- `group.catalog`
- `client.hello`
- `client.goodbye`
- `ping`
- `group.create`
- `group.join`
- `group.leave`
- `group.rename`
- `group.visibility.update`
- `group.availability.update`
- `group.invite.rotate`
- `group.member.remove`
- `group.member.allow`
- `group.owner.recover`
- `group.delete`
- `chat.send`
- `agent.deliver.ack`
- `agent.result`
- `permission.update`
- `proactive.update`
- `proactive.deliver.ack`
- `proactive.result`
- `proactive.decline`
- `broker.config.validate`（仅 Broker 本机用户）
- `broker.config.update`（仅 Broker 本机用户）
- `broker.config.delete`（仅 Broker 本机用户）
- `request.approve`
- `request.reject`
- `chain.continue`
- `chain.end`

### 9.2 Broker → Client

- `snapshot`
- `group.catalog.result`
- `client.welcome`
- `membership.welcome`
- `pong`
- `groups.changed`
- `chat.message`
- `presence.changed`
- `agent.deliver`
- `agent.result.ack`
- `proactive.deliver`
- `proactive.result.ack`
- `proactive.update.ack`
- `broker.config.status`
- `request.pending`
- `chain.paused`
- `chain.resolved`
- `send.failed`
- `error`

### 9.3 统一信封

```ts
interface Envelope<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  payload: T;
}
```

发现连接先完成 `broker.probe`，可以发送一次 `group.catalog` 并在响应后关闭。
正式连接在 3 秒内发送 `client.hello`。`client.hello` 包含
`protocolVersion`、`deviceId`、`sessionId`，以及受限群组首次加入使用的群组
邀请码或后续恢复使用的长期成员凭证。首次连接由 `client.welcome` 返回当前进程使用的
`resumeToken`；首次加入成功还返回独立长期成员凭证。

客户端每 5 秒发送 `ping`，Broker 返回带原请求 ID 的 `pong`。任一方 15 秒未
收到心跳即断开。协议不兼容时停止自动重连。

### 9.4 群组发现、连接模式与准入

- 一个数据目录只有一个权威 Broker 和一份 SQLite。
- `local`、`lan-host` 和 `lan-client` 是内部连接模式，不作为用户选择项。
- 本机群组只使用 loopback；任一群组允许附近加入时，唯一 Broker 同时服务 loopback 和局域网客户端。
- 远程客户端只连接所选附近群组对应的端点，失败时自动重连，绝不启动本机 Broker 代替远程群组。
- Broker 使用保存在 SQLite `broker_metadata` 中的稳定 `brokerId` 表示内部服务身份；每次进程启动仍生成新的 `brokerInstanceId`。
- `broker.ready` 返回 `brokerId`、`brokerInstanceId` 和运行模式。客户端保存远程 `brokerId`，同一地址身份变化时拒绝自动连接。
- 运行元数据写入数据库旁的 `comms.db.broker.json`，包含 `brokerId`、实例 ID、PID、监听地址、端口、模式和启动时间；关闭时清理，失效内容可覆盖但不删除 SQLite。
- 统一 launcher 由 `process.execPath` 启动；入口通过 `import.meta.url` 解析，不依赖 npm、Bash、软链接或平台命令名。
- mDNS 只发现内部 Broker 端点；Extension 通过只读 TCP 目录查询汇总附近群组。
- mDNS TXT 只包含 `txtvers`、协议版本、`brokerId` 和应用版本，不包含邀请码或群组目录。
- 加入前的群组目录只返回允许附近加入的群组 ID、名称、在线 Session 数和是否需要邀请码，不创建客户端身份，也不返回成员、Agent、消息或历史记录。
- 多个 Broker 的群组按 `brokerId + groupId` 汇总；同名群组并列显示，必要时用设备名称区分。
- 群组目录中的在线人数按 Pi Session 计数，用户和其 Agent 不重复计数。
- 用户界面只显示“我的群组”“已加入”和“附近群组”，不向普通用户展示 Broker、端点或“协作空间”。

### 9.5 群主、邀请与长期成员

- 群组只能由本机 Session 在本机 Broker 创建；远程客户端不能创建群组。
- 创建群组的本机 Session 成为唯一群主；阶段 15 不支持群主转让。
- 群主凭证在同一 Session 重开后恢复，`/fork` 和 `/clone` 不继承。
- 只有本机可以恢复群主管理权；恢复会使旧群主凭证失效。
- 附近群组默认允许直接加入。创建时只有明确选择“使用邀请码”，才生成该群独立的 10 位 Base32 邀请码，显示时按 `5-5` 分组。
- 完整加入信息包含端点和群组 ID；启用邀请码的群组还包含邀请码，粘贴后直接定位群组。
- 邀请码只用于受限群组的首次加入；开放群组无需邀请码。成功后都签发长期成员凭证。
- 长期成员凭证用于断线、Session 重开、Broker 重启和网络切换后的自动恢复。
- 重新生成邀请码只适用于已启用邀请码的群组，只影响新成员，不影响已有长期成员。
- 关闭附近加入时旧邀请码失效；再次开放时默认允许直接加入。
- 邀请码不自动过期，不进入 mDNS、普通日志或错误文本。
- 受限群组的邀请码缺失或错误时返回明确错误并立即关闭；同一来源 60 秒内连续失败 5 次后冷却 30 秒，成功后清零。
- 正确邀请码直接加入，不增加群主审批。
- 群主可以按稳定 Session 身份移出成员；被移出成员停止重连并需要群主解除阻止。重新加入开放群组时可直接加入，受限群组仍需当前邀请码。

### 9.6 网络选择与 Broker 可用性

- 自动使用操作系统主要的非 VPN 网络，不让用户选择网卡。
- 所有附近群组共用这一普通网络，不提供按群选择网卡。
- 常见 `tun`、`tap`、`utun` 和 `wg` 接口不参与附近网络选择。
- VPN 打开或关闭不视为网络切换，不改变群组状态或网络授权。
- 切换到新的普通网络时一起暂停所有附近群组的广播和新连接，用户确认后才重新开放。
- 回到最近确认的普通网络时自动恢复附近广播和成员重连。
- 只要仍有任一成员在线，Broker 就继续运行。
- 最后一名成员离线后等待 5 分钟；若没有群组要求后台可加入，则停止附近服务。
- “无人在线时仍允许附近加入”按群组设置，默认关闭。
- “登录后自动开放”依赖上一项，默认关闭；Ubuntu 使用用户级 systemd，macOS 使用 LaunchAgent。
- 任一群组需要后台可用时 Broker 保持运行；所有群组都不需要时允许空闲退出。
- 崩溃前有在线成员或后台开放群组时自动恢复；完全空闲时不自动重启。
- 本机 Extension 检测到旧发行版 Broker 后使用当前发行版优雅重启；开发版不得静默接管发行版 Broker。

## 10. 名称与成员规则

- 用户进入前必须设置用户名称和 Agent 名称。
- 群组由 Broker 生成不可变 UUID；群名只用于显示。
- 同一 Broker 内群名唯一，英文大小写不敏感；空群持久化，直到群主解散。
- 同一群内所有显示名称唯一，用户名称和 Agent 名称之间也不能重复。
- 英文名称比较不区分大小写，显示时保留原写法。
- 名称冲突时禁止加入。
- 名称只用于显示和 `@`；内部路由只使用 ID。
- 名称长度为 1～24 个字符。
- 名称只允许中文、英文、数字、`_` 和 `-`，不允许空格。
- 一个连接同时注册一个用户成员和一个 Agent 成员。
- 成员 ID 分别为 `user:<clientId>` 和 `agent:<clientId>`。
- 一个 Session 同时只能加入一个群组，切换前必须先离开。
- 消息、成员事件和失败状态只广播到所属群组。
- 断线或 Session 关闭时用户和 Agent 同时离线，但长期成员关系和名称继续保留。
- 关闭群聊只离线；显式“退出群组”才删除长期成员身份并释放名称。
- 群主不能退出自己的群组，只能解散。
- 群主用户名显示 `[群主]`；管理权不附着在对应 Agent 上。
- 群主可以改名、管理附近加入、为受限群组轮换邀请码、移出成员和解散群组。
- 群组改名不改变群组 ID、邀请码、成员和历史，并追加一条公开系统消息。
- 解散群组永久删除该群邀请、成员、消息和 Agent 请求，不影响其他群组。

## 11. Agent 消息规则

### 11.1 接收和注入

- 默认情况下普通群聊消息不注入 Agent，只有明确 `@Agent` 才处理。用户开启 Proactive 后，按第 19 节的独立协议注入增量公开上下文。
- 每次只注入当前消息，不注入完整群聊历史。
- `@用户名称` 只公开提醒；`@Agent名称` 同时注入目标 Session。
- 只识别消息开头的一个 `@名称`，内部使用成员 ID 路由。
- 注入内容包含接收方身份、所属用户、发送者、群名、在线成员和消息正文。
- 在线成员不包含接收方自己；正文移除开头的 `@Agent名称` 后保持原样。
- 第 2 轮起注明自动对话轮数。
- 注入格式固定为：

```text
[Pi Comms 群聊请求]
你是：{targetAgentName}（Agent）
所属用户：{ownerUserName}
来自：{senderName}  群组：{groupName}
在线：Alice(用户)、Bob-Pi(Agent)

{消息正文}

你的回答会作为公开消息发送到群组「{groupName}」，用于回应 {senderName}。请直接回答。
```

- 显式请求不注入完整群聊历史、未 `@Agent` 的普通消息和私人 Session 内容。Proactive 只注入第 19 节定义的增量公开消息。
- 目标离线或拒绝接收时，群聊中显示失败状态。

### 11.2 接收权限

- 自动接收：默认模式，直接进入处理队列。
- 需要批准：进入待批准列表，批准后才注入。
- 禁止接收：拒绝注入并返回失败状态。
- 权限属于当前 Pi Session 的 Agent，不按群组区分；同一 Session 恢复或分支时保留，新 Session 使用默认值。
- Extension 使用 `appendEntry()` 保存权限，并在 `client.hello` 中同步；Broker 先应用权限，再把 Agent 标记在线。
- 权限变化只影响之后的新请求，已有待批准请求仍需逐条批准或拒绝。
- 待批准请求不自动超时；短暂断线 3 秒内保留，离群、退出、超时断线或 Broker 重启后失效。
- 批准后请求进入现有串行队列，不抢占当前任务；重复批准或拒绝不得重复注入或广播。
- 群成员可看到 Agent 权限、待批准数量及请求状态，但只有所属 Session 可以修改权限和处理审批。
- TUI 通过 `Ctrl+P` 打开 Agent 控制面板，包括权限、待批准请求和待决定自动对话。
- 禁止、拒绝和失效直接更新原公开消息状态，不额外发布系统消息。

### 11.3 队列和最终回答

每个 Extension 维护：

```ts
remoteQueue: AgentRequest[];
activeRequest: AgentRequest | null;
lastAssistantText: string | null;
pendingResults: Map<string, AgentResult>;
seenRequestIds: Set<string>;
```

- Agent 空闲时立即处理；忙碌时入队，不抢占当前任务。
- 每次只处理一个远程请求。
- `message_end` 保存最后一个 Assistant 文本。
- `agent_settled` 后回传结果，再处理下一条队列。
- 只有存在 `activeRequest` 时才广播回答。
- `requestId` 必须让请求与回答一一对应。
- 请求进入队列后发送 `agent.deliver.ack`；重复请求只确认，不再次入队。
- 回答保留到收到 `agent.result.ack`；未确认回答在重连后继续发送。
- Broker 对重复回答只确认一次接收状态，不再次公开广播。
- 普通用户与 Pi 的私人对话不得进入群聊。

### 11.4 Agent 对 Agent

- 只解析 Agent 最终回答开头的一个 `@名称`；允许前置空格和空行，不解析 Markdown 包裹或正文中间的 `@`。
- `@Agent` 后必须有正文；`@` 自己、空正文和不存在的目标只公开回答并显示原因，不增加轮数。
- `@用户` 只公开提醒并结束自动通信；`@Agent` 触发下一次请求，原回答始终完整公开。
- 发送者是作出回答的 Agent；注入内容同时注明目标 Agent 和发送方 Agent 各自的所属用户。
- 新的人类 `@Agent` 请求生成新 `chainId` 并计为第 1 轮；后续请求沿用 `chainId`，每次成功创建路由时增加轮数。
- 通信链可以经过任意数量 Agent；每个目标继续使用现有 FIFO 串行队列。
- Proactive Agent 的成功公开回答如果以有效 `@Agent` 开头，也按本节创建下一跳。该链的初始决策 Session 是最初被 Broker 主动选中的 Agent 所属 Session。
- 每次自动路由都重新检查目标在线状态和接收权限；离线、禁止、拒绝或执行失败时停止且不重试。
- 初始额度为 10 轮；第 10 轮回答仍公开，但其中准备触发的第 11 轮请求暂停。
- 只有最初发起请求的 Pi Session 可以通过 `Ctrl+P` 继续或结束；继续时沿用 `chainId` 和轮数，每次增加 10 轮额度并再次检查目标状态与权限。
- 暂停决定写入 SQLite，不自动过期；只在原群组显示，Broker 重启后恢复。
- TUI 显示轮数、下一目标和路由状态，不直接显示完整 `chainId`；继续和结束决定公开显示。

## 12. Session 生命周期

### 12.1 `session_start`

- 初始化 Session 状态。
- 获取 Session 文件或内部标识。
- 不在进入群聊前连接 Broker，也不把用户和 Agent 标记为在线。
- 恢复默认名称、长期成员凭证、群主凭证和最近进入群组。
- 断线后自动重连；短暂断线优先使用 `resumeToken`，跨进程和长期恢复使用长期成员凭证。
- 成员恢复不要求重新输入邀请码。
- `snapshot` 携带 `brokerInstanceId`。实例变化时终止活动远程请求、清理旧队列，并使用长期成员凭证恢复群组。
- `/fork` 和 `/clone` 不继承群主凭证。
- 进入 `/comms` 前不建立群聊连接，但开启登录后自动开放的本机 Broker 可以独立运行。

### 12.2 `/comms`

- 检查当前模式是否支持 TUI。
- 首屏固定显示“我的群组”“已加入”“附近群组”，不提供 Broker 或“协作空间”选择。
- “我的群组”和“已加入”立即显示；附近群组异步发现和实时更新。
- 创建群组时先输入群名，再无默认项地明确选择“允许附近设备加入”或“仅这台电脑”。
- 用户选择开放的附近群组后直接加入；只有群组明确要求邀请码时才显示短邀请码输入框。完整加入信息可以直接定位群组。
- 默认名称自动填入，只有群内名称冲突时才要求修改。
- 首次加入成功后保存长期成员凭证并直接进入群聊。
- 点击离线的已加入群组仍进入聊天界面，自动等待恢复，不提供手动重试菜单。
- 本机 Broker 不存在时按群组需要启动；远程连接失败时绝不启动本机 Broker 替代。
- 本机 Broker 意外退出时按在线成员和后台设置决定是否恢复，并从 SQLite 恢复持久化状态。
- 打开聊天界面。
- 退出聊天时断开当前客户端，但不关闭供其他 Session 使用的 Broker。

### 12.3 `session_shutdown`

- 发送 `client.goodbye`；只有用户明确选择“退出群组”时才发送 `group.leave`。
- 让用户和 Agent 同时离线。
- 关闭 Socket。
- 清理队列和 TUI 状态。
- 保留长期成员、群主、名称和最近群组状态。

## 13. TUI 规格

群组首屏：

```text
我的群组
已加入
附近群组
创建群组 · 使用邀请信息加入
```

群聊：

```text
顶部：固定群组名称
中部：完整追加式公开消息时间线
底部：Pi 多行 Editor
底部：连接、在线人数、Agent 忙碌数、权限和待处理数量
```

- 使用 `ctx.ui.custom()` 和 `@earendil-works/pi-tui`。
- 群组首屏按“我的群组”“已加入”“附近群组”分区；同一群组只显示一次。
- “我的群组”和“已加入”按最近进入时间排序；附近群组按名称排序，人数变化不改变位置。
- 打开首屏不等待发现；附近区域先显示“正在查找附近群组…”，无结果时显示可执行的空状态。
- 创建群组时依次填写用户名称、Agent 名称、Agent Description、群组名称和加入方式，再检查 Broker Router 配置，最后写入群组。加入现有群组也必须填写 Description。列表显示友好的在线人数，不显示 Broker、端点或 Session 技术词。
- 当前 Pi Session 内缓存上次名称；首次填写用户名后，Agent 名称默认使用 `用户名-Pi`。
- 消息按日期分隔并显示本地时间；当前用户消息在右，其余用户和所有 Agent 消息在左，Agent 带固定 `[Agent]` 标签。
- 初次进入加载 SQLite 返回的最近 100 条消息；在线期间新消息只追加、不截断，退出后释放内存，不提供加载更多。
- 同一发送者两分钟内的相邻消息只在第一条显示名称和时间；日期变化、系统消息或发送者变化时重新显示。
- 用户消息最大宽度为终端的 70%，Agent 消息为 85%；小于 60 列时统一为 94%，消息块最小宽度为 12 列。
- 用户消息按纯文本显示；Agent 消息复用 Pi Markdown、主题和文本换行能力。
- 使用 Pi Editor 默认键位：Enter 发送，Shift+Enter 或 Ctrl+J 换行，并保留多行粘贴。
- 不实现自定义滚动，`ChatView` 始终返回当前内存中的完整 timeline，由终端原生 scrollback 查看旧消息。
- 普通消息追加、输入和底部状态变化不得清空终端 scrollback；窗口缩放、断线重连快照、控制面板和退出确认允许完整重绘。
- `@` 只补全在线群成员；`@用户` 公开提醒，`@Agent` 注入目标 Session。
- 群聊输入中的 `/` 和 `!` 是普通文字，不执行 Pi 命令或 Shell。
- 使用 Pi 当前主题和文字标签显示连接、处理中和失败状态，不只依赖颜色。
- 群主用户名显示 `[群主]`，对应 Agent 不显示群主标签。
- 群主显示 `Ctrl+G 群组管理`，普通成员显示 `Ctrl+G 群组信息`；所有人显示 `Ctrl+P Agent 控制`、`Esc 返回`和 `? 全部快捷键`。
- 狭窄终端可以收起次要快捷键，但必须保留动作名称和完整帮助入口。
- 群主管理使用分层菜单：群组设置、附近加入、成员管理和危险操作。
- Broker 本机用户在 `/comms` 首页可以打开“Broker 设置”，配置、验证、更换或删除 DeepSeek API Key。远程客户端不显示该入口。
- Agent 控制面板把“被 `@` 时”和“主动参与”分开。其他群成员不能看到该 Agent 的 Proactive 开关。
- 在“我的群组”中无需进入群聊即可打开群组管理。
- 危险操作不提供单键快捷键，并要求二次确认。
- Agent 在执行任务或队列非空时显示忙碌，否则显示空闲；忙碌状态只在底部汇总，不修改历史消息标题。
- 断线时保留草稿，禁止发送并自动重连；离线群组显示“群组暂时离线，正在等待恢复…”。消息按 ID 去重。
- Broker 确认消息写入 SQLite 后才清空输入；失败时保留输入。
- Esc 在设置流程中返回上一步；聊天中有草稿或活动请求时确认退出，否则直接退出。
- 成员断线后显示离线但继续保留长期成员身份。其他会话的用户和 Agent 加入、离开合并为一条居中系统消息，不写入 SQLite，当前会话不显示自己的加入提示。
- 附近状态使用“附近设备可以加入”“无人在线，5 分钟后停止开放”“已停止向附近设备开放”“正在重新开放…”“当前网络无法连接附近设备”“仅这台电脑可以使用”。
- 动态请求状态只显示在最新消息下方。较旧请求晚到的失败、拒绝或失效结果在底部追加系统消息，不回改旧行；重新进入时可显示 SQLite 中已有的最终失败状态。
- 布局随终端宽高自适应，不因窗口较小而阻止聊天。
- MVP 不支持鼠标和复杂富文本。

## 14. 持久化时机

技术验证阶段使用 Broker 内存状态，不接数据库，重点验证双 Session 请求/回答闭环以及消息只回传一次。

闭环跑通后、完整 TUI 开始前接入 SQLite。群聊历史从 SQLite 读取，Agent 请求状态可从 SQLite 恢复。

- 消息写入成功后才能广播。
- `@Agent` 公开消息与请求记录必须在同一事务中写入。
- Agent 回答、请求完成状态和原消息状态必须在同一事务中写入。
- Agent 回答和由它触发的下一请求或暂停状态必须在同一事务中写入。
- SQLite 保留全部公开消息；加入群组时按 `groupSeq ASC` 返回最近 100 条。`timestamp` 只用于显示时间。
- Broker 重启时，`pending` 和 `delivered` 请求改为 `interrupted`，不自动重试。
- 达到轮数上限的暂停链保留；重启后仍只允许原发起 Pi Session 继续或结束。
- Broker 或 Pi 重启后，Extension 使用长期成员凭证恢复原群组和名称；不重新要求邀请码。
- `agent_requests.initiator_session_key` 和 `paused_chains.initiator_session_key` 保存稳定 `SessionKey`。
- 数据库无法打开或迁移失败时，Broker 启动失败，不自动重建数据库。

## 15. 目标项目结构

```text
pi-comms/
├── package.json
├── tsconfig.json
├── src/
│   ├── protocol.ts
│   ├── types.ts
│   ├── extension/
│   │   ├── index.ts
│   │   ├── broker-client.ts
│   │   ├── agent-bridge.ts
│   │   ├── remote-queue.ts
│   │   └── session-state.ts
│   ├── broker/
│   │   ├── server.ts
│   │   ├── group-state.ts
│   │   ├── router.ts
│   │   ├── launcher.ts
│   │   ├── store.ts
│   │   └── database.ts
│   ├── discovery/
│   │   ├── types.ts
│   │   ├── bonjour-discovery.ts
│   │   └── group-catalog.ts
│   └── tui/
│       ├── group-picker.ts
│       ├── group-management.ts
│       └── chat-view.ts
└── tests/
    ├── protocol.test.ts
    ├── discovery.test.ts
    ├── group-catalog.test.ts
    ├── group-membership.test.ts
    └── broker-lifecycle.test.ts
```

## 16. 首个验收场景

在两个终端分别启动 Pi 并加载 Extension。A 发送：

```text
@B-Pi 检查当前项目的 package.json
```

必须满足：

- A 和 B 都能看到公开消息。
- 消息只进入 B 的 Pi Session。
- B 忙碌时消息进入队列。
- B 的最终回答只回传一次，并能对应原始请求。
- A 能看到 B 的回答。
- B 退出后，B 用户和 B-Pi 同时离线。
- 离线目标收不到消息，失败状态公开显示。

## 17. MVP 完成定义

- macOS 和 Linux 上的多个 Pi Session 可以稳定加入同一群组。
- `/comms` 可以显示“我的群组”“已加入”“附近群组”，不要求用户理解 Broker。
- 每个群组拥有独立群主、可选邀请码、长期成员和附近可见范围。
- mDNS 不可用时仍能通过完整邀请信息加入。
- VPN 开关不改变群组状态；新普通网络未经确认不会广播群组。
- Broker 空闲、后台保持、自启、崩溃恢复和发行版升级行为正确。
- 用户和 Agent 显示为独立成员，所有名称唯一。
- 普通消息公开广播。
- `@Agent` 消息只注入目标 Session。
- Agent 最终回答公开且只回传一次。
- Agent 忙碌时按顺序处理请求。
- 三种接收权限可用。
- Agent 对 Agent 每连续通信 10 轮必须暂停，未经原发起 Session 确认不得进入下一轮。
- Session 生命周期和在线状态正确。
- 私人 Pi 对话不会泄露到群聊。

## 18. 实施原则

最重要的目标是：一个 Pi Session 能稳定、准确地向另一个 Pi Session 发送任务，并拿回唯一且正确的最终回答。

实施优先级：路由正确 → 回答对应 → 私有 Session 不泄露 → 固定 SQLite 数据边界 → 完善 TUI、权限和 Agent 对 Agent。

## 19. Proactive Agent Participation

本节定义阶段 18 的最终产品和协议行为。完整设计选择及原因见 [阶段 18 决策记录](./TODO/decision/18-proactive-agent-participation.md)。

### 19.1 Agent Description 与授权

- 创建或加入群组时必须填写 Agent Description。程序自动 trim，将换行和连续空白合并为一个空格，并自动截断到 240 个字符；处理后为空才要求重新填写。
- Description 属于当前 Pi Session 在当前群的 membership。加入后不可编辑；只有主动离群并重新加入时才能重新填写。
- Description 对已入群成员公开，离线后继续可见。附近发现、完整邀请信息和未入群客户端不得获得成员 Description。
- 旧 membership 缺少 Description 时不自动从 cwd、仓库名或 `AGENTS.md` 生成。用户下次打开 `/comms` 补填前保持未入群。
- Proactive 是独立于 `AgentPermission` 的布尔开关，默认开启。每个 Session 按 `groupId` 保存自己的开关；首次加入新群时开启，恢复同一群时恢复该群原值。
- 开关只由对应 Pi Session 的控制用户修改。Broker 所有者、群主、其他用户和其他 Agent 都不得代为开启或关闭。
- 其他群成员不得在 Snapshot、presence 或 TUI 中获得 `proactiveEnabled`。Agent 主人可以看自己的值，Broker 内部保留真实值。
- Extension 切换开关时先写 Session custom entry，再发送 `proactive.update`。Broker 拒绝时返回原因，Extension 回滚本地值和 UI。重连时以 Session custom entry 为准，缺失时按 `true`。已明确保存的 `false` 必须继续保持关闭。
- fork 或 clone 出的新 Pi Session 不继承 membership、Description 或 Proactive 开关。

### 19.2 Broker 模型与本机配置

- Broker Router 和 Freshness 默认且只使用 DeepSeek 官方 `deepseek-v4-flash`。Base URL 固定为 `https://api.deepseek.com`，不允许自定义模型或中转 endpoint。
- Pi Session 自己的模型与 Broker 模型严格分开。Pi Comms 不读取、修改或复用 Session 的模型配置和 Key。
- DeepSeek API Key 由 Broker 本机用户提供并承担费用，只保存在 `~/.pi/comms/config.json`。文件使用临时文件原子替换，macOS/Linux 权限为 `0600`。
- 本机设置页可以配置、验证、更换、删除 Key。保存后只显示 `****abcd` 形式的遮罩值，不提供完整值回显。远程客户端不显示设置入口。
- 首次建群可以配置或跳过 Key。跳过不影响普通群聊和显式 `@Agent`。`DEEPSEEK_API_KEY` 只作为配置文件为空时的首次迁移来源，必须经本机用户确认。
- Key 保存前使用最小 `deepseek-v4-flash` 请求验证 Key、账户和模型权限。首次配置遇到网络故障可保存为未验证，但不能启用 Proactive；已有有效 Key 时不得用未验证新 Key 覆盖。
- 更换 Key 先验证新值，成功后再替换。删除 Key 立即取消在途 Router/Freshness HTTP 请求，但不强制中止已进入 Pi Session 的生成。
- Broker 使用 `ready | unconfigured | unverified | invalid_key | temporarily_unavailable | config_error` 表示 Proactive 能力。开关状态与 Broker 能力状态分开保存；任何状态都允许开启或关闭，但仅 `ready` 实际调用 Router。
- `401/403` 把 Key 持久化标记为无效。未验证 Key 每次 Broker 启动时自动验证一次，设置页也提供手动重新验证。
- 配置文件损坏或不可读时进入 `config_error`。重建配置前把旧文件重命名为带时间戳的 `0600` 备份，不自动删除。
- 日志、错误、Snapshot 和协议回复不得包含完整 Key。

### 19.3 触发、候选与调度

- 只有新的普通人类公开消息创建 Proactive batch。消息开头的显式 `@Agent` 跳过 Router；`@人类`、正文中间的 `@Agent`、短消息和寒暄仍交给 Router 判断。
- Agent 公开消息、系统通知、成员变化、权限变化和错误消息不创建 batch。
- 没有 eligible Agent 时不调用模型。开启开关、上线、变为 idle 或 cooldown 到期都不追溯触发旧消息；必须等下一条新人类消息。
- Router 每次调用前从当前 GroupState 实时构建候选。候选必须同时满足 `type=agent`、online、idle、`proactiveEnabled=true`且不在 cooldown。
- 未入选、关闭、busy、offline 或 cooldown 中 Agent 的 Description 不得发送给 DeepSeek。候选不设数量上限。
- 每次 Router 最多选择一个 Agent，也可以返回 `null`。同一群不限制只有一个活跃 Proactive：后续 batch 可以选择另一个 idle Agent，多个 Session 可以并行生成。
- 每群第一条消息启动 batch；后续消息把 debounce 延后到最后一条后 800ms，但从第一条起最多等 2 秒。每群 Router 请求开始时间间隔不少于 5 秒。
- 整个 Broker 同时只运行一个 DeepSeek 请求。用户发起的 Key 验证优先，其次是 Freshness，最后是 Router。多群 Router 按 round-robin 调度，多个 Freshness 按结果到达时间 FIFO。
- Router 输入只包含最近 20 条人类或 Agent 公开文本，按 `groupSeq` 去重排序；超出部分标记省略。候选为 `{ agentId, name, description }`。
- Router Prompt 要求只在能回答未解决问题、纠正重要错误、补充缺失专业知识或明显推进讨论时选择 Agent；寒暄、附和、重复和无实质内容应返回 `null`。
- Router 返回后再次检查目标的当前授权、online、idle 和 membership。不再满足时丢弃，不改选第二名。

### 19.4 DeepSeek Provider

- Router 和 Freshness 都使用 Chat Completions JSON Output：`thinking: { type: "disabled" }`、`response_format: { type: "json_object" }`、`temperature: 0`、`max_tokens: 128`、`stream: false`。
- Router 和 Freshness Prompt 版本分别为 `router-v1` 和 `freshness-v1`。Prompt 必须明确包含 `json` 字样和合法 JSON 示例。
- Router 只要求 `{ "targetAgentId": "agent:..." }` 或 `{ "targetAgentId": null }`。Freshness 只要求 `{ "publish": true }` 或 `{ "publish": false }`。`reason` 可选、忽略且不记录。
- Provider 只接受纯 JSON。Markdown 代码块不自动剥离。`targetAgentId` 必须是当前 eligible ID 或 `null`；`"NONE"`、空字符串和缺少字段都非法。`publish` 必须是 JSON 布尔值。未知顶层字段允许并忽略。
- 网络错误、3 秒超时、`429` 和 `5xx` 最多共请求 3 次。两次重试分别 full jitter `0～500ms` 和 `0～1000ms`；`Retry-After` 优先，单次最多等 5 秒。
- `400`、`401/403`、空内容、非法 JSON 和未知 Agent ID 不重试。一组重试耗尽后 Broker 全局暂停 30 秒；暂停只存内存，Broker 重启后清空。
- Router 每次重试前重建候选和最新消息 batch。Freshness 每次重试前重新读取最新公开消息，候选回答保持不变。
- Router/Freshness 不写 SQLite。结构化日志可以记录 Prompt 版本、目标 ID、结果类型、错误码和耗时，不记录完整 Prompt、群聊副本、reasoning 或 `reason`。

### 19.5 Delivery 与 Session 行为

- `proactive.deliver` 从 Broker 创建起 10 秒内有效，不重发。无 ACK 时 TTL 到期后清理。Proactive 不进入 `RemoteQueue`。
- Extension 注入前最后检查本地 `proactiveEnabled`、`context.isIdle()`、活动显式任务、待批准请求和 TTL。任一不满足就 `proactive.decline`，不进 cooldown。
- Broker 发送 delivery 前把当前最新公开消息补入 Observation。负载同时记录 Router 的 `triggerFromSeq/triggerToSeq` 和 Agent 实际看到的 `observedToSeq`。
- 每个 Session/群组持久化 `lastSeenGroupSeq`。未观察增量不超过 20 条时全量注入；超过时只注入最近约 12 条并标记前文省略。
- Observation 使用 `pi.sendUserMessage()` 追加到真实 Session History。每条消息使用 `#seq [user|agent] Name: text` 格式。注入成功后立即持久化 `lastSeenGroupSeq=observedToSeq`；后续中断不回滚，注入失败不推进。
- Pi Comms 稳定提示词只在 Session 已入群时注入，包含 Agent 群聊名称、Description 和两种触发方式。显式请求使用 `[Pi Comms Remote Request]`，主动邀请使用 `[Pi Comms Proactive Invitation]`。
- Proactive 与显式请求都可以使用工具、修改本地项目和运行测试。Proactive Prompt 明确禁止主动 `git push`、创建 PR、发布 Release、发邮件或其他外部写操作；该限制只由 Prompt 约束，不做工具层拦截。
- Proactive Agent 可以通过最终文本 `[PI_COMMS_NO_REPLY]` 保持沉默。Extension 使用 `text.trim()` 后做完整相等比较，不接受 Markdown 包裹或附加说明。只要使用过工具或修改过本地状态，Prompt 必须要求生成正常最终回答而不得沉默。
- Proactive 生成不设独立硬超时。本机用户输入、新的显式 `@Agent` 请求、关闭 Proactive、主动离群、群解散或 Broker 断线会立即取消。显式请求进入现有队列并优先处理。
- 中断不回滚已经发生的本地修改。Extension 在 Session 本地提示可能存在未完成修改，群聊不发布残缺回答。
- 关闭 `/comms` TUI 不停止 Proactive；只要 Session 仍在群且开关为开启，就继续作为候选。

### 19.6 结果、Freshness、Duplicate 和 Cooldown

- Extension 只回传 Pi Session 的最后一条 Assistant 文本，处理方式与显式请求一致。`proactive.result` 不持久化、无 ACK 时不重发。
- Broker 在内存中保留已完成 `proactiveId` 10 分钟。重复结果只回 ACK，不再发布；Broker 重启后清空。
- Broker 收到正常结果或 `silent` 时立即从当前时间开始 30 秒 cooldown，在 Duplicate/Freshness 前就移出候选。发布、沉默或被 Freshness 丢弃都进 cooldown；拒绝、过期或中断不进。cooldown 只存内存。
- 先对当前群最近 20 条 Agent 回答做 exact duplicate：trim 并统一连续空白后完全相等就丢弃，不调用 Freshness，不创建下一跳，但仍进 cooldown。
- Agent 实际观察后没有新的人类或 Agent 公开文本时直接发布。有新文本时调用 Freshness，输入原始触发、完整候选回答和最近 20 条新消息；更早新消息标记省略。
- Freshness 失败、暂停期、超时、限流、空内容或非法结果均 fail closed，不发布。被丢弃后不向群聊或 Session 本地额外发送通知。
- 多个 Agent 并行完成时按结果到达顺序处理。先发布的回答写入新 `groupSeq`，并进入后续回答的 Freshness 上下文。
- Proactive 结果只有通过 Duplicate/Freshness 并成功公开写入后，才解析开头的一个 `@Agent` 并创建现有 Agent-to-Agent 下一跳。目标按现有权限、FIFO 队列和 10 轮暂停规则处理，不传播 `chainOrigin`。
- Proactive 发起的链达到轮数上限后，由最初被 Broker 选中的 Agent 所属 Session 决定继续或结束。
- 群聊不显示“主动”标记、选择理由、处理中提示、沉默、Proactive 失败或丢弃通知。只显示成功发布的普通 Agent 回答。

### 19.7 `groupSeq` 与数据恢复

- 每群公开消息使用从 1 开始的单调 `groupSeq`，SQLite 对 `(group_id, group_seq)` 建唯一索引。Snapshot、history 和 TUI 统一按 `groupSeq ASC` 排序，timestamp 只用于显示。
- 旧消息在一个事务中按每群 `timestamp ASC, rowid ASC` 补齐 seq，再建立唯一索引。
- 新建 SQLite 数据库的 `group_memberships` 使用 `agent_description TEXT NOT NULL DEFAULT ''` 和 `proactive_enabled INTEGER NOT NULL DEFAULT 1`。从旧数据库增加该列时仍使用 `DEFAULT 0`，避免迁移过程直接改写旧成员；对应 Session 重连后，以 Session custom entry 为准，缺失时同步新的默认值 `true`。
- Broker membership 是已入群 Description 的权威来源；Session custom entry 是重连时 Proactive 开关的权威来源。

### 19.8 测试与验收

- CI 只使用 Fake Router 或本地 HTTP mock，不读取真实 DeepSeek Key，不调用真实 API。
- 自动测试必须覆盖 Description 规范化与恢复、状态隐藏、老 DB 迁移、协议 v5、实时候选、debounce、round-robin、并行结果、中断、cursor、Duplicate、Freshness、cooldown、重试、暂停、Key 生命周期和 Agent-to-Agent。
- 真实 API 只用于人工验收。验收使用三个彼此独立的一次性仓库和本地 bare Git remote，不连接 GitHub，不在真实工作仓库执行主动修改。
- 真实验收必须验证：后端/UI 问题选中对应 Agent；关闭的 Agent 不进候选；寒暄返回 `null`；多 Agent 可并行；过时和重复回答不发布；Proactive 可修改本地但不主动 push；显式 `@Agent` 不受 Router 故障影响。

DeepSeek 实现以官方文档为准：

- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [JSON Output](https://api-docs.deepseek.com/guides/json_mode)
