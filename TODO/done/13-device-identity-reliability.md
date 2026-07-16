# 阶段 13：跨设备身份与连接可靠性

目标：为跨设备连接增加稳定身份、协议协商和失联检测，避免不同电脑的 Session 冲突。

状态：已完成。

## 已确认边界

- 一个 Pi Session 仍对应一个用户和一个 Agent。
- Broker 继续集中维护群组、在线状态和 Agent 队列。
- `sessionId` 只保证单设备内有意义，跨设备必须结合稳定 `deviceId`。
- `deviceId + sessionId` 是统一的稳定 `SessionKey`；内存、数据库和授权判断必须使用同一语义。
- 稳定身份用于区分 Session，不等于连接恢复凭证。
- TCP keepalive 不能替代应用层心跳。

## 已确认方案

### 身份

- 首次执行 `/comms` 时生成 UUID，保存到 `~/.pi/comms/device-id`；同一系统用户的所有 Pi Session 共用。
- 文件存在但内容无效时明确报错，不自动覆盖；文件丢失后生成新身份，不提供旧身份找回。
- 不使用硬件指纹，不检测复制到其他电脑的 `device-id`；迁移配置时应在新电脑删除该文件。
- `SessionKey` 使用 `JSON.stringify([deviceId, sessionId])` 编码，并由独立模块提供带品牌的类型和解析函数。
- `deviceId`、`SessionKey` 和 `resumeToken` 不在 TUI、成员列表、广播或普通日志中展示。
- 群成员 ID 仍为 `user:<clientId>` 和 `agent:<clientId>`。

### 握手与恢复

- 协议版本升级为 `2`，保留 `broker.probe` 和 `client.hello` 两阶段校验。
- `clientId` 和 `resumeToken` 在 `client.hello` 中必须同时存在或同时缺省。
- 首次握手通过 `client.welcome` 返回 `brokerInstanceId`、`clientId` 和 256 位随机 `resumeToken`。
- `resumeToken` 只存于 Extension 和 Broker 内存；同一 Broker 内保持不变，Broker 或 Pi 进程重启后失效。
- 正确凭证可接管同一 Session 的旧 Socket；缺失或错误凭证不能挤掉原连接。
- Broker 重启后 Extension 丢弃旧凭证，获取新 `clientId`，并用已有群组和名称自动重新加入。
- 超过失联保留期后获取新 `clientId`，不自动重新入群，由用户重新加入。
- `client.goodbye` 使用空 Payload，以当前已认证 Socket 作为退出身份。

### 超时与重连

- TCP 建立后 3 秒内必须完成 `broker.probe` 和 `client.hello`。
- 客户端每 5 秒发送一次 `ping`，双方 15 秒没有收到对应心跳即断开。
- 本机回环连接保留身份 3 秒，其他 TCP 对端保留 15 秒。
- 每 1 秒尝试重连；`protocol_mismatch` 等永久错误停止重连。
- 时间参数仅作为可注入的代码配置，暂不增加设置文件、环境变量或 TUI 入口。

### 输入与错误

- 所有 TCP JSONL 解码入口统一限制单帧为 8 MiB，按 UTF-8 字节数计算。
- 超限后立即报错并关闭连接，暂不另设聊天正文长度上限。
- 新增错误码：`protocol_mismatch`、`hello_timeout`、`frame_too_large`、`resume_rejected`、`session_in_use`、`heartbeat_timeout`。
- `ping` 使用信封 ID；`pong` 只返回对应的 `requestId`，不携带身份字段。

### 数据库与验收

- 旧数据视为来自 Broker 主机，将旧 `sessionId` 与该主机 `deviceId` 转为 `SessionKey`。
- 同时迁移 `agent_requests.initiator_session_id` 和 `paused_chains.initiator_session_id`，字段改名为 `initiator_session_key`。
- Schema 升级在一个事务中完成；失败时回滚并停止 Broker，不删除或重建数据库。
- 自动测试模拟不同设备，并覆盖真实 TCP；本机使用多个真实 Pi 做回归。
- 双电脑手动测试写入测试文档，但不作为阶段完成的硬性前提。

## 任务

### 稳定设备身份

