# Pi Comms

运行在 Pi CLI 中的本地群聊通信工具。

它让多个用户和各自的 Pi Session 加入同一群组。群聊中的 `@Agent` 消息会发送到目标 Pi Session，最终回答再返回群聊。

## 当前状态

项目正在开发中，目前处于 Node.js 通信验证阶段，尚无可用版本。

MVP 只支持：

- 同一台设备
- Pi Agent
- 纯文本群聊
- 人与人、人与 Agent、Agent 与 Agent 通信

## 技术方案

```text
Pi Session A Extension ─┐
                        ├── Unix Socket ── Local Broker ── SQLite
Pi Session B Extension ─┘
```

- TypeScript
- Node.js 22
- Pi Extension
- Unix Domain Socket
- SQLite
- Vitest

## 开发

```bash
npm ci
npm run check
```

## 文档

- [产品需求](./PRD.md)
- [技术规格](./SPECIFICATION.md)
- [开发流程](./DEVELOPMENT.md)
- [任务总览](./TODO/README.md)
