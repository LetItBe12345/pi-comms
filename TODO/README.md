# Pi Comms TODO 总览

规格与约束见 [SPECIFICATION.md](../SPECIFICATION.md)。本目录只存放可执行任务。

## 状态分类

- [in-progress](./in-progress/README.md)：未开始或正在实施的任务。
- [done](./done/README.md)：已经满足完成条件的任务。

任务完成后，将整个任务文件从 `in-progress/` 移到 `done/`，并更新本页链接和状态。

## 执行顺序

| 阶段 | 文件 | 目标 | 状态 | 依赖 |
| --- | --- | --- | --- | --- |
| 0 | [环境准备](./done/00-environment.md) | 准备可运行的开发环境 | done | 无 |
| 1 | [Node.js 通信验证](./done/01-node-broker.md) | 两个普通客户端经 Broker 通信 | done | 阶段 0 |
| 2 | [Pi Extension 最小验证](./in-progress/02-pi-extension.md) | Extension 能连接 Broker | in-progress | 阶段 1 |
| 3 | [远程 Agent 闭环](./in-progress/03-agent-roundtrip.md) | A 请求 B，并收到唯一回答 | in-progress | 阶段 2 |
| 4 | [队列与稳定性](./in-progress/04-queue-reliability.md) | 串行处理、断线恢复、去重 | in-progress | 阶段 3 |
| 5 | [群组与成员](./in-progress/05-groups-members.md) | 建立群组和双成员模型 | in-progress | 阶段 4 |
| 6 | [SQLite 持久化](./in-progress/06-sqlite.md) | 固定持久化边界 | in-progress | 阶段 5 |
| 7 | [最小 TUI](./in-progress/07-tui.md) | 提供可用的群聊界面 | in-progress | 阶段 6 |
| 8 | [权限系统](./in-progress/08-permissions.md) | 支持三种 Agent 接收权限 | in-progress | 阶段 7 |
| 9 | [Agent 对 Agent](./in-progress/09-agent-to-agent.md) | 支持最多 10 轮自动通信 | in-progress | 阶段 8 |
| 10 | [测试与验收](./in-progress/10-testing-acceptance.md) | 满足 MVP 完成定义 | in-progress | 阶段 9 |

## 当前最小里程碑

先完成阶段 0～3，只创建核心实现文件：

```text
src/protocol.ts
src/broker/server.ts
src/extension/index.ts
```

这个里程碑不做完整 TUI、多群组、权限系统、Agent 对 Agent、持久化和跨设备通信。

## 维护规则

- 每个任务文件只维护一个阶段。
- 勾选项必须是可以实施或验证的动作。
- 产品行为、技术约束和数据定义写入 `SPECIFICATION.md`，不要重复写入 TODO。
- 新阶段需在本总览中登记目标和依赖。
- 任务未完成时放在 `in-progress/`，完成后移到 `done/`。
