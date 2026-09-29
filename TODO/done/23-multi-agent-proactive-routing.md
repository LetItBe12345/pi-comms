# 阶段 23：DeepSeek 多 Agent 主动路由

状态：已完成

目标：让 DeepSeek Router 可以在一次判断中选择零个、一个或多个互补 Agent，并复用阶段 22 的独立并行投递，不引入任务树或整体进度。

依赖：阶段 20、阶段 21、阶段 22

## 实施项

- [x] 先把多选条件、目标上限、角色可见性、部分失效和验收要求写入 `SPECIFICATION.md`。
- [x] Router 输入包含阶段 20 的群聊摘要、最近 12 条公开消息和阶段 21 的完整群组角色目录。
- [x] Router 同时接收独立的 `eligibleAgentIds`，完整角色目录用于理解群组关系，最终只能选择 eligible Agent。
- [x] 非 eligible Agent 的 Description 可以作为群组协作背景发送，但不得把私有 Proactive 开关值、关闭原因或其他隐藏状态发送给 DeepSeek。
- [x] Router 输出改为严格 JSON 数组，例如 `{ "targetAgentIds": [] }`；空数组表示不邀请。
- [x] 第一版限制每次最多选择 3 个 Agent。Prompt 要求默认选择零个或一个，只有多个 Agent 能提供不同且具体的价值时才多选。
- [x] Router 不负责生成不同子任务；所有入选 Agent 收到相同 Observation、群聊摘要和本次共同入选的其他 Agent 列表。
- [x] 对 Router 返回的目标 ID 去重并严格校验；未知、非 eligible、超过上限或非法类型按无效响应处理。
- [x] Router 返回后逐个重新检查 membership、online、idle、权限、Proactive 开关和 cooldown。某个目标失效时只丢弃该目标，不改选替补，也不取消其他有效目标。
- [x] 同一批邀请为每个目标创建独立 `proactiveId`、TTL、ACK、cooldown、Duplicate 和 Freshness 流程。
- [x] 多个结果继续按到达 Broker 的顺序串行做 Duplicate/Freshness；先发布的回答进入后续结果的上下文。
- [x] Freshness 不得仅因已有另一个 Agent 回答就丢弃包含独立修改、测试结果、失败或阻塞信息的回答。
- [x] Extension 记录本次 Proactive 是否执行过工具；执行过工具或产生本地修改时，结果必须正常公开候选，不允许以 `[PI_COMMS_NO_REPLY]` 沉默。
- [x] 日志记录一次 Router 选择的目标 ID 集合和逐目标结果，不记录成员目录、Description、摘要全文或模型 `reason`。
- [x] 覆盖零选、单选、多选、上限、重复 ID、非法 ID、部分目标状态变化、并行结果、Freshness 顺序、工具结果保留、cooldown 和失败降级测试。
- [x] 使用彼此独立的一次性仓库进行真实多 Agent 验收，避免多个 Agent 并行修改同一工作目录。
- [x] 更新 README 中多 Agent Proactive 的触发边界、成本和协作行为。

## 完成条件

- [x] DeepSeek 一次可以选择零个、一个或最多 3 个 eligible Agent。
- [x] 入选 Agent 独立并行处理同一群聊上下文，并知道其他共同入选者。
- [x] 单个目标失效或失败不会取消其他有效目标。
- [x] 多个结果不会因为到达顺序而错误覆盖独立工作成果。
- [x] Router 能理解完整群组角色关系，同时私有 Proactive 状态不泄露。
- [x] `npm run check` 通过。

## 真实验收记录

- 环境：3 个真实 Pi 会话，各自使用独立的一次性 `git worktree`（backend / testing / docs），共用同一 Broker。
- Router 走真实 DeepSeek：`proactive.router.selected` 一次选中 2 个目标，每个目标独立 `proactiveId`，全部 ACK 后逐个发布结果。
- 收到的 Proactive 邀请里包含「共同接收者」及排队/审批提醒；两个 Agent 只修改各自 worktree，主仓库未被改动。
- 两个结果按到达顺序串行通过 Freshness 后都正常公开，后来者没有覆盖先发布的成果。
- 单个目标失败（`no_text`）不影响同批其他目标；日志只记录目标 ID 与逐目标结果。