- [x] 首次运行时生成稳定 `deviceId` 并持久化到 Pi Comms 数据目录。
- [x] 后续启动复用同一个 `deviceId`。
- [x] 定义统一 `SessionKey`，由 `deviceId` 和 `sessionId` 无歧义编码，禁止直接字符串拼接。
- [x] 将 Broker 内部 Session Key、暂停链发起者和所有 Session 授权判断改用 `SessionKey`。
- [x] `clientId` 只代表当前 Broker 实例中的逻辑客户端，不再承担稳定设备身份。
- [x] Broker 首次握手返回随机 `resumeToken`；同一 Broker 内恢复连接必须同时提交 `clientId` 和 `resumeToken`。
- [x] `resumeToken` 不写入日志、不广播给其他客户端，Broker 重启后失效。
- [x] 覆盖两台设备使用相同 `sessionId` 时互不覆盖。
- [x] 覆盖伪造 `clientId` 或错误 `resumeToken` 不能接管现有连接。

### 数据库与成员身份迁移

- [x] 增加 SQLite Schema 迁移，将 `agent_requests.initiator_session_id` 和 `paused_chains.initiator_session_id` 迁移并改名为 `initiator_session_key`。
- [x] 检查所有以 `sessionId`、`clientId` 或成员 ID 作为授权依据的字段和查询。
- [x] 明确成员 ID 继续基于 Broker 分配的 `clientId`；稳定 Session 身份不直接暴露为群成员 ID。
- [x] 旧数据库升级后保留群组、消息和暂停链，不能静默重建数据库。
- [x] 增加旧 Schema 到新 Schema 的迁移测试和暂停链继续权限测试。

### 协议版本

- [x] 为协议定义固定 `protocolVersion`。
- [x] 在 `client.hello` 中增加 `protocolVersion`、`deviceId`、可选 `clientId` 和可选 `resumeToken`。
- [x] Broker 在注册客户端前校验协议版本。
- [x] 协议不兼容时返回明确错误并关闭连接。
- [x] 将协议版本加入自动发现元数据使用的公共常量。

### 连接可靠性

- [x] 增加 Broker 端 `client.hello` 超时。
- [x] 增加应用层 `ping` 和 `pong`。
- [x] 客户端持续心跳，Broker 按超时判断失联。
- [x] 局域网断线恢复时间与本机快速退出分开配置。
- [x] 重连后使用稳定设备身份恢复原客户端和群组成员。
- [x] Broker 重启后继续沿用现有 SQLite 恢复边界。

### 限制输入边界

- [x] 为 `JsonlDecoder` 增加最大帧长度。
- [x] 未出现换行但缓存超过上限时立即报错并清空连接。
- [x] 增加 `frame_too_large`、`hello_timeout` 和 `protocol_mismatch` 错误码。
- [x] 增加 `resume_rejected`、`session_in_use` 和 `heartbeat_timeout` 错误码。
- [x] 保证非法客户端不会无限占用内存或长期占用连接。

### 更新测试

- [x] 覆盖不同 `deviceId` 使用相同 `sessionId`。
- [x] 覆盖同一设备和 Session 的正常重连。
- [x] 覆盖跨设备相同 `sessionId` 的暂停链授权互不混淆。
- [x] 覆盖旧 SQLite Schema 迁移。
- [x] 覆盖协议版本不一致。
- [x] 覆盖未发送 `client.hello` 的超时连接。
- [x] 覆盖心跳超时、短暂断线恢复和正式离线。
- [x] 覆盖超大 JSONL 帧被拒绝。

## 主要改动文件

- `src/protocol.ts`
- `src/device-identity.ts`
- `src/session-key.ts`
- `src/broker/server.ts`
- `src/extension/broker-client.ts`
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

- [x] 不同设备的 Session 身份、暂停链权限和连接恢复不会冲突。
- [x] 协议不兼容、握手超时和超大帧都有明确失败结果。
- [x] 网络短暂中断后可以恢复原群组身份。
- [x] 心跳与重连自动测试通过。

## 下一阶段

[阶段 14：局域网 Broker 生命周期与准入](../in-progress/14-lan-broker-lifecycle.md)
