# Proactive Agent Participation 验收记录

- 验收日期：2026-08-25
- 实现 commit：`e57da82`
- Broker 模型：`deepseek-v4-flash`
- API 地址：`https://api.deepseek.com`
- Key 状态：已验证，遮罩值 `****d905`

## 真实 Provider

- 数据库迁移问题在数据库 Agent 和 TUI Agent 之间选中数据库 Agent。
- 寒暄返回 `null`。
- 原问题已被新消息明确解决时，Freshness 返回 `publish: false`。
- Key 和完整 Prompt 未写入测试日志或仓库。

## 一次性仓库

验收使用三个独立的一次性 Git 仓库和三个本地 bare remote，没有连接 GitHub。

- Proactive Invitation 允许 Session 把本地文件从 `status=pending` 改为 `status=done`。
- Remote Request 允许 Session 把本地文件改为 `status=explicit-done`。
- 在 Proactive 修改后、后续任务完成前中断 Session，本地保留 `status=started`，未回滚。
- 三个 bare remote 的 `main` 均保持初始 commit，没有自动 push。
- 验收目录已移入系统回收站。

## 自动检查

`npm run check` 通过：

- TypeScript 类型检查通过。
- 135 个单元测试通过，1 个按原有条件跳过。
- 17 个端到端测试通过。
- CI 中的 Proactive 测试使用 Fake Router 或本地 HTTP mock，不读取真实 Key。
