# 阶段 3：远程 Agent 闭环

目标：A 请求 B，消息只进入 B 的 Pi Session，B 的最终回答唯一地返回群聊。

## 任务

- [x] 为请求生成唯一 `requestId`。
- [x] Broker 解析明确的 `@Agent` 目标。
- [x] Broker 向目标 Extension 发送 `agent.deliver`。
- [x] B Extension 保存 `activeRequest`。
- [x] B Extension 调用 `pi.sendUserMessage()` 注入当前请求。
- [x] 注入内容包含发送者、群名、消息正文和目标。
- [x] 在 `message_end` 捕获最后一个 Assistant 文本。
- [x] 在 `agent_settled` 后发送一次 `agent.result`。
- [x] Broker 将 Agent 回答公开广播。
- [x] A 能看到 B 的回答。
- [x] 只有存在 `activeRequest` 时才允许广播 Agent 回答。
- [x] 回传后清空当前请求状态。

## 隔离验证

- [x] 普通群聊消息不会注入 Agent。
- [x] 消息只进入被 `@` 的目标 Session。
- [x] 普通用户与 Pi 的私人对话不会广播到群聊。
- [x] 同一请求的最终回答不会重复回传。

## 完成条件

- [x] 双 Session 请求和回答闭环可重复稳定运行。
- [x] 回答能通过 `requestId` 对应原始请求。
- [x] 满足上述所有隔离验证。

## 下一阶段

[阶段 4：队列与稳定性](../in-progress/04-queue-reliability.md)
