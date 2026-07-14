# 阶段 6：SQLite 持久化

目标：在完整 TUI 前固定群聊数据边界，并支持恢复公开状态。

## 基础任务

- [ ] 安装并配置 `better-sqlite3`。
- [ ] 创建默认数据库 `~/.pi/comms/comms.db`。
- [ ] 启用 WAL 模式。
- [ ] 确保只有 Local Broker 读写数据库。

## Schema 任务

- [ ] 创建 `groups` 表。
- [ ] 创建 `messages` 表。
- [ ] 创建 `agent_requests` 表。
- [ ] 为常用查询添加必要索引。

## 持久化任务

- [ ] 保存群组信息。
- [ ] 保存公开群聊消息。
- [ ] 保存消息发送状态。
- [ ] 保存 Agent 请求和结果。
- [ ] 保存 `chainId` 和通信轮数。
- [ ] 从 SQLite 加载群聊历史。
- [ ] 从 SQLite 恢复未完成的 Agent 请求状态。

## 数据边界验证

- [ ] Extension 不直接访问数据库。
- [ ] 不把全部群聊历史写入 Pi Session。
- [ ] 不保存 Agent 私有上下文。
- [ ] 不保存模型推理过程。
- [ ] 在线连接、Socket 状态和临时队列只保存在 Broker 内存。

## 完成条件

- [ ] Broker 重启后可恢复群组历史和请求状态。
- [ ] 私有 Session 数据未写入数据库。

## 下一阶段

[阶段 7：最小 TUI](./07-tui.md)
