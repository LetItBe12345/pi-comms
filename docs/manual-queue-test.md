# 阶段 4：双 Pi 队列手动测试

阶段 4 实现完成后执行。2026-07-15 已完成一次本地验收。

## 启动

打开三个终端，都进入项目目录。

终端 1：

```bash
npm run broker
```

终端 2 和终端 3：

```bash
pi -e ./src/extension/index.ts
```

两个 Pi 都显示 `Broker 已连接` 后，记录终端 3 的完整 `Client` ID，把它作为 B。

## 测试

在终端 2 的 Pi（A）中连续发送以下命令，不等待上一条回答：

```text
/comms-test @<B_CLIENT_ID> 只回复 QUEUE-1
/comms-test @<B_CLIENT_ID> 只回复 QUEUE-2
/comms-test @<B_CLIENT_ID> 只回复 QUEUE-3
```

将 `<B_CLIENT_ID>` 替换为 B 的完整 Client ID。

## 通过条件

- A 和 B 都能看到三条公开请求。
- 只有 B 的 Agent 处理请求。
- B 按 `QUEUE-1`、`QUEUE-2`、`QUEUE-3` 顺序逐条回答。
- 每条回答只公开一次。
- 不出现“目标 Agent 正忙”。
- 三条回答结束后，B 可以继续接收新请求。
