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
- Agent 连续自动通信最多 10 轮。
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
- 创建或加入群组。
- 显示群组、成员、公开消息和发送状态。
- 输入普通文本和 `@` 消息。
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
  text: string;
  mentionIds: string[];
  timestamp: number;
  status: string;
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
  senderId: string;
  targetAgentId: string;
  text: string;
  chainId: string;
  round: number;
}
```

## 9. 协议

### 9.1 Client → Broker

- `client.hello`
- `client.goodbye`
- `join`
- `leave`
- `chat.send`
- `agent.deliver.ack`
- `agent.result`
- `permission.update`
- `request.approve`
- `request.reject`

### 9.2 Broker → Client

- `snapshot`
- `chat.message`
- `presence.changed`
- `agent.deliver`
- `agent.result.ack`
- `request.pending`
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
- 同一群内所有显示名称唯一，用户名称和 Agent 名称之间也不能重复。
- 名称冲突时禁止加入。
- 名称只用于显示和 `@`；内部路由只使用 ID。
- 名称长度为 1～24 个字符。
- 名称只允许中文、英文、数字、`_` 和 `-`，不允许空格。
- 一个连接同时注册一个用户成员和一个 Agent 成员。
- Session 关闭时两个成员同时离线。

## 11. Agent 消息规则

### 11.1 接收和注入

- 普通群聊消息不注入 Agent，只有明确 `@Agent` 才处理。
- 每次只注入当前消息，不注入完整群聊历史。
- 注入内容包含发送者、群名、消息正文和目标。
- 目标离线或拒绝接收时，群聊中显示失败状态。

### 11.2 接收权限

- 自动接收：默认模式，直接进入处理队列。
- 需要批准：进入待批准列表，批准后才注入。
- 禁止接收：拒绝注入并返回失败状态。

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

- Agent 回答中的 `@Agent名称` 可以触发下一次请求，消息仍公开显示。
- Broker 必须检查目标在线状态和接收权限。
- 自动通信共用一个 `chainId`，每次路由时增加轮数。
- 同一 `chainId` 最多自动通信 10 轮。
- 达到上限后停止自动注入，并在群聊中显示原因，等待用户决定。

## 12. Session 生命周期

### 12.1 `session_start`

- 初始化 Session 状态。
- 获取 Session 文件或内部标识。
- 准备 Broker 连接。
- 断线后每秒自动重连。
- 同一 Broker 实例内，使用 Session 标识恢复原 `clientId`。
- 意外断线保留 3 秒恢复窗口；正常关闭不等待。
- `snapshot` 携带 `brokerInstanceId`。实例变化时终止活动远程请求并清理旧队列；跨 Broker 重启恢复留到 SQLite 阶段。

### 12.2 `/comms`

- 检查当前模式是否支持 TUI。
- 连接或启动 Broker。
- 设置名称并创建或加入群组。
- 打开聊天界面。

### 12.3 `session_shutdown`

- 发送 `leave`。
- 让用户和 Agent 同时离线。
- 关闭 Socket。
- 清理队列和 TUI 状态。

## 13. TUI 规格

```text
顶部：群组名称和状态
侧边或顶部：在线成员
中部：公开消息
底部：单行输入框
```

- 使用 `ctx.ui.custom()` 和 `@earendil-works/pi-tui`。
- 支持中文输入法、上下滚动、Enter 发送和 Esc 退出。
- 支持 `@` 自动补全。
- 显示发送失败以及 Agent 忙碌、空闲、待批准状态。
- MVP 不支持鼠标和复杂富文本。

## 14. 持久化时机

技术验证阶段使用 Broker 内存状态，不接数据库，重点验证双 Session 请求/回答闭环以及消息只回传一次。

闭环跑通后、完整 TUI 开始前接入 SQLite。群聊历史从 SQLite 读取，Agent 请求状态可从 SQLite 恢复。

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
- Agent 对 Agent 最多自动通信 10 轮。
- Session 生命周期和在线状态正确。
- 私人 Pi 对话不会泄露到群聊。

## 18. 实施原则

最重要的目标是：一个 Pi Session 能稳定、准确地向另一个 Pi Session 发送任务，并拿回唯一且正确的最终回答。

实施优先级：路由正确 → 回答对应 → 私有 Session 不泄露 → 固定 SQLite 数据边界 → 完善 TUI、权限和 Agent 对 Agent。
