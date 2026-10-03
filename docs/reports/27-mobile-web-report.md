# 阶段 27：手机 Web 实现与本地验收

日期：2026-10-03。对应 [Issue #46](https://github.com/LetItBe12345/pi-comms/issues/46)。

## 实现

手机作为 human-only 长期成员加入；数据库迁移到 v12，协议升为 9。
Web HTTP / WebSocket 在 Broker 内运行，正式固定 43128，端口失败不影响 TCP。
TCP 和 WebSocket 通过 ClientPeer 直接共享消息、持久化、presence、chain 和生命周期。
网页使用原生 JS，支持刷新恢复、最新标签页接管、显式退出和自己的接力决定。
TUI 保留 Pi 邀请信息，增加手机 URL / QR；local 群先复用附近开放流程。
依赖复用 [ws](https://github.com/websockets/ws) 和 [qrcode](https://github.com/soldair/node-qrcode)。

## 实测中发现并修复

- 浏览器断网不保证已有 WebSocket 马上关闭：监听 offline / online，立即禁止发送并自动恢复。
- 普通 LAN HTTP 无法使用 crypto.randomUUID：使用 crypto.getRandomValues 生成身份。
- 首次附近开放的原生确认框会退出 ChatView：网络确认改在聊天面板完成，确认后仍显示二维码，Esc 返回。
- 标签页接管必须在长期成员凭证校验后执行；错误凭证不能挤掉已在线页面。
- Join 页未入群时的 ping 也要返回 pong，避免用户填写用户名时收到无关错误。
- 群改为仅本机后停止浏览器重连并禁止发送；重连也必须等恢复快照后才允许发送。
- QR 保留四模块白色 quiet zone，不裁掉末尾空白行。

## 自动化

Node 22.23.3 下 npm run check 通过：178 项单元 / 集成测试、33 项 E2E。
1 项原有环境条件测试跳过。最后的页面连接状态修改另跑 Chromium E2E 和 typecheck 通过。浏览器使用本机 Chromium，390×844 / 360×800 视口、两个独立 browser context。

新增覆盖：

- Pi / human-only 名称冲突、在线 / 离线、目录与 DB v11 → v12 原行保留。
- 静态资源、网络未确认拒绝、网络失效断开、local 群拒绝、邀请码轮换与失败限流。
- 受限协议拒绝 Agent / Broker 管理和 MCP，错误凭证不能接管。
- 两个用户同 URL 加入、中文公开消息广播、@Agent 投递与回传。
- 刷新恢复、最新标签页接管、断网恢复、确认退出和同 origin Broker 重启。
- Agent 接力到 10 轮暂停；原发起者继续到 20 轮并结束；其他手机不能控制。
- 浏览器页面实际点击“继续 / 结束”，其他用户没有对应按钮。
- 手机独自在线时 Broker 保持存活；全部离线后按 idle 规则关闭且身份保留。
- 移出成员 / 解散群组明确关闭 Web；端口占用时 TCP 仍启动并报告原因。
- TUI 首次网络确认不退出 ChatView、local 开放后显示 QR、返回和 human-only 显示。

独立临时目录 npm ci --omit=dev 通过，生产依赖审计 0 个漏洞。
不安装 Pi 开发依赖的情况下，实际 Broker 启动、静态 HTML / JS / CSS 全部返回 200，runtime metadata 包含 Web 端口。
CI 和手动 release 工作流加入浏览器安装及 Web 生产 smoke；没有触发发布。

## 真实 Pi CLI 闭环

运行实际 Pi 0.99.2 PTY，加载真实 Extension 与 builtin MCP；模型使用现有确定性 mcp-e2e/proof Provider。
两份真实 Chromium 页面作为 PhoneBob / PhoneCarol 加入，同一邀请产生两个 human-only membership。
PhoneBob 普通消息到达 PhoneCarol 和桌面。PhoneCarol @Alice-Pi，Pi 执行两个 direct MCP tool 与两个 resource 读取；四次成功。
角色上下文包含两名 Web 用户且 agent absent。最终 MCP_E2E_PASS 回传到两个浏览器页面。

另起实际 Pi TUI，local 群选择“手机扫码加入”，首次网络确认留在 ChatView。
确认后自动显示完整黑白二维码与普通 LAN URL，Esc 返回附近加入面板。

证据：

- [浏览器结果](./27-mobile-pi-browser.json)
- [真实 Pi 工具日志](./27-mobile-pi-tools.jsonl)
- [加入页面](../screenshots/27-web-join.png)
- [浏览器群聊](../screenshots/27-web-chat.png)
- [接管提示](../screenshots/27-web-takeover.png)
- [接力暂停](../screenshots/27-web-chain-paused.png)
- [重启恢复](../screenshots/27-web-restored.png)
- [真实 Pi 回答](../screenshots/27-web-real-pi.png)

## 验收边界

桌面浏览器控制连接不可用，因此浏览器交互使用独立 headless Chromium 测试程序；不是 Android 手机或跨物理设备 Wi-Fi 验收。
真实 Pi 的模型 Provider 为确定性替身，没有调用收费模型。
测试使用隔离数据库 / 配置 / Pi Session；临时 Pi、浏览器和 Broker 已关闭。
真实 Android Chrome 扫码、两台物理手机、锁屏 / 切后台和真实模型仍由用户接管。
TODO 保留在 in-progress，未把 Issue 标记完成。接管步骤见 [手机验收](../mobile-web-acceptance.md)。
