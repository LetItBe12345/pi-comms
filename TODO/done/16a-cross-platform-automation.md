# 阶段 16A：跨平台自动化与局域网验收准备

目标：完成 Codex 可以独立执行的跨平台兼容、自动测试、单机多节点模拟和真实局域网验收工具，为阶段 16B 做好准备。

状态：已完成。Ubuntu、macOS arm64 和 macOS x64 CI 已通过；阶段 16B 继续等待真实设备。

## 已确认边界

- 正式支持 Linux x64、macOS arm64 和 macOS x64，不兼容 Windows。
- CI 使用 Node.js 22，并覆盖 `ubuntu-latest`、`macos-latest` 和 `macos-15-intel`。
- GitHub 托管 runner 不能代替真实多设备局域网；本阶段不得宣称三台真实设备或跨平台 mDNS 已验收。
- GitHub 托管 CI 的 mDNS 只作为诊断项；环境不支持组播时明确跳过，不作为必须通过的检查。
- 正式支持局域网 IPv4。IPv6 和主机名连接暂不支持，失败时必须给出可读提示。
- CI 和自动测试不使用真实模型 API Key。
- 不为测试向正式协议加入隐藏端点、后门邀请码或跳过认证的测试模式。
- 完成本阶段后可以提 PR、等待 CI 通过并合并；阶段 16B 保留在 `in-progress`。
- 本阶段完成和合并都不代表授权创建 Release。

## 任务

### 跨平台 CI

- [x] 将主检查改为 Ubuntu 和 macOS 矩阵。
- [x] 两个平台统一使用 Node.js 22 和 `npm ci`。
- [x] 验证 `better-sqlite3` 可以安装、加载和创建数据库。
- [x] 验证 Broker launcher 可以启动、握手和关闭。
- [x] 验证 loopback TCP 的 Broker、Extension 和验收测试。
- [x] 将依赖审查保留为独立 Linux 任务。
- [x] 增加 `macos-15-intel`，分别验证 macOS arm64 和 x64。
- [x] CI 工作流只调用简单的 `npm` 脚本，不依赖 Bash 专用流程。
- [x] 正常关闭通过应用关闭流程验证；Unix 信号只允许作为 macOS/Linux 的清理兜底。
- [x] mDNS 冒烟测试不支持组播时输出明确跳过原因，不把跳过显示成通过。

### 平台兼容处理

- [x] 所有数据目录和入口路径使用 Node 路径 API。
- [x] 所有临时目录使用 `node:os` 的系统临时目录。
- [x] IPv4 连接失败时显示可读错误。
- [x] IPv6 地址显示“当前版本暂不支持 IPv6”，不进入模糊超时。
- [x] 主机名显示“当前版本请使用 IPv4 地址”，不作为完整邀请信息的连接目标。
- [x] 修正规格中“必要时回退 IPv6”的旧承诺。
- [x] Linux 和 macOS 文档说明常见防火墙、VPN 和网络隔离问题。

### 自动测试

- [x] 覆盖两个系统的本机多 Session 通信，包括并发首次启动。
- [x] 保证阶段 0～14 的自动测试在两个系统上运行。
- [x] 覆盖 TCP 断开、Broker 重启和客户端恢复。
- [x] 覆盖设备身份、协议版本、心跳、帧限制和 `resumeToken`。
- [x] 使用真实 `v0.1.0` 脱敏数据库 fixture 验证迁移，并保留中间 schema 单元测试。
- [x] 验证升级保留群组、消息、请求状态和设备身份；损坏数据库给出明确错误。
- [x] 覆盖正确邀请码、错误邀请码、邀请码轮换、成员移出和群组解散。
- [x] 覆盖“我的群组”“已加入”“附近群组”、完整邀请信息、连接回退和 `brokerId` 校验。
- [x] 覆盖群主 Session 恢复、长期成员重连，以及 fork/clone 不继承群主管理权限。
- [x] 覆盖 VPN 接口变化不改变普通网络身份，新普通网络必须重新确认。
- [x] 覆盖空闲关闭、后台保持和登录后自启的状态逻辑。
- [x] 覆盖 `lan-host` 本机 Session 与远程 Session 共享唯一 Broker 和 SQLite。
- [x] 覆盖两台本机 Pi 并发首次进入 `/comms` 只启动一个 Broker。
- [x] 覆盖 `local` 切换 `lan-host` 后不存在共享同一 SQLite 的第二个 Broker。
- [x] 覆盖运行中的旧发行版由新发行版优雅重启，开发版不能接管发行版。
- [x] 使用依赖注入模拟网络变化；`CI=true` 不得改变正式产品行为。

