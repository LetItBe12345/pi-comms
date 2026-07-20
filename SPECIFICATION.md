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
- 只有明确 `@Agent` 的消息才注入目标 Agent。
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
- 全局可读和 Agent 持续监听所有消息。
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
- 连接必须先完成 `broker.probe` / `broker.ready` 握手，并严格匹配 `service: pi-comms` 和 `protocolVersion: 4`。
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

### 7.2 SQLite 保存

- 群组信息、群主凭证摘要、可见范围、可选的群组邀请码摘要和后台设置。
- 长期成员、成员凭证摘要、群组内名称、最后活跃时间和移出状态。
- 公开群聊消息。
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

### 7.4 禁止行为

- 不把全部群聊历史写入每个 Pi Session。
- 不把 Pi Session 当作群聊数据库。
- 不把未 `@Agent` 的普通群聊消息注入 Agent。
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
}
```

### 8.4 Message

```ts
interface Message {
  messageId: string;
  groupId: string;
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

- 阶段 15 完成后的固定协议版本为 `4`。
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

- 普通群聊消息不注入 Agent，只有明确 `@Agent` 才处理。
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

- 不注入完整群聊历史、未 `@Agent` 的普通消息和私人 Session 内容。
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
- 设置流程先选择或创建群组，再填写用户名称和 Agent 名称；列表显示友好的在线人数，不显示 Broker、端点或 Session 技术词。
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
- SQLite 保留全部公开消息；加入群组时按时间正序返回最近 100 条。
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
