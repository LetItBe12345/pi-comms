# 阶段 1：普通 Node.js 通信验证

目标：两个普通客户端通过 Local Broker 互发消息，不接 Pi 和数据库。

## 任务

- [x] 创建 `src/protocol.ts`。
- [x] 定义统一 Envelope 和最小消息类型。
- [x] 实现 JSONL 编码、增量解码和粘包/拆包处理。
- [x] 创建 `src/broker/server.ts`。
- [x] 在 `~/.pi/comms/broker.sock` 建立 Unix Domain Socket。
- [x] 实现客户端连接和断开处理。
- [x] 实现公开广播。
- [x] 实现基于内部 ID 的简单定向发送。
- [x] 创建测试客户端 A 和 B。

## 完成条件

- [x] A 和 B 都能连接 Broker。
- [x] A 发出的公开消息能被两个客户端看到。
- [x] A 发给 B 的定向消息只到达 B。
- [x] 客户端断开不会导致 Broker 崩溃。

## 下一阶段

[阶段 2：Pi Extension 最小验证](../in-progress/02-pi-extension.md)
