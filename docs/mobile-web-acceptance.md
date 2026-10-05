# 手机 Web 验收

当前实现对应 [Issue #46](https://github.com/LetItBe12345/pi-comms/issues/46)。
本地测试结果见 [阶段 27 报告](./reports/27-mobile-web-report.md)。真实 Android / Wi-Fi 验收尚未完成。

## 接管步骤

1. 使用本分支的 Extension，在 Pi 中 `/reload`。若旧 Broker 仍运行，先退出其他旧 Pi Session，再重启 Broker；本次协议由 8 升为 9，旧 Broker 不能和新 Extension 混用。
2. `/comms` 创建或恢复一个群，打开 `Ctrl+G → 附近加入 → 手机扫码加入`。
3. local 群先确认允许当前普通网络。系统复用现有 lan-host 切换流程，不增加邀请码选择。
4. 手机和主机连接同一普通 Wi-Fi。Android Chrome 扫码，确认网页群名，输入用户名后加入。
5. 二维码旁的网址可以直接打开。正式 Web 端口固定为 `43128`；看到端口占用提示时，释放该端口再重启 Broker。

手机只创建人类成员，不配置 Agent。不同手机可以扫描同一个二维码，分别使用不同名称。
清理浏览器站点数据会丢失凭证；仅刷新或关闭页面不会退出群组。

## 真实设备检查

- [ ] 一台 macOS / Linux 主机，两台 Android Chrome；同一二维码加入为两个不同人类成员。
- [ ] 两台手机互发中文和多行文本；桌面 Pi 同时收到。
- [ ] 手机发送 `@现有Agent名称 任务`，Pi 处理后两台手机都看到回答。
- [ ] 刷新 / 再扫码自动恢复，不重复创建成员。
- [ ] 锁屏、切后台、断 Wi-Fi 后恢复；离线不能发送，恢复后历史仍在。
- [ ] 同一浏览器打开第二标签页，新页接管；旧页显示接管提示、禁止发送且不反复争抢连接。
- [ ] “退出群组”先取消，再确认；确认后成员身份删除，再扫码需输入用户名。
- [ ] 手机发起的 Agent 接力暂停时可继续 / 结束；另一个手机不能操作它。
- [ ] Broker 重启后仍是同一 `:43128` origin，长期 Web 身份和历史恢复。
- [ ] 需要邀请码的群轮换邀请码，旧二维码不能创建新成员，已有成员仍可恢复。
- [ ] 群改为“仅这台电脑”、解散、移出成员后对应手机连接明确关闭。

## 本地自动化复现

```bash
npm ci
npx playwright install --with-deps chromium
npm run check
```

Linux 已装 Chromium 时可设置 `PI_COMMS_TEST_CHROMIUM=/usr/bin/chromium`。
设置 `PI_COMMS_BROWSER_ARTIFACTS=/tmp/mobile-screenshots` 保留自动测试截图。
测试使用临时数据库、两个独立浏览器 context 和移动视口，结束后自动清理。
自动浏览器测试中的 Agent 回复是协议测试替身；下面的复测使用真实 Pi CLI 与确定性模型 Provider。

## 真实 Pi CLI + 浏览器复现

参考 [阶段 25 启动命令](./reports/25-broker-mcp-report.md#复现)。

1. 创建临时目录，设置 `PI_COMMS_E2E_DB`、`PI_COMMS_E2E_STATE` 和 `PI_COMMS_E2E_MODE=lan`，运行 `node --import tsx tests/fixtures/mcp-tui-broker.ts`。
2. 从输出读取 `tcpPort` 和 `webPort`。设置 `PI_COMMS_E2E_PORT=<tcpPort>`，使用独立 `PI_CODING_AGENT_DIR`，启动 Pi 0.99.2 和 `tests/fixtures/mcp-tui-extension.ts`，Provider 使用 `mcp-e2e/proof`。不要使用生产 Session。
3. 输入 `/comms-create MobilePi Alice Alice-Pi`，然后 `/comms`。在真实 TUI 选择手机扫码加入，完成网络确认。
4. 使用显示的手机 URL 运行：

```bash
node --import tsx tests/fixtures/mobile-pi-browser.ts 'http://<host>:<webPort>/#/join/<groupId>'
```

此脚本以两个窄屏浏览器加入、互发文本、请求 Alice-Pi 读取 MCP，等待两个页面显示 `MCP_E2E_PASS`。
这是实际 Pi Extension / 工具分发 / Broker / Web UI 闭环，模型使用确定性 Provider，不调用收费模型。
测试结束后关闭 Pi 和临时 Broker。
