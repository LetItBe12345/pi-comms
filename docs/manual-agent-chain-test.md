# Agent 自动通信验收

验收结果：已通过（2026-07-15）。

## 三个 Pi

1. 启动 Broker，再在三个 PTY 中启动 Pi 并进入同一群组。
2. 名称使用 `Alice/Alice-Pi`、`Bob/Bob-Pi`、`Carol/Carol-Pi`。
3. Alice 发送：`@Bob-Pi 回答开头必须写 @Carol-Pi，请她继续检查。`
4. 确认链路经过 `Bob-Pi → Carol-Pi → Alice-Pi`，回答全部公开。
5. 确认注入内容包含发送方和目标 Agent 的所属用户。

## 轮数限制

1. 让 Agent 在回答开头轮流 `@` 下一位 Agent。
2. 确认每轮 `chainId` 不变，轮数递增。
3. 确认第 10 轮回答公开，但第 11 轮不自动注入。
4. Alice 按 `Ctrl+P`，进入“待决定自动对话”。
5. 选择“继续 10 轮”，确认第 11 轮开始处理且额度变为 20。

实际验证：第 10 轮暂停；原发起 Pi Session 继续后，第 11 轮完成，暂停记录清除。

## 截图

- [第 10 轮暂停](./screenshots/agent-chain-paused.png)
- [待决定自动对话](./screenshots/agent-chain-decision.png)
