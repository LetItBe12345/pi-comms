# 阶段 6：SQLite 手动测试

2026-07-15 已使用两个真实 Pi 完成一次验收。

## 启动

终端 1：

```bash
npm run broker
```

终端 2、3：

```bash
pi -e ./src/extension/index.ts
```

创建群组，让两个 Pi 加入，并发送普通消息和 `@Agent` 请求。

## 重启

停止终端 1，再次运行 `npm run broker`。

## 通过条件

- 两个 Pi 自动重连并重新加入原群组。
- 提示已加载历史消息数量。
- 重启前未完成的请求不会再次注入。
- 重启后可以继续发送消息和 `@Agent` 请求。
- 数据库存在于 `~/.pi/comms/comms.db`。
