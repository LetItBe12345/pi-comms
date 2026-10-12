# 首次加入重复设置名称：PTY 端到端测试

日期：2026-10-12。代码：`35a77d6`（main）。package.json：0.3.2。Pi：1.0.4。

## 环境

通过 `exec_command` 的 `tty: true` 启动两个独立 Pi 进程。显式加载当前仓库入口，关闭其他 Extension 和会话保存：

```bash
pi --no-session --no-skills --no-context-files --no-extensions -e ./src/extension/index.ts --offline --thinking off
```

两端在同一台机器上，通过真实附近发现、TCP Broker 和交互式 TUI 通信。复用了正在运行的 Broker；没有验证两台物理设备之间的网络。未测试模型回答。

## 操作和结果

1. A 执行 `/comms`，创建 `E2E-Names-20261012`。设置用户 `E2E-A-1012`、Agent `E2E-A-Agent-1012` 和 Description `Test agent A`。选择允许附近加入、直接加入。A 进入群聊，在线 1 人。
2. B 执行 `/comms`，从附近群组中选择 A 的测试群。
3. 第一轮依次出现 `你的名称`、`你的 Agent 名称`、`Agent Description`。填写 `E2E-B-1012`、`E2E-B-Agent-1012`、`Test agent B`。
4. 随后再次出现 `设置用户名称`、`设置 Agent 名称`、`填写 Agent Description`。三个值都已预填，但必须逐项按 Enter。
5. 接着出现 `选择操作`，默认选中“创建群组”。B 必须改选“加入群组”，再从群组列表选择刚才已经选过的测试群。
6. B 入群成功，两端显示在线 2 人。
7. A 发送 `A-to-B-1012`，B 收到。B 发送 `B-to-A-1012`，A 收到。
8. A 通过群组管理解散本次测试群；B 显示在线 0 人。两个测试 Pi 进程随后退出。

## 结论和原因

首次从附近群组加入时，重复设置问题成立。准确地说，第二轮无需重新打字，但用户名称、Agent 名称和 Description 都要再次确认，还要再次选择加入操作和目标群。

- `src/extension/index.ts:1442` 首次加入前通过对话框收集名称和 Description。
- `src/extension/index.ts:1537` 连接成功后只设置 `desiredMembership`，没有发送首次 `group.join`。
- `src/extension/index.ts:1601` 把已填写的值传入 ChatView，只用于预填。
- `src/tui/chat-view.ts:139` 默认从 `user` 阶段开始；构造函数没有因为这些预填值跳过设置。
- `src/extension/index.ts:908` 自动入群只处理带长期成员凭证的情况。首次加入没有凭证，最终要靠第二轮界面的 joinGroup 操作发送请求。

## 修复后复测

修复在 ChatView 建立后，直接使用已有 joinGroup 动作加入预先选中的群。保留请求 ID 跟踪，让邀请码错误和名称冲突继续进入原有错误处理。群组列表的手动加入也复用同一个方法。

再次使用两个 `tty: true` Pi 进程，显式加载修复后的仓库入口：

1. A 创建允许附近直接加入的 `E2E-Fix-Names-1012`。
2. B 从附近列表选择该群，只填写 `Fix-B-1012`、`Fix-B-Agent` 和 `Test agent B` 一次。
3. Description 提交后自动出现“正在加入群组”，随后进入群聊。没有再次确认身份，也没有再次选择加入操作或目标群。两端在线 2 人。
4. A 发送 `fixed-A-to-B`，B 收到；B 发送 `fixed-B-to-A`，A 收到。
5. A 解散测试群并退出两个测试进程。

自动回归覆盖附近选择、粘贴加入信息、身份只询问一次、成功入群后发送消息，以及自动加入时邀请码错误后修正重试。
