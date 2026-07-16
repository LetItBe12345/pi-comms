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
- MVP 只支持单设备、Pi Agent 和纯文本。
- 一个 Pi Session 对应一个用户；Pi Session 保存 Agent 上下文。
- Local Broker 管理群聊状态，群聊数据集中保存在本机。
- MVP 使用 SQLite，不使用分布式数据库。
- 先打通通信闭环，再实现完整 TUI。

## 3. MVP 范围

### 3.1 必须支持

- 同一设备上的 Pi Agent。
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

- 跨设备通信和局域网发现。
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
- 本地通信：Node.js `node:net` 和 Unix Domain Socket。
- Socket 默认路径：`~/.pi/comms/broker.sock`。
- 传输协议：JSON Lines。
- 数据库：SQLite + `better-sqlite3`，开启 WAL 模式。
- 数据库默认路径：`~/.pi/comms/comms.db`。
- 只有 Local Broker 可以读写数据库，Extension 不直接访问数据库。
- 不引入 PostgreSQL、Redis、MongoDB 或分布式数据库。
- 测试框架：Vitest。

## 5. 总体架构

```text
Pi Session A Extension ─┐
                        ├── Unix Socket ── Local Broker ── SQLite
Pi Session B Extension ─┘
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

### 5.3 TUI

- 设置用户名称和 Agent 名称。
- 创建群组，或从本机已有群组列表加入群组。
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

### 7.2 SQLite 保存

- 群组信息和公开群聊消息。
- 消息状态。
- Agent 请求和结果。
- `chainId` 和通信轮数。
- 默认路径为 `~/.pi/comms/comms.db`，只有 Broker 可以访问。
- 使用 WAL、`synchronous=FULL` 和 `PRAGMA user_version`。
- 不持久化成员关系、在线状态、Socket 和临时队列。

### 7.3 Broker 内存保存

- 在线连接和当前在线成员。
- Socket 状态。
- 临时请求队列。

### 7.4 禁止行为

- 不把全部群聊历史写入每个 Pi Session。
- 不把 Pi Session 当作群聊数据库。
- 不把未 `@Agent` 的普通群聊消息注入 Agent。
- 不保存模型推理过程。

## 8. 数据模型

### 8.1 Member

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

### 8.2 Message

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

### 8.3 AgentRequest

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

### 9.1 Client → Broker

- `client.hello`
- `client.goodbye`
- `group.create`
- `group.join`
- `group.leave`
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

## 10. 名称与成员规则

- 用户进入前必须设置用户名称和 Agent 名称。
- 群组由 Broker 生成不可变 UUID；群名只用于显示。
- 同一 Broker 内群名唯一，英文大小写不敏感；空群保留到 Broker 重启。
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
- 意外断线时两个成员立即离线，名称保留 3 秒；超时后移除。
- Session 关闭时两个成员同时离线。

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
- 断线后每秒自动重连。
- 同一 Broker 实例内，使用 Session 标识恢复原 `clientId`。
- 意外断线保留 3 秒恢复窗口；正常关闭不等待。
- 3 秒内重连恢复原群组和两个成员 ID；超时后必须重新加入。
- `snapshot` 携带 `brokerInstanceId`。实例变化时终止活动远程请求并清理旧队列；跨 Broker 重启恢复留到 SQLite 阶段。

### 12.2 `/comms`

- 检查当前模式是否支持 TUI。
- 连接本机唯一的 Broker；不存在时自动启动。
- Broker 意外退出时自动启动新实例，并从 SQLite 恢复持久化状态。
- 设置名称并创建或加入群组。
- 打开聊天界面。
- 退出聊天时断开当前客户端，但不关闭供其他 Session 使用的 Broker。

### 12.3 `session_shutdown`

- 发送 `group.leave` 或 `client.goodbye`。
- 让用户和 Agent 同时离线。
- 关闭 Socket。
- 清理队列和 TUI 状态。

## 13. TUI 规格

```text
顶部：群组名称和状态
顶部：在线成员
中部：公开消息
底部：Pi 多行 Editor
```

- 使用 `ctx.ui.custom()` 和 `@earendil-works/pi-tui`。
- 设置流程依次填写用户名称、Agent 名称，再选择创建或从群组列表加入；列表显示友好的在线人数，不显示 Session 技术词。
- 当前 Pi Session 内缓存上次名称；首次填写用户名后，Agent 名称默认使用 `用户名-Pi`。
- 消息按日期分隔并显示本地时间；当前用户消息在左，其余用户和 Agent 消息在右，Agent 带 `[Agent]` 标签。
- 初次进入定位到 SQLite 返回的最近 100 条消息末尾，不提供加载更多。
- 使用 Pi Editor 默认键位：Enter 发送，Shift+Enter 或 Ctrl+J 换行，并保留多行粘贴。
- `Ctrl+PageUp` 和 `Ctrl+PageDown` 滚动消息；查看旧消息时不强制跳回底部。
- `@` 只补全在线群成员；`@用户` 公开提醒，`@Agent` 注入目标 Session。
- 群聊输入中的 `/` 和 `!` 是普通文字，不执行 Pi 命令或 Shell。
- 使用 Pi 当前主题和文字标签显示连接、处理中和失败状态，不只依赖颜色。
- Agent 在执行任务或队列非空时显示忙碌，否则显示空闲；待批准状态在权限阶段实现。
- 断线时保留草稿和滚动位置，禁止发送并自动重连；消息按 ID 去重。
- Broker 确认消息写入 SQLite 后才清空输入；失败时保留输入。
- Esc 在设置流程中返回上一步；聊天中有草稿或活动请求时确认退出，否则直接退出。
- 成员意外断线后显示离线，保留 3 秒；超时后移除。加入和离开提示不写入 SQLite。
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
- 仍在运行的 Extension 使用原 `clientId` 和名称自动重新加入；Pi 重启后需要手动加入。
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
│   │   ├── store.ts
│   │   └── database.ts
│   └── tui/
│       └── chat-view.ts
└── tests/
    ├── protocol.test.ts
    ├── routing.test.ts
    ├── queue.test.ts
    ├── naming.test.ts
    └── loop-limit.test.ts
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

- 两个 Pi Session 可以稳定加入同一群组。
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
