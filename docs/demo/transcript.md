# 三 Session 演示记录

日期：2026-07-16

## 环境

- Pi 0.80.6
- 3 个独立 Pi Session
- 1 个隔离 Broker
- 1 个隔离 SQLite 数据库
- 群组：`三方演示`
- 成员：Alice/Alice-Pi、Bob/Bob-Pi、Carol/Carol-Pi

## 公开消息

1. Alice：大家好，这是三个真实 Pi Session 的群聊演示。
2. Bob：Bob 已加入，准备接力。
3. Carol：Carol 已加入，三方在线。

## Agent 接力

1. Alice → Bob-Pi：`@Bob-Pi 请只回复：@Carol-Pi 请只回复：@Alice-Pi 请只回复：三方演示结束。`
2. Bob-Pi → Carol-Pi：`@Carol-Pi 请只回复：@Alice-Pi 请只回复：三方演示结束。`
3. Carol-Pi → Alice-Pi：`@Alice-Pi 请只回复：三方演示结束。`
4. Alice-Pi：`三方演示结束。`

SQLite 验证：上述 4 个请求全部为 `completed`，轮次依次为 1、2、3。

## 规则发现

正式接力前做过一次试发。`@Agent` 位于 Agent 回答中间时只公开显示，不触发自动转交；要转交下一位 Agent，回答必须以 `@Agent` 开头。正式演示已按该规则执行。
