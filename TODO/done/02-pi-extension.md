# 阶段 2：Pi Extension 最小验证

目标：Pi Extension 能连接 Local Broker 并双向收发测试消息。

## 任务

- [x] 创建 `src/extension/index.ts`。
- [x] 注册临时命令 `/comms-test`。
- [x] 获取当前 Pi Session 的可用标识。
- [x] 建立 Extension 到 Broker 的连接。
- [x] 从 Extension 发送测试消息。
- [x] 接收 Broker 消息。
- [x] 在 Pi 中显示收到的消息。
- [x] 在 Session 关闭时断开 Socket。

## 完成条件

- [x] 两个 Pi Session 的 Extension 都能连接 Broker。
- [x] 两边都能在 Pi 中看到 Broker 发来的测试消息。
- [x] 关闭 Session 后，对应连接被清理。

## 下一阶段

[阶段 3：远程 Agent 闭环](../in-progress/03-agent-roundtrip.md)
