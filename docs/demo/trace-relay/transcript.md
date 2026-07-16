# TRACE RELAY 实机记录

执行日期：2026-07-17

## 发行环境

- Pi CLI：`0.80.9`
- Pi Comms：`git:github.com/LetItBe12345/pi-comms@v0.1.0`
- 使用已发布的 Git Tag，不使用本仓库开发代码。

## 三个隔离仓库

| 用户 | Pi Session | 私有仓 | 修改文件 |
| --- | --- | --- | --- |
| Edge-Ada | `TRACE-EDGE-PRIVATE` | `edge-gateway` | `src/gateway.js` |
| Order-Lin | `TRACE-ORDER-PRIVATE` | `order-worker` | `src/worker.js` |
| Notify-Mia | `TRACE-NOTIFY-PRIVATE` | `notify-service` | `src/audit.js` |

三个目录都有独立 `.git`，Agent 指令明确限制只能访问和修改当前仓。

## 自动接力

群组：`TRACE-RELAY-2049`

1. Notify-Mia 向 `@Edge-Ada-Pi` 发出 INC-2049，要求修复入口 `x-trace-id`。
2. Edge Agent 只修改 `edge-gateway`，`npm test` 通过；随后向 `@Order-Lin-Pi` 传递 `checkout.requested` 完整契约。
3. Order Agent 只修改 `order-worker`，`npm test` 通过；随后向 `@Notify-Mia-Pi` 传递 `order.accepted` 完整契约。
4. Notify Agent 只修改 `notify-service`，测试和 Demo 均通过。

贯穿全链路的字段：`trace_id: "trc-7f3a"`。

最终输出：

```text
[TRACE trc-7f3a] [ORDER ord-cart-2049] accepted amount=12900
```

## 验证

- SQLite 中 3 个 Agent Request 均为 `completed`，轮次为 1、2、3。
- 三个仓的 `npm test` 分别通过，均为 1/1。
- 每个仓仅有一个预期源码文件发生修改。
- 三个 Pi Session 已正常退出，并保留各自可恢复的 Session ID。
