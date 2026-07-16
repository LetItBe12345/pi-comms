# TCP 实机验收

日期：2026-07-17

环境：Linux x86_64、Node.js 22.22.3、Pi 0.80.6。

## 操作

```bash
npm run broker:migrate
pi --no-extensions -e ./src/extension/index.ts
pi --no-extensions -e ./src/extension/index.ts
```

两个 Pi 同时执行 `/comms`，创建并加入同一群组。

## 结果

- 同时首次连接只启动一个 Broker。
- Broker 监听 `127.0.0.1:43127`。
- 普通消息可在两个 Pi 间广播。
- `@Agent` 请求成功，目标 Agent 回复 `TCP_OK`。
- 强制停止 Broker 后，只启动一个新 Broker。
- 两个 Pi 自动重连，成员和历史消息恢复。
- 完整检查通过：`npm run check`。

## 迁移注意

执行迁移前必须关闭全部旧 Pi Session。否则旧 Extension 会重新启动 Unix Broker。

本次 PTY 自动输入过快，测试 Agent 名被重复录入。改用界面实际显示的 Agent 名后，`@Agent` 闭环正常。
