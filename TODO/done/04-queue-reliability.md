# 阶段 4：队列与稳定性

目标：每个 Session 串行处理远程请求，并能应对断线、重启和重复消息。

## 任务

- [x] 实现每个 Extension 的 `remoteQueue`。
- [x] Agent 空闲时立即处理远程请求。
- [x] Agent 忙碌时把请求加入队列。
- [x] 保证远程请求不抢占当前任务。
- [x] 保证同一时间只有一个 `activeRequest`。
- [x] 当前请求回传后自动处理下一条队列。
- [x] 使用 `requestId` 关联请求和回答。
- [x] 处理 Socket 断线。
- [x] 处理 Broker 重启后的重新连接。
- [x] 防止重复投递消息。
- [x] 防止重复回传结果。
- [x] Session 关闭时清理队列和活动请求。

## 完成条件

- [x] 连续发送多个请求时，B 按顺序逐个处理。
- [x] 断线重连后不会重复广播已完成请求的结果。
- [x] Broker 重启后 Extension 可以恢复通信。

人工验收见 [双 Pi 队列手动测试](../../docs/manual-queue-test.md)。

## 下一阶段

[阶段 5：群组与成员](./05-groups-members.md)
