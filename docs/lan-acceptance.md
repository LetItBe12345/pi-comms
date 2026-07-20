# 局域网验收指南

本指南用于阶段 16B 的三台真实设备验收。GitHub Actions 和单机三进程只能做准备，
不能代替真实 macOS/Linux 局域网。

## 1. 准备

- A：macOS，第一轮创建群组。
- B：Ubuntu/Linux，远程加入。
- C：macOS 或 Ubuntu/Linux，远程加入。
- 三台设备连接同一个普通 Wi-Fi 或有线 IPv4 网络。
- 三台设备使用相同的 Pi 正式版和 Pi Comms commit SHA。
- B、C 中至少一台可以开关 VPN。

固定待发行版本：

```bash
pi install git:github.com/LetItBe12345/pi-comms@<commit-sha>
```

验收时不要同时加载项目 `.pi/extensions/` 或 `pi -e` 开发版。

## 2. 生成三个私有代码仓库

在三台设备上分别执行：

```bash
npm run accept:lan -- --role A
npm run accept:lan -- --role B
npm run accept:lan -- --role C
```

工具会检查普通网络、TCP、附近发现端口和 VPN 状态，生成角色仓库以及脱敏
Markdown 报告。环境预检通过不等于真实设备验收通过。

GitHub CI 还会运行本机 mDNS 诊断。托管 runner 不回送组播时，该步骤会明确报告
跳过原因；它不代替另一台真实设备的发现结果。

## 3. 核心流程

1. A 打开 `/comms`，创建允许附近加入的群组。
2. B、C 在 10 秒内从“附近群组”看到该群。
3. B、C 输入该群的邀请码并在 5 秒内加入。
4. A 公开需求，并向 B-Pi 发送服务端任务。
5. B-Pi 修改 B 的私有仓库，再把任务转交 C-Pi。
6. C-Pi 修改 C 的私有仓库，运行测试并公开最终结果。
7. 确认回答只出现一次，并能对应 A 的原始任务。

## 4. 恢复与网络

- 依次验证断网、重连和身份恢复。
- 关闭、开启、再次关闭 VPN；VPN 允许本地网络时群聊应继续工作。
- 切换到第二个普通网络；未经确认不能公开群组。
- 返回已确认网络后，长期成员无需重新输入邀请码。
- 验证后台保持、真实重启和登录后自动开放。
- 从 v0.1.0 原地升级，并确认只有一个群聊服务进程和一份 SQLite。

详细检查项和时间标准见
[阶段 16B](../TODO/in-progress/16b-real-lan-acceptance.md)。

## 5. 保存证据

将报告与关键截图放入：

```text
docs/acceptance/lan-YYYY-MM-DD/
```

提交前删除 API Key、完整邀请码、长期成员凭证、IP、Wi-Fi 名称、真实目录和
无关私人对话。
