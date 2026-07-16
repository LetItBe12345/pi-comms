# 阶段 12：跨平台 TCP 传输

目标：将 Broker 与 Extension 的核心传输从 Unix Socket 迁移为统一 TCP，同时保持现有同设备多 Session 的单 Broker 行为和使用体验。

状态：已完成。

## 已确认边界

- 本机连接使用 `127.0.0.1`。
- 局域网 Broker 可以监听可配置网卡地址。
- `0.0.0.0` 只允许作为监听地址，不能作为客户端连接地址或发现结果。
- 阶段 12 合并时必须已有可用的 TCP 单 Broker 竞争与复用逻辑，不能等到阶段 14。
- 继续使用现有 JSONL 协议和 `handleConnection()`。
- 不引入 HTTP、WebSocket、WebRTC 或新的消息中间件。
- 测试默认使用系统分配的临时端口，避免固定端口冲突。

## 实施决策

- 正式本机端点固定为 `127.0.0.1:43127`；阶段 12 只正式支持 IPv4。
- 使用 `broker.probe` / `broker.ready` 完成无副作用握手，只接受 `service: pi-comms` 且 `protocolVersion: 1`。
- 单 Broker 约束绑定数据目录；使用 `open(..., "wx")` 数据库级原子锁。
- 兼容 Broker 已存在时复用并正常退出；无关服务占用端口或协议不兼容时明确失败，不自动换端口。
- TCP 建连、协议握手和首次启动总超时分别为 1 秒、1.5 秒和 8 秒；keepalive 初始延迟为 10 秒。
- `BrokerClient` 提供 `setEndpoint()`，端点变化时清理旧连接和重连计时器，再连接新端点。
- 旧 Unix Broker 通过 `npm run broker:migrate` 显式迁移；未迁移时禁止新旧 Broker 同时访问同一数据库。
- 指定局域网 IP 或 `0.0.0.0` 仅作为开发测试能力，并提示当前没有局域网准入控制。
- 不增加第三方运行时依赖；跨平台 CI 矩阵留到阶段 16。
- 必须覆盖独立进程并发启动，并完成两个真实 Pi Session 的 TCP 联调。
- 全部开发在 `agent/todo-12-cross-platform-tcp` 分支完成；通过验收前 Draft PR 不得合入 `main`。

## 任务

### 统一端点模型

- [x] 新增 TCP Broker 端点类型，明确区分监听端点和连接端点，至少包含 `host` 和 `port`。
- [x] 将 `BrokerServerOptions.socketPath` 改为 TCP 监听配置。
- [x] 将 `BrokerClientOptions.socketPath` 改为 TCP 连接配置。
- [x] 将默认本机端点集中定义，禁止业务代码散落固定地址。
- [x] 删除 Extension、测试和脚本对 Unix Socket 路径的直接依赖。

### 改造 Broker

- [x] 复用现有 `handleConnection()` 创建 TCP Server。
- [x] 支持监听 `127.0.0.1`、指定局域网地址和 `0.0.0.0`。
- [x] 监听端口为 `0` 时返回系统实际分配的端口。
- [x] 在 Broker 状态中暴露实际监听地址和端口。
- [x] 将端口占用转成清晰的启动错误。
- [x] 删除失效 Unix Socket 清理逻辑。
- [x] 用 TCP 探测、端口绑定和跨进程启动互斥替代 Unix 文件链接锁；替代逻辑完成前不得删除旧锁。
- [x] 保证关闭时停止接受连接并清理全部客户端。

### 保持本机单 Broker

- [x] 为正式运行定义固定本机端点；端口 `0` 只用于测试和显式临时实例。
- [x] 两个 Pi Session 并发首次连接时只能成功启动一个 Broker。
- [x] 启动者遇到 `EADDRINUSE` 后重新握手探测；确认是兼容 Broker时改为复用，不能直接失败。
- [x] 端口被无关进程占用时返回明确错误，不能误认成 Pi Comms Broker。
- [x] 本机自动启动逻辑必须等待 Broker 完成协议握手，不能只判断 TCP 端口已打开。
- [x] 阶段 12 的实现 PR 不得在缺少以上行为时单独合并。

### 改造 BrokerClient

- [x] 使用 `createConnection({ host, port })` 建立连接。
- [x] 增加连接超时，失败后正确释放 Socket。
- [x] 启用 TCP keepalive。
- [x] 保留现有重连、`client.hello`、快照和消息发送行为。
- [x] 连接目标改变时停止旧连接和旧重连计时器。
- [x] 握手确认目标是兼容的 Pi Comms Broker，而不是任意占用该端口的进程。

### 更新测试

- [x] 将 Broker、Extension 和验收测试迁移到 loopback TCP。
- [x] 覆盖两个普通客户端通过 TCP 广播消息。
- [x] 覆盖两个 Extension 通过 TCP 完成现有 Agent 闭环。
- [x] 覆盖临时端口、固定端口占用、关闭和重启。
- [x] 覆盖两个 Extension 并发首次启动时只产生一个 Broker。
- [x] 覆盖端口被无关进程占用时不会复用或启动第二个 Broker。
- [x] 保证阶段 0～11 的行为测试继续通过。

## 主要改动文件

- `src/broker/server.ts`
- `src/extension/broker-client.ts`
- `src/extension/index.ts`
- `src/extension/broker-process.ts`
- `tests/broker.test.ts`
- `tests/extension.test.ts`
- `tests/acceptance.test.ts`

## 本阶段不做

- 不做 mDNS 自动发现。
- 不做局域网邀请码。
- 不增加跨设备身份字段。
- 不修改群组、队列、权限和 Agent 路由逻辑。
- 不修改 TUI 的设置流程。

## 完成条件

- [x] macOS、Linux 和 Windows 可共用同一套 TCP 代码。
- [x] 本机两个 Pi Session 能通过 loopback TCP 完成现有全部通信，包括并发首次启动。
- [x] Broker 核心不再依赖 Unix Socket 文件。
- [x] TCP 集成测试和项目完整检查通过。

## 下一阶段

[阶段 13：跨设备身份与连接可靠性](../in-progress/13-device-identity-reliability.md)
