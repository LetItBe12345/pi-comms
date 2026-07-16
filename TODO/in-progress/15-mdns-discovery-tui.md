# 阶段 15：mDNS 自动发现与 Broker 选择

目标：通过 mDNS/DNS-SD 自动发现局域网 Broker，并在 `/comms` 中提供明确的选择和创建入口。

状态：待实施。

## 已确认边界

- 自动发现的是 Broker，不是每个 Pi Session。
- 发现层只负责获得 Broker 候选地址，真实通信继续使用 TCP。
- 同一局域网可以同时存在多个 Broker，必须让用户选择。
- 自动发现失败时必须保留手动地址入口。
- mDNS 只提供候选端点；连接成功后必须通过协议握手验证 `brokerId` 和协议版本。
- 不自动选择第一个 Broker，不做自动选主。

## 任务

### 封装发现接口

- [ ] 增加独立 `BrokerDiscovery` 接口，业务层不直接依赖具体 mDNS 库。
- [ ] 使用 `bonjour-service` 实现发布和浏览。
- [ ] 定义 `DiscoveredBroker`，至少包含 `brokerId`、名称、主机、地址列表、端口和协议版本。
- [ ] 提供可替换的假实现，供 TUI 和单元测试使用。
- [ ] 发现实例停止后释放浏览器、定时器和 UDP Socket。

### 发布 Broker

- [ ] 使用 `_pi-comms._tcp.local` 服务类型。
- [ ] Broker 完成 TCP 监听后再发布服务。
- [ ] TXT 只发布 `txtvers`、协议版本、`brokerId`、应用版本和是否需要邀请码。
- [ ] TXT 不发布邀请码、密钥、群组内容或 Session 信息。
- [ ] Broker 关闭前先撤销服务广告。
- [ ] 服务名称冲突时保留稳定 `brokerId`，允许显示名称自动区分。
- [ ] 广告由 Broker 进程维护，不由单个 Extension 维护。

### 浏览与地址选择

- [ ] 持续处理服务 `up`、`down`、SRV/TXT 更新和 TTL 失效。
- [ ] 使用 `brokerId` 去重，不使用显示名称去重。
- [ ] 过滤远程服务中的 loopback、未指定地址和不可作为目标的 `0.0.0.0`/`::`。
- [ ] 优先尝试可用私网 IPv4，再尝试 IPv6 地址。
- [ ] 每个候选地址使用短连接超时并按顺序回退；IPv6 链路本地地址必须保留 scope ID。
- [ ] TCP 连接后校验握手返回的 `brokerId` 与发现结果一致，不一致时拒绝并标记候选已失效。
- [ ] 同一 Broker 地址变化时更新列表，不创建重复项。

### 增加 Broker 选择界面

- [ ] 首次使用或用户主动切换时，在用户名设置前增加 Broker 选择阶段。
- [ ] 实时显示发现到的 Broker 名称、设备、地址和连接状态。
- [ ] 提供“创建局域网通信空间”。
- [ ] 提供“仅本机使用”。
- [ ] 提供“手动输入地址”。
- [ ] 支持刷新、返回和取消。
- [ ] 选择远程 Broker 后输入邀请码，再进入现有用户名和 Agent 名称流程。
- [ ] 持久化上次选择的模式、`brokerId` 和端点；再次进入 `/comms` 时先尝试恢复，失败后返回选择界面。
- [ ] 切换 Broker 时先停止旧 Socket、重连计时器和发现浏览，再启用新配置。
- [ ] 连接失败时返回 Broker 选择界面，不静默启动本机 Broker。

### 更新测试

- [ ] 使用假发现实现测试 Broker 上线、更新、下线和去重。
- [ ] 测试多个 Broker 同时出现时不会自动连接。
- [ ] 测试选择远程、创建本机、仅本机和手动地址。
- [ ] 测试错误邀请码和连接失败返回选择界面。
- [ ] 测试过期 IP 指向其他 Broker 时因 `brokerId` 不匹配而拒绝。
- [ ] 测试再次进入 `/comms` 可恢复上次选择，不重复要求选择。
- [ ] 测试 TUI 退出后停止浏览，但已启动 Broker 继续发布。
- [ ] 增加可选的本机 mDNS 发布与浏览集成测试。

## 主要改动文件

- `src/discovery/types.ts`
- `src/discovery/bonjour-discovery.ts`
- `src/broker/server.ts`
- `src/extension/index.ts`
- `src/tui/broker-picker.ts`
- `src/tui/chat-view.ts`
- `tests/discovery.test.ts`
- `tests/tui.test.ts`

## 本阶段不做

- 不发现或直连单个 Session。
- 不做 Broker 自动选举。
- 不同步多个 Broker 的 SQLite。
- 不跨 VLAN、子网或公网发现。
- 不移除手动地址兜底。

## 完成条件

- [ ] 同一局域网中的 Broker 可以自动出现在 `/comms` 选择列表。
- [ ] 多个 Broker 可以并列显示，由用户明确选择。
- [ ] 发现结果只包含连接所需的非敏感元数据。
- [ ] 自动发现失败时仍能通过手动地址连接。
- [ ] 发现层和 Broker 选择 TUI 测试通过。

## 下一阶段

[阶段 16：跨平台测试与局域网验收](./16-cross-platform-acceptance.md)
