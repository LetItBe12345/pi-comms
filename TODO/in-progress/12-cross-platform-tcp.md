# 阶段 12：跨平台 TCP 传输

目标：将 Broker 与 Extension 的核心传输从 Unix Socket 迁移为统一 TCP，为 macOS、Linux 和 Windows 使用同一条通信路径。

状态：待实施。

## 已确认边界

- 本机连接使用 `127.0.0.1`。
- 局域网 Broker 可以监听可配置网卡地址。
- 继续使用现有 JSONL 协议和 `handleConnection()`。
- 不引入 HTTP、WebSocket、WebRTC 或新的消息中间件。
- 测试默认使用系统分配的临时端口，避免固定端口冲突。

## 任务

### 统一端点模型

- [ ] 新增 TCP Broker 端点类型，至少包含 `host` 和 `port`。
- [ ] 将 `BrokerServerOptions.socketPath` 改为 TCP 监听配置。
- [ ] 将 `BrokerClientOptions.socketPath` 改为 TCP 连接配置。
- [ ] 将默认本机端点集中定义，禁止业务代码散落固定地址。
- [ ] 删除 Extension、测试和脚本对 Unix Socket 路径的直接依赖。

### 改造 Broker

- [ ] 复用现有 `handleConnection()` 创建 TCP Server。
- [ ] 支持监听 `127.0.0.1`、指定局域网地址和 `0.0.0.0`。
- [ ] 监听端口为 `0` 时返回系统实际分配的端口。
- [ ] 在 Broker 状态中暴露实际监听地址和端口。
- [ ] 将端口占用转成清晰的启动错误。
- [ ] 删除失效 Unix Socket 清理逻辑。
- [ ] 删除依赖 Unix 文件链接的 Broker 锁逻辑。
- [ ] 保证关闭时停止接受连接并清理全部客户端。

### 改造 BrokerClient

- [ ] 使用 `createConnection({ host, port })` 建立连接。
- [ ] 增加连接超时，失败后正确释放 Socket。
- [ ] 启用 TCP keepalive。
- [ ] 保留现有重连、`client.hello`、快照和消息发送行为。
- [ ] 连接目标改变时停止旧连接和旧重连计时器。

### 更新测试

- [ ] 将 Broker、Extension 和验收测试迁移到 loopback TCP。
- [ ] 覆盖两个普通客户端通过 TCP 广播消息。
- [ ] 覆盖两个 Extension 通过 TCP 完成现有 Agent 闭环。
- [ ] 覆盖临时端口、固定端口占用、关闭和重启。
- [ ] 保证阶段 0～11 的行为测试继续通过。

## 主要改动文件

- `src/broker/server.ts`
- `src/extension/broker-client.ts`
- `src/extension/index.ts`
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

- [ ] macOS、Linux 和 Windows 可共用同一套 TCP 代码。
- [ ] 本机两个 Pi Session 能通过 loopback TCP 完成现有全部通信。
- [ ] Broker 核心不再依赖 Unix Socket 文件。
- [ ] TCP 集成测试和项目完整检查通过。

## 下一阶段

[阶段 13：跨设备身份与连接可靠性](./13-device-identity-reliability.md)
