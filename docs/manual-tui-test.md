# TUI 手动验收

首次验收：2026-07-15

- 两个真实 Pi 完成公开聊天。
- `@视觉乙-Pi` 返回 `TUI_OK`。
- 退出重进后名称和历史恢复。
- Broker 中断后自动恢复，且只启动一个实例。
- 草稿在重连后保留。
- `npm run check`：45 项测试通过。

## 阶段 11 追加式时间线验收

日期：2026-07-17

- 使用一个隔离 Broker、一个隔离 SQLite 和三个真实 Pi 0.80.6 PTY。
- Alice、Bob、Carol 及各自 Agent 同时加入 `布局验收` 群组。
- 分别使用 40、80、120 列终端。
- 验证当前用户消息在右侧，其他用户和所有 Agent 在左侧。
- 验证连续消息标题合并、中文、Emoji、长 URL 和 Agent Markdown。
- `@Bob-Pi` 真实返回 Markdown 列表，请求状态为 `completed`。
- 在已有历史后发送普通消息，三个 PTY 的新增输出均不包含 `ESC[3J`。
- 终端原生 scrollback 可向上查看完整的当前内存 timeline。
- `npm run check`：67 项测试通过。

## 截图

- [群组列表](./screenshots/group-list.png)
- [聊天与 Agent 回合](./screenshots/chat-agent-roundtrip.png)
- [成员自动补全](./screenshots/member-autocomplete.png)
- [窄窗口设置](./screenshots/narrow-setup.png)
- [窄窗口聊天](./screenshots/narrow-chat.png)
- [追加式时间线（40 列）](./screenshots/chat-timeline-40.png)
- [追加式时间线（80 列）](./screenshots/chat-timeline-80.png)
- [追加式时间线（120 列）](./screenshots/chat-timeline-120.png)

阶段 11 截图由真实 Pi PTY 的终端写入日志回放生成，并向上翻了一页，用于展示原生 scrollback 中的消息布局。
