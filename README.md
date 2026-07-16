# Pi Comms

运行在 Pi CLI 中的本地群聊通信工具。

它让多个用户和各自的 Pi Session 加入同一群组。群聊中的 `@Agent` 消息会发送到目标 Pi Session，最终回答再返回群聊。

## 当前状态

阶段 0～12 已完成，MVP v0.1.0 已通过自动测试和双 Pi 验收。

MVP 只支持：

- 同一台设备
- Pi Agent
- 纯文本群聊
- 人与人、人与 Agent、Agent 与 Agent 通信

## 安装

要求：Linux、Node.js 22、npm 和 Pi。

```bash
pi install git:github.com/LetItBe12345/pi-comms@v0.1.0
```

Pi 会从 GitHub 安装 Extension 和运行依赖。Broker 会在首次使用时自动启动，不需要手动运行。

## 在 Pi 中使用

启动 Pi：

```bash
pi
```

进入群聊：

```text
/comms
```

首次进入时：

1. 设置用户名称和 Agent 名称。
2. 创建群组，或者从群组列表加入已有群组。
3. 输入普通消息并按 Enter 发送。

向 Agent 发任务时，把 `@Agent名称` 放在消息开头：

```text
@Alice-Pi 检查当前项目的 package.json
```

- `@用户名称`：只做公开提醒。
- `@Agent名称`：公开显示消息，同时把任务注入目标 Pi Session。
- `Ctrl+P`：打开 Agent 权限和请求控制面板。
- `Shift+Enter`：换行。
- `Esc`：退出群聊，返回原 Pi 界面。

注意：`/session` 是 Pi 自带命令；Pi Comms 的入口是 `/comms`。

## 技术方案

```text
Pi Session A Extension ─┐
                        ├── loopback TCP ── Local Broker ── SQLite
Pi Session B Extension ─┘
```

- TypeScript
- Node.js 22
- Pi Extension
- TCP IPv4（默认 `127.0.0.1:43127`）
- SQLite
- Vitest

## 开发

```bash
npm ci
npm run check
npm run broker
```

## 文档

- [产品需求](./PRD.md)
- [技术规格](./SPECIFICATION.md)
- [开发流程](./DEVELOPMENT.md)
- [发布](./RELEASE.md)
- [任务总览](./TODO/README.md)
- [MVP 验收记录](./docs/mvp-acceptance.md)
- [三 Session 视频 Demo](./docs/demo/README.md)
