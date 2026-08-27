# 阶段 19：Proactive 默认开启

状态：已完成

## 实施项

- [x] Session 没有 `proactiveEnabled` 记录时按 `true` 处理。
- [x] 新建群组、成员和数据库记录默认开启 Proactive。
- [x] 已明确保存的 `false` 在重连后继续保持关闭。
- [x] Broker 能力状态不再阻止保存开关；只有 `ready` 状态实际调用 Router。
- [x] 旧数据库迁移仍以 `0` 增加字段，等待 Session 重连后同步权威设置。
- [x] 补充自动测试并通过完整检查。
- [x] 更新 Specification、README 和阶段 18 决策记录。

## 完成条件

- [x] 新 Session 加入群组后，无需手动开启即可成为 Proactive 候选。
- [x] 用户显式关闭后，当前连接和重连后都不会成为候选。
- [x] Router 未配置或不可用时不调用模型，但开关值可以保存。
- [x] `npm run check` 通过。
