# MVP 验收记录

日期：2026-07-15

## 自动验收

- 环境：Node.js 22、Pi 0.80.6、临时 Unix Socket、临时 SQLite。
- `tests/acceptance.test.ts`：双 Extension、公开消息、定向注入、FIFO、唯一回答、私聊隔离、离线失败。
- `tests/database.test.ts`：v2 → v3 迁移保留群组、公开历史和请求结果。
- 其余协议、Broker、权限、TUI、10 轮暂停测试继续复用。

## 双 Pi 验收

- Alice/Alice-Pi 与 Bob/Bob-Pi 加入 `MVP验收`。
- 小写 `alice` 名称冲突被拒绝。
- `@Bob-Pi 检查当前项目的 package.json` 只注入 Bob，回答公开且仅一次。
- 连续请求按 `SLOW-1 → QUEUE-5 → QUEUE-6` 处理。
- 自动接收、需要批准、禁止接收均通过。
- Bob 离群后请求立即失败；私人回答 `PRIVATE-ONLY-10` 未进入群聊和 SQLite。
- Broker 停止后两端进入重连；重启后自动入群并正常发送 `RESTART-OK`。
- Esc 返回 Pi，Ctrl+D 正常结束进程。

SQLite 结果：9 个请求完成，1 个被禁止，1 个目标离线；私人消息泄漏数为 0。

## 视觉快照

- [公开消息与 Agent 回答](./screenshots/chat-agent-roundtrip.png)
- [待批准请求](./screenshots/pending-approval.png)
- [禁止接收与离线失败](./screenshots/stage10-failure.png)
- [Broker 重连状态](./screenshots/stage10-reconnecting.png)

## 结论

阶段 10 和 MVP 完成定义已满足。
