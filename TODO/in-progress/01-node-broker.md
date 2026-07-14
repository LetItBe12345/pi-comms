# 阶段 1：普通 Node.js 通信验证

目标：两个普通客户端通过 Local Broker 互发消息，不接 Pi 和数据库。

## 任务

- [ ] 创建 `src/protocol.ts`。
- [ ] 定义统一 Envelope 和最小消息类型。
- [ ] 实现 JSONL 编码、增量解码和粘包/拆包处理。
- [ ] 创建 `src/broker/server.ts`。
- [ ] 在 `~/.pi/comms/broker.sock` 建立 Unix Domain Socket。
- [ ] 实现客户端连接和断开处理。
- [ ] 实现公开广播。
- [ ] 实现基于内部 ID 的简单定向发送。
- [ ] 创建测试客户端 A 和 B。

## 完成条件

- [ ] A 和 B 都能连接 Broker。
- [ ] A 发出的公开消息能被两个客户端看到。
- [ ] A 发给 B 的定向消息只到达 B。
- [ ] 客户端断开不会导致 Broker 崩溃。

## 下一阶段

[阶段 2：Pi Extension 最小验证](./02-pi-extension.md)
