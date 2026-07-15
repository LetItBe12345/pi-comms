# 阶段 6：SQLite 持久化

目标：在完整 TUI 前固定群聊数据边界，并支持恢复公开状态。

## 基础任务

- [x] 安装并配置 `better-sqlite3`。
- [x] 创建默认数据库 `~/.pi/comms/comms.db`。
- [x] 启用 WAL 模式。
- [x] 确保只有 Local Broker 读写数据库。

## Schema 任务

- [x] 创建 `groups` 表。
- [x] 创建 `messages` 表。
- [x] 创建 `agent_requests` 表。
- [x] 为常用查询添加必要索引。

## 持久化任务

- [x] 保存群组信息。
- [x] 保存公开群聊消息。
- [x] 保存消息发送状态。
- [x] 保存 Agent 请求和结果。
- [x] 保存 `chainId` 和通信轮数。
- [x] 从 SQLite 加载群聊历史。
- [x] 从 SQLite 恢复未完成的 Agent 请求状态。

## 数据边界验证

- [x] Extension 不直接访问数据库。
- [x] 不把全部群聊历史写入 Pi Session。
- [x] 不保存 Agent 私有上下文。
- [x] 不保存模型推理过程。
- [x] 在线连接、Socket 状态和临时队列只保存在 Broker 内存。

## 完成条件

- [x] Broker 重启后可恢复群组历史和请求状态。
- [x] 私有 Session 数据未写入数据库。

## 下一阶段

[阶段 7：最小 TUI](./07-tui.md)
