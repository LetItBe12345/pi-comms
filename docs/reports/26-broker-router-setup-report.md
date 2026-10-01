# 阶段 26 实现与测试报告

日期：2026-10-01。准备版本：v0.3.1。

## 发现与实现

README 原本写有首页「Broker 设置」，实际 GroupPicker 没有入口。群内已有入口，但直接打开
Pi 对话框会替换 ChatView，结束后无法恢复。「重新验证」也错误地要求输入新 Key。

现已增加首页入口，支持未建群配置；设置页显示 DeepSeek V4.1 Flash、中文状态和脱敏 Key。
提供配置说明和准备、输入、验证保存三步引导，成功后提示检查 Ctrl+P 的主动参与开关。
群内设置采用先结束当前视图、打开设置、再重建 ChatView 的顺序，保留群组和名称。

Broker 支持空 payload 验证已保存 Key，验证成功持久化为 verified，兼容旧的显式 Key 请求。
配置保存、重建和删除后向所有连接广播状态。官方模型名仍为 deepseek-flash，
没有改动 Router 模型请求。README、Specification 和独立配置文档已同步。

## 验证

- Node 22 下 npm run check：类型检查、172 项单元与集成测试、20 项既有 E2E 全部通过；
  1 项既有环境条件测试跳过。
- 隔离目录 npm ci --omit=dev 通过，未安装 Pi 开发包；Broker 临时端口启动成功，生产依赖审计 0 个漏洞。
- 新增测试覆盖配置确认、取消不提交、重新验证不输入 Key、失败不误报成功、
  两个真实 TCP Session 的已保存 Key 验证、失效和删除广播、首页键盘入口。
- 用 execution command 创建两份 Pi 0.99.2 PTY，持续 write_stdin 操作真实 TUI。
- 首轮不启用测试命令，Alice 在实际首页配置；Bob 看到同一 Broker 已就绪并重新验证。
  Alice 从实际 UI 创建 RouterSetup，Bob 从本机群组列表加入，显示在线 2 人。
- 复测群 RouterRetest：双方进入同群，Alice 从 Ctrl+P 完成三步配置后回到 ChatView。
  Bob 的设置页即时显示已就绪，重新验证后同样回到 ChatView。
- Alice @Bob-Pi，真实 Pi 原生 MCP 执行两个 Tool、两个 Resource，回复 MCP_E2E_PASS。
  四次调用成功；日志见 [Bob MCP 调用](./26-router-e2e-bob.jsonl)。
- Bob 删除 Key 后返回 ChatView；Alice 打开设置看到未配置且不再显示旧 Key。
  Alice 取消设置后回到群聊，普通消息发送成功。

测试使用隔离临时数据库与配置、确定性模型 Provider 和 FakeProactiveRouter。
验证了实际 TUI、Extension、TCP 和 MCP 链路，没有使用用户真实 Key，也没有发起收费 DeepSeek 请求。
不是第二台物理设备或真实 DeepSeek 账户权限验收。测试 Session 和 Broker 均已关闭。

## 复现

使用 tests/fixtures/mcp-tui-broker.ts，设置 PI_COMMS_E2E_ROUTER=1 使用假 Router。
两个终端分别使用独立 PI_CODING_AGENT_DIR，按阶段 25 报告的 Pi CLI 命令启动
tests/fixtures/mcp-tui-extension.ts。设置 PI_COMMS_E2E_HOME=1 可从实际首页开始，
不设置则保留测试创建、入群命令。端口与数据库通过 PI_COMMS_E2E_PORT、PI_COMMS_E2E_DB 指定。
