# 阶段 23：DeepSeek 多 Agent 主动路由

状态：未开始

目标：让 DeepSeek Router 可以在一次判断中选择零个、一个或多个互补 Agent，并复用阶段 22 的独立并行投递，不引入任务树或整体进度。

依赖：阶段 20、阶段 21、阶段 22

## 实施项

- [ ] 先把多选条件、目标上限、角色可见性、部分失效和验收要求写入 `SPECIFICATION.md`。
- [ ] Router 输入包含阶段 20 的群聊摘要、最近 12 条公开消息和阶段 21 的完整群组角色目录。
- [ ] Router 同时接收独立的 `eligibleAgentIds`，完整角色目录用于理解群组关系，最终只能选择 eligible Agent。
- [ ] 非 eligible Agent 的 Description 可以作为群组协作背景发送，但不得把私有 Proactive 开关值、关闭原因或其他隐藏状态发送给 DeepSeek。
- [ ] Router 输出改为严格 JSON 数组，例如 `{ "targetAgentIds": [] }`；空数组表示不邀请。
- [ ] 第一版限制每次最多选择 3 个 Agent。Prompt 要求默认选择零个或一个，只有多个 Agent 能提供不同且具体的价值时才多选。
- [ ] Router 不负责生成不同子任务；所有入选 Agent 收到相同 Observation、群聊摘要和本次共同入选的其他 Agent 列表。
- [ ] 对 Router 返回的目标 ID 去重并严格校验；未知、非 eligible、超过上限或非法类型按无效响应处理。
- [ ] Router 返回后逐个重新检查 membership、online、idle、权限、Proactive 开关和 cooldown。某个目标失效时只丢弃该目标，不改选替补，也不取消其他有效目标。
- [ ] 同一批邀请为每个目标创建独立 `proactiveId`、TTL、ACK、cooldown、Duplicate 和 Freshness 流程。
- [ ] 多个结果继续按到达 Broker 的顺序串行做 Duplicate/Freshness；先发布的回答进入后续结果的上下文。
- [ ] Freshness 不得仅因已有另一个 Agent 回答就丢弃包含独立修改、测试结果、失败或阻塞信息的回答。
- [ ] Extension 记录本次 Proactive 是否执行过工具；执行过工具或产生本地修改时，结果必须正常公开候选，不允许以 `[PI_COMMS_NO_REPLY]` 沉默。
- [ ] 日志记录一次 Router 选择的目标 ID 集合和逐目标结果，不记录成员目录、Description、摘要全文或模型 `reason`。
- [ ] 覆盖零选、单选、多选、上限、重复 ID、非法 ID、部分目标状态变化、并行结果、Freshness 顺序、工具结果保留、cooldown 和失败降级测试。
- [ ] 使用彼此独立的一次性仓库进行真实多 Agent 验收，避免多个 Agent 并行修改同一工作目录。
- [ ] 更新 README 中多 Agent Proactive 的触发边界、成本和协作行为。

## 完成条件

- [ ] DeepSeek 一次可以选择零个、一个或最多 3 个 eligible Agent。
- [ ] 入选 Agent 独立并行处理同一群聊上下文，并知道其他共同入选者。
- [ ] 单个目标失效或失败不会取消其他有效目标。
- [ ] 多个结果不会因为到达顺序而错误覆盖独立工作成果。
- [ ] Router 能理解完整群组角色关系，同时私有 Proactive 状态不泄露。
- [ ] `npm run check` 通过。
