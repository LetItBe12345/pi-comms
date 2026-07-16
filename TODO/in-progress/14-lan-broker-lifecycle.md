# 阶段 14：局域网 Broker 生命周期与准入

目标：明确本机、局域网主机和局域网客户端的启动行为，并用最小邀请码限制陌生设备接入。

状态：待实施。

## 已确认边界

- 一个通信空间只有一个权威 Broker 和一份 SQLite。
- 局域网客户端连接失败时绝不能自动启动自己的 Broker。
- 本机模式可以继续自动启动本机 Broker。
- 局域网主机必须由用户明确创建。
- 邀请码只用于最小准入，不等同于链路加密。

## 任务

### 定义运行模式

- [ ] 定义 `local`、`lan-host` 和 `lan-client` 三种连接模式。
- [ ] `local` 只连接 loopback，可按现有体验自动启动 Broker。
- [ ] `lan-host` 启动一个可被局域网访问的 Broker。
- [ ] `lan-client` 只连接指定 Broker，失败后保持重试或返回选择界面。
- [ ] 删除“连接任意目标失败就启动本机 Broker”的行为。

### Broker 生命周期

- [ ] 生成并持久化稳定 `brokerId`。
- [ ] 写入 Broker 运行元数据，至少包含 `brokerId`、PID、监听地址和端口。
- [ ] 启动前通过 TCP 握手确认已有 Broker，而不是只检查 PID。
- [ ] 已有兼容 Broker 时复用，不重复启动。
- [ ] 元数据失效时安全覆盖，不删除 SQLite。
- [ ] 关闭时清理运行元数据并停止后续自动发现广告。

### 跨平台启动

- [ ] 删除 `spawn("npm", ["run", "broker"])`。
- [ ] 使用 `process.execPath` 启动项目内统一 Broker launcher。
- [ ] 所有入口路径通过 `import.meta.url` 和 Node 路径 API 解析。
- [ ] 启动逻辑不依赖 Bash、软链接、Unix 信号或 `npm.cmd`。
- [ ] macOS、Linux 和 Windows 使用同一启动函数。

### 最小邀请码

- [ ] 创建局域网 Broker 时生成短邀请码。
- [ ] 邀请码只在主机本地界面显示，不写入 mDNS TXT。
- [ ] `client.hello` 增加邀请码或等价准入字段。
- [ ] Broker 在发送快照前验证邀请码。
- [ ] 错误邀请码返回明确错误并立即关闭连接。
- [ ] 本机 loopback 连接可以使用单独的本机准入策略。
- [ ] 日志和错误信息不得输出完整邀请码。

### 更新测试

- [ ] 覆盖三种运行模式的启动决策。
- [ ] 覆盖局域网客户端连接失败后不会启动本机 Broker。
- [ ] 覆盖多个本机 Pi Session 复用同一个 Broker。
- [ ] 覆盖失效运行元数据和端口被占用。
- [ ] 覆盖正确邀请码、错误邀请码和缺少邀请码。
- [ ] 覆盖未通过准入的客户端无法收到群组快照。
- [ ] 覆盖 Broker launcher 在不同路径下正常启动。

## 主要改动文件

- `src/extension/index.ts`
- `src/extension/broker-process.ts`
- `src/broker/server.ts`
- `src/broker/launcher.ts`
- `src/protocol.ts`
- `tests/extension.test.ts`
- `tests/broker.test.ts`

## 本阶段不做

- 不做 TLS、证书和端到端加密。
- 不做公网连接、NAT 穿透或中继。
- 不做多个 Broker 的选主和同步。
- 不做自动发现界面。

## 完成条件

- [ ] 三种运行模式不会产生意外的第二个 Broker。
- [ ] Broker 可以通过统一 launcher 在三个目标平台启动。
- [ ] 未提供正确邀请码的远程客户端无法进入通信空间。
- [ ] 生命周期与准入自动测试通过。

## 下一阶段

[阶段 15：mDNS 自动发现与 Broker 选择](./15-mdns-discovery-tui.md)
