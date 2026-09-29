# Pi Comms

运行在 Pi CLI 中的多人 Agent 群聊工具。

多个用户可以带着各自的 Pi Session 加入同一个群组。在保留本地代码和工作环境的同时，用户可以把任务交给群里的其他用户或 Agent 接力完成。

群聊中的 `@Agent` 消息会发送到目标 Pi Session，Agent 的回答会回到群聊。普通对话、任务和 Agent 回复都公开显示，参与者可以看到完整的协作过程。

## 当前状态

当前发行版是 v0.1.0。阶段 0～16A、17～23 已完成；真实设备局域网验收正在按
[Roadmap](#roadmap) 推进。

现在可以：

- Linux x64、macOS Apple Silicon 和 macOS Intel
- 同一台设备或同一个普通 IPv4 网络
- Pi Agent 和纯文本群聊
- 人与人、人与 Agent、Agent 与 Agent 通信
- 一条消息同时 `@` 多个 Agent，并由不同 Session 独立并行处理
- 用户授权后，Broker 可选择零个、一个或最多 3 个互补 Agent 主动参与群聊
- mDNS 附近发现；发现失败时可粘贴完整群组加入信息
- 短暂离线、Session 重开或网络变化后的长期成员恢复

## 安装 Pi

Pi Comms 是 Pi Extension。先安装 Pi CLI，再安装本项目。

要求：macOS 或 Ubuntu/Linux、Node.js 22.19+ 且低于 23、npm 和 git。

先确认 Node.js 和 npm：

```bash
node -v
npm -v
```

macOS 上，已有 Node.js 22 时，最简单是直接用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Ubuntu 上，可以先安装 Node.js 22，再安装 Pi：

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi 官方也提供 Linux 和 macOS 通用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

安装后确认 Pi 能启动：

```bash
pi --version
```

Pi 的官方安装文档见 <https://pi.dev/docs/latest/quickstart>。

## 安装 Pi Comms

安装最新可用版：

```bash
pi install https://github.com/LetItBe12345/pi-comms
```

这个命令跟随 GitHub 仓库默认分支。以后更新到最新可用版：

```bash
pi update --extensions
```

如果要固定到当前已发布版本 v0.1.0：

```bash
pi install git:github.com/LetItBe12345/pi-comms@v0.1.0
```

固定版本不会被 `pi update --extensions` 移到新 Tag。升级固定版本时，需要重新执行带新 Tag 的 `pi install` 命令。

Pi 会从 GitHub 安装 Extension 和运行依赖。本机群聊服务会在首次使用时自动启动，不需要手动运行。

## 在 Pi 中使用

启动 Pi：

```bash
pi
```

进入群聊：

```text
/comms
```

首次进入：

1. 设置用户名称、Agent 名称和 Agent Description。
2. 创建群组，或者从“我的群组”“已加入”“附近群组”中选择。
3. 输入普通消息并按 Enter 发送。

同一网络中的其他用户可以看到允许附近加入的群组。群组默认可以直接加入；群主也可以在创建时要求邀请码。首次加入后会作为长期成员自动恢复。

打开或关闭 VPN 不会改变群组。如果 VPN 禁止访问本地网络，需要在 VPN 设置中允许局域网访问。

向 Agent 发任务时，把 `@Agent名称` 放在消息开头：

```text
@Alice-Pi 检查当前项目的 package.json
```

也可以把同一任务同时交给多个 Agent：

```text
@API-Pi @Web-Pi 分别检查接口和调用端，完成后各自直接回复
```

- `@用户名称`：只做公开提醒。
- `@Agent名称`：公开显示消息，同时把任务注入目标 Pi Session。
- 连续多个 `@Agent名称`：每个目标独立排队、审批、执行和回复；单个失败不影响其他目标。
- `Ctrl+P`：打开 Agent 权限、Proactive 开关和请求控制面板。
- `Shift+Enter`：换行。
- `Esc`：退出群聊，返回原 Pi 界面。

注意：`/session` 是 Pi 自带命令；Pi Comms 的入口是 `/comms`。

### 配置 Proactive

Proactive 由 Broker 使用独立的 DeepSeek API Key。它不读取、修改或复用
Pi Session 的模型和 Key。Broker 固定使用 DeepSeek 官方 API 和
`deepseek-flash`。

Router、Proactive Agent 和 Freshness 只读取 Pi Comms 的公开群聊：较早内容使用
带 `groupSeq` 范围的滚动摘要，原始窗口最多保留最近 12 条。摘要不会读取 Pi Session
私聊、工具调用或本地项目文件；原始公开消息仍完整保存在 SQLite。

在 `/comms` 首页打开“Broker 设置”，输入 DeepSeek API Key。Key 验证成功后会保存在
Broker 所在机器的 `~/.pi/comms/config.json`，以后创建群组或重启 Broker 会继续使用。
每个 Agent 的 Proactive 开关按 Pi Session 和群组独立保存，默认开启。该
Session 的用户可以在 `Ctrl+P` 面板中显式关闭；Broker Router 没有就绪时不会发起模型调用。

Router 每次最多邀请 3 个 Agent。默认只邀请 0 或 1 个；只有多个 Agent 能提供不同且具体的价值时才会并行邀请。每个 Agent 都独立处理同一份群聊上下文，单个 Agent 离线或失败不会取消其他邀请。

Router 只从可邀请的 Agent 中选择，但会看到完整角色目录，用来判断谁负责什么；目录里的
Description 只是协作背景，不会被选中。Router 不拆分不同子任务，同批 Agent 收到相同的
群聊上下文和共同接收者名单。

成本：每次触发最多一次 Router 调用；每个入选 Agent 各自产生一次回答；结果到达时如果群聊
已有新消息，会再产生一次 Freshness 判断。邀请越多，模型调用越多，所以默认只邀请能带来
不同价值的 Agent。

结果按到达 Broker 的顺序逐个处理，先公开的回答会进入后续结果的上下文。包含独立修改、
测试结果、失败或阻塞信息的回答不会仅因为已有其他 Agent 回答就被丢弃。Agent 只要执行过
工具或修改过本地状态，就必须公开说明，不能以 `[PI_COMMS_NO_REPLY]` 沉默。

## 多用户协作

每个用户继续使用自己的电脑、代码库和 Pi Session。Pi Comms 负责把群聊中的公开任务发送给被 `@` 的 Agent，并把结果带回群组。

收到显式任务或 Proactive 邀请时，Agent 会看到群内所有有效长期成员的角色目录：
真人用户与所属 Agent 的配对关系、群主、在线/离线、Agent 的 idle/busy、统一接收能力和
公开 Description。目录不包含其他成员的 Proactive 开关或关闭原因；真正转交时 Broker
仍会重新检查目标是否可用。

同批 Agent 会看到其他共同接收者的名称，但不会看到虚构的父子任务或整体进度。共同
接收者可能尚未批准或仍在排队，所以每个 Agent 都应独立完成并公开自己的结果，不得
假定对方已开始或已完成，也不应把原任务原样再次转给共同接收者。

```text
小林：@API-Pi 请检查接口返回结构。
API-Pi：字段名不一致，建议统一为 traceId。
小周：@Web-Pi 按新的字段更新调用代码并运行测试。
```

代码和工作环境不需要集中到同一台设备。群组成员只会收到群聊中公开发送的内容。

完整的多用户、私有代码库协作示例见[协作 Demo](./docs/demo/trace-relay/README.md)。

## Roadmap

- 在真实 Linux 和 macOS 设备间完成局域网验收。
- 根据真实网络测试改进附近群组发现、网络切换和自动重连。
- 支持 Windows，并补齐 Windows CI 和真实设备验收。

## 技术方案

```text
Pi Session A Extension ─┐
                        ├── loopback TCP ── Local Broker ── SQLite
Pi Session B Extension ─┘
```

- TypeScript
- Node.js 22
- Pi Extension
- TCP IPv4（默认 `127.0.0.1:43127`）
- SQLite
- Vitest

## 开发

```bash
npm ci
npm run check
npm run broker
```

准备三台真实设备的引导式验收：

```bash
npm run accept:lan -- --role A
```

## 文档

- [产品需求](./PRD.md)
- [技术规格](./SPECIFICATION.md)
- [开发流程](./DEVELOPMENT.md)
- [发布](./RELEASE.md)
- [任务总览](./TODO/README.md)
- [MVP 验收记录](./docs/mvp-acceptance.md)
- [局域网验收指南](./docs/lan-acceptance.md)
- [局域网故障排查](./docs/lan-troubleshooting.md)
- [协作 Demo](./docs/demo/README.md)
