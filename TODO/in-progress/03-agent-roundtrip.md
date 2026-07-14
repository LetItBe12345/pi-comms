# 阶段 3：远程 Agent 闭环

目标：A 请求 B，消息只进入 B 的 Pi Session，B 的最终回答唯一地返回群聊。

## 任务

- [ ] 为请求生成唯一 `requestId`。
- [ ] Broker 解析明确的 `@Agent` 目标。
- [ ] Broker 向目标 Extension 发送 `agent.deliver`。
- [ ] B Extension 保存 `activeRequest`。
- [ ] B Extension 调用 `pi.sendUserMessage()` 注入当前请求。
- [ ] 注入内容包含发送者、群名、消息正文和目标。
- [ ] 在 `message_end` 捕获最后一个 Assistant 文本。
- [ ] 在 `agent_settled` 后发送一次 `agent.result`。
- [ ] Broker 将 Agent 回答公开广播。
- [ ] A 能看到 B 的回答。
- [ ] 只有存在 `activeRequest` 时才允许广播 Agent 回答。
- [ ] 回传后清空当前请求状态。

## 隔离验证

- [ ] 普通群聊消息不会注入 Agent。
- [ ] 消息只进入被 `@` 的目标 Session。
- [ ] 普通用户与 Pi 的私人对话不会广播到群聊。
- [ ] 同一请求的最终回答不会重复回传。

## 完成条件

- [ ] 双 Session 请求和回答闭环可重复稳定运行。
- [ ] 回答能通过 `requestId` 对应原始请求。
- [ ] 满足上述所有隔离验证。

## 下一阶段

[阶段 4：队列与稳定性](./04-queue-reliability.md)
