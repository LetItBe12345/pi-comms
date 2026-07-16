# 阶段 13：跨设备身份与连接可靠性

目标：为跨设备连接增加稳定身份、协议协商和失联检测，避免不同电脑的 Session 冲突。

状态：待实施。

## 已确认边界

- 一个 Pi Session 仍对应一个用户和一个 Agent。
- Broker 继续集中维护群组、在线状态和 Agent 队列。
- `sessionId` 只保证单设备内有意义，跨设备必须结合稳定 `deviceId`。
- `deviceId + sessionId` 是统一的稳定 `SessionKey`；内存、数据库和授权判断必须使用同一语义。
- 稳定身份用于区分 Session，不等于连接恢复凭证。
- TCP keepalive 不能替代应用层心跳。

## 任务

### 稳定设备身份

- [ ] 首次运行时生成稳定 `deviceId` 并持久化到 Pi Comms 数据目录。
- [ ] 后续启动复用同一个 `deviceId`。
- [ ] 定义统一 `SessionKey`，由 `deviceId` 和 `sessionId` 无歧义编码，禁止直接字符串拼接。
- [ ] 将 Broker 内部 Session Key、暂停链发起者和所有 Session 授权判断改用 `SessionKey`。
- [ ] `clientId` 只代表当前 Broker 实例中的逻辑客户端，不再承担稳定设备身份。
- [ ] Broker 首次握手返回随机 `resumeToken`；同一 Broker 内恢复连接必须同时提交 `clientId` 和 `resumeToken`。
- [ ] `resumeToken` 不写入日志、不广播给其他客户端，Broker 重启后失效。
- [ ] 覆盖两台设备使用相同 `sessionId` 时互不覆盖。
- [ ] 覆盖伪造 `clientId` 或错误 `resumeToken` 不能接管现有连接。

### 数据库与成员身份迁移

- [ ] 增加 SQLite Schema 迁移，将 `paused_chains.initiator_session_id` 迁移为稳定 `SessionKey`。
- [ ] 检查所有以 `sessionId`、`clientId` 或成员 ID 作为授权依据的字段和查询。
- [ ] 明确成员 ID 继续基于 Broker 分配的 `clientId`；稳定 Session 身份不直接暴露为群成员 ID。
- [ ] 旧数据库升级后保留群组、消息和暂停链，不能静默重建数据库。
- [ ] 增加旧 Schema 到新 Schema 的迁移测试和暂停链继续权限测试。

### 协议版本

- [ ] 为协议定义固定 `protocolVersion`。
- [ ] 在 `client.hello` 中增加 `protocolVersion`、`deviceId`、可选 `clientId` 和可选 `resumeToken`。
- [ ] Broker 在注册客户端前校验协议版本。
- [ ] 协议不兼容时返回明确错误并关闭连接。
- [ ] 将协议版本加入自动发现元数据使用的公共常量。

### 连接可靠性

- [ ] 增加 Broker 端 `client.hello` 超时。
- [ ] 增加应用层 `ping` 和 `pong`。
- [ ] 客户端持续心跳，Broker 按超时判断失联。
- [ ] 局域网断线恢复时间与本机快速退出分开配置。
- [ ] 重连后使用稳定设备身份恢复原客户端和群组成员。
- [ ] Broker 重启后继续沿用现有 SQLite 恢复边界。

### 限制输入边界

- [ ] 为 `JsonlDecoder` 增加最大帧长度。
- [ ] 未出现换行但缓存超过上限时立即报错并清空连接。
- [ ] 增加 `frame_too_large`、`hello_timeout` 和 `protocol_mismatch` 错误码。
- [ ] 保证非法客户端不会无限占用内存或长期占用连接。

### 更新测试

- [ ] 覆盖不同 `deviceId` 使用相同 `sessionId`。
- [ ] 覆盖同一设备和 Session 的正常重连。
- [ ] 覆盖跨设备相同 `sessionId` 的暂停链授权互不混淆。
- [ ] 覆盖旧 SQLite Schema 迁移。
- [ ] 覆盖协议版本不一致。
- [ ] 覆盖未发送 `client.hello` 的超时连接。
- [ ] 覆盖心跳超时、短暂断线恢复和正式离线。
- [ ] 覆盖超大 JSONL 帧被拒绝。

## 主要改动文件

- `src/protocol.ts`
- `src/broker/server.ts`
- `src/extension/broker-client.ts`
- `src/extension/device-identity.ts`
- `src/broker/database.ts`
- `src/broker/group-state.ts`
- `src/types.ts`
- `tests/protocol.test.ts`
- `tests/broker.test.ts`
- `tests/extension.test.ts`

## 本阶段不做

- 不做邀请码或加密。
- 不做 mDNS 自动发现。
- 不同步多个 Broker。
- 不改变群组内显示名称唯一规则。

## 完成条件

- [ ] 不同设备的 Session 身份、暂停链权限和连接恢复不会冲突。
- [ ] 协议不兼容、握手超时和超大帧都有明确失败结果。
- [ ] 网络短暂中断后可以恢复原群组身份。
- [ ] 心跳与重连自动测试通过。

## 下一阶段

[阶段 14：局域网 Broker 生命周期与准入](./14-lan-broker-lifecycle.md)