### 引导式验收工具

- [x] 增加 `npm run accept:lan`，使用 Node.js 实现，不依赖 Bash。
- [x] 提供 A、B、C 三个角色的准备、执行和收尾指引。
- [x] 检查 Pi、Pi Comms、Node.js、操作系统、普通私网 IPv4 和 VPN 状态。
- [x] 检查 TCP 监听和 mDNS 可用性；只诊断，不使用 `sudo` 修改防火墙。
- [x] 根据角色生成三个彼此独立的一次性代码仓库，验收后不自动删除。
- [x] A 仓库保存协议与需求，B 仓库保存服务端，C 仓库保存客户端或测试。
- [x] 引导检查附近发现、入群、通信、断线、升级、后台和网络切换。
- [x] 记录每一步的首次结果、重试原因、耗时和错误。
- [x] 生成脱敏 Markdown 报告，不记录 API Key、完整邀请码、成员凭证、IP、Wi-Fi 名称或真实目录。
- [x] 支持固定并记录 Pi 正式版和 Pi Comms commit SHA。
- [x] 当前验收基线固定为 Pi `0.80.10`；更新基线必须显式修改文档。
- [x] Pi Comms 待发行版本使用 `git:github.com/LetItBe12345/pi-comms@<commit SHA>` 安装。
- [x] 禁用项目 `.pi/extensions/` 和 `pi -e` 开发版，避免发行版与开发版同时加载。
- [x] 工具只使用公开产品流程，不向正式协议添加测试专用能力。

### TUI 与文档准备

- [x] 定义最低终端尺寸 80×24，推荐截图尺寸 120×36。
- [x] 首屏完整显示“我的群组”“已加入”“附近群组”。
- [x] 当前页面直接显示可用快捷键；小终端不能隐藏退出、返回、加入和管理操作。
- [x] 用户界面不显示 Broker、mDNS、endpoint 等技术词。
- [x] 验证中文群名、用户名和错误提示不会错位或乱码。
- [x] 更新 README 的支持平台、IPv4 边界和局域网使用流程。
- [x] 更新 SPECIFICATION 的 TCP、身份、准入、发现和 IPv4 规则。
- [x] 增加局域网故障排查文档。
- [x] 明确当前不支持跨公网、跨子网、IPv6、主机名连接和多 Broker 同步。
- [x] 明确自动测试与单机模拟不能代替阶段 16B 的真实设备验收。

## 实施与合并顺序

1. 完成本文件的代码、测试、工具和文档。
2. 本地运行类型检查、自动测试和验收工具自检。
3. 提交阶段 16A PR。
4. 等待 Ubuntu、macOS arm64、macOS x64 和依赖审查 CI 全部通过。
5. CI 通过后合并 PR。
6. 将本文件移入 `TODO/done/`；阶段 16B 继续保留。

## 主要改动文件

- `.github/workflows/ci.yml`
- `package.json`
- `README.md`
- `SPECIFICATION.md`
- `docs/lan-acceptance.md`
- `docs/lan-troubleshooting.md`
- `scripts/lan-acceptance.ts`
- `tests/acceptance.test.ts`
- `tests/mdns-smoke.test.ts`
- 相关平台兼容实现与测试文件

## 本阶段不做

- 不伪造三台真实设备、跨平台 mDNS 或真实 VPN 验收结果。
- 不使用真实模型 API Key。
- 不做公网服务器、云端账号、NAT 穿透、TURN 或中继。
- 不做跨子网 mDNS 代理。
- 不做多个 Broker 的数据复制。
- 不做 Windows、移动端和正式 IPv6 支持。
- 不创建 Tag 或 GitHub Release。

## 完成条件

- [x] Ubuntu、macOS arm64 和 macOS x64 CI 全部通过。
- [x] 自动测试覆盖本阶段列出的协议、身份、恢复、生命周期和升级行为。
- [x] `npm run accept:lan` 可以完成环境检查、角色准备和脱敏报告生成。
- [x] 单机多进程模拟通过，且输出和文档明确标记为模拟结果。
- [x] README、SPECIFICATION 和故障排查文档准确说明支持范围与限制。
- [x] 阶段 16B 仍保留为未完成的真实设备验收。
