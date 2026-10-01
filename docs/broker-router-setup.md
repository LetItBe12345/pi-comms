# 配置 Broker 的 DeepSeek V4.1 Flash

Broker 使用独立的 DeepSeek Key，负责主动参与路由、新消息判断和群聊摘要。
Pi Session 的 `/login` 和 `/model` 配置不影响 Broker。

官方 API 地址为 `https://api.deepseek.com`，模型名为 `deepseek-flash`。
[DeepSeek 官方说明](https://api-docs.deepseek.com/zh-cn/news/news260910/)确认此名称调用 V4.1 Flash。
这里不需要填写模型名或自定义 endpoint。

## 首次配置

1. 在 Broker 所在电脑启动 Pi，输入 `/comms`。
2. 在首页「其他操作」选择「Broker 设置」。尚未创建群组也可以配置。
3. 选择「配置或更换 API Key」。
4. 第 1 步：打开 https://platform.deepseek.com/api_keys，创建 Key，并确认账户有额度。
5. 第 2 步：输入 Key。
6. 第 3 步：确认验证并保存。会向官方 API 发送一次小请求，可能产生少量费用。
7. 看到「已就绪」后进入群聊，在 `Ctrl+P` 中检查「主动参与」开关。

设置页的「查看配置说明」也提供这些步骤。群内可以用 `Ctrl+P` →「Broker 设置」进入；
完成或取消后回到群聊。附近加入的远程用户需要请 Broker 主机用户配置。

Key 保存在 Broker 主机的 `~/.pi/comms/config.json`，不写入群聊或 Pi 会话。
环境变量 `DEEPSEEK_API_KEY` 的导入方式见 [README](../README.md#从环境变量导入)。

## 已有配置

- 「重新验证 API Key」直接验证 Broker 已保存的 Key，不需要再输入。成功后将未验证配置更新为已验证。
- 「配置或更换 API Key」按相同向导更换 Key。已有有效 Key 不会被未验证的新 Key 覆盖。
- 「删除 API Key」停止主动参与，普通群聊和显式 `@Agent` 仍可用。
- 配置改变后，其他连接的 Session 会同步收到新状态。

## 状态与处理

| 状态 | 下一步 |
| --- | --- |
| 未配置 | 配置 Key |
| Key 尚未验证 | 网络恢复后重新验证；当前不能主动参与 |
| Key 已失效 | 检查账户和额度，更换或重新验证 Key |
| 暂时不可用 | 检查网络、限流和官方服务，再重新验证 |
| 配置文件无法读取 | 按提示重建；原文件先备份 |
| 已就绪 | 入群并检查主动参与开关；下一条新人类消息才触发路由 |
