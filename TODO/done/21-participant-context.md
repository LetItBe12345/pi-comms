# 阶段 21：完整群组角色上下文

状态：已完成

目标：让收到显式请求或 Proactive 邀请的 Coding Agent 看见群内完整角色、真人用户与 Agent 的所属关系，以及每个 Agent 的 Description，从而能正确判断协作和转交对象。

依赖：阶段 20

## 实施项

- [x] 先把角色目录的公开字段、隐私边界、刷新时机和验收要求写入 `SPECIFICATION.md`。
- [x] 定义结构化群组角色目录，明确每个长期成员中的真人用户、所属 Agent、群主身份、在线状态、Agent 活动状态、接收能力和 Agent Description。
- [x] 角色目录包含在线与离线的长期成员；已被移出或不再属于群组的成员不得出现。
- [x] 明确用户与 Agent 的所属关系，不再只传递扁平的名称和 `user | agent` 类型列表。
- [x] 对其他成员继续隐藏真实 `proactiveEnabled`；只提供协作所需的统一可用状态，不暴露关闭原因。
- [x] 未加入群组的附近设备、邀请信息和目录查询继续不得获得成员列表或 Description。
- [x] 显式 `[Pi Comms Remote Request]` 注入完整角色目录和 Description。
- [x] `[Pi Comms Proactive Invitation]` 注入相同格式的完整角色目录和 Description。
- [x] Agent 开始实际处理排队请求时使用最新角色目录，避免长期排队后仍使用过期的在线或 busy 状态。
- [x] 稳定 Session 提示词说明角色目录只用于选择协作者，在线、空闲和接收能力仍需由 Broker 在实际转交时重新验证。
- [x] 扩展协议版本并为旧版本握手提供明确的不兼容提示。
- [x] 覆盖在线、离线、群主、用户—Agent 配对、Description、成员移除、权限隐藏、排队后刷新和跨设备 Snapshot 测试。
- [x] 更新 README 中 Agent 可见的群组上下文说明。

## 完成条件

- [x] 显式请求和 Proactive 邀请中的 Coding Agent 都能看到所有有效长期成员及用户—Agent 关系。
- [x] Coding Agent 能看到每个 Agent 的 Description，并能区分在线、离线、idle、busy 和暂不可接收。
- [x] 其他成员的私有 Proactive 开关和原因不泄露。
- [x] 成员变化后，新开始的任务使用最新角色目录。
- [x] `npm run check` 通过。
