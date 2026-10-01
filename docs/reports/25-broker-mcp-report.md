# 阶段 25 实现与端到端测试报告

日期：2026-10-01。来源：[PR #43](https://github.com/LetItBe12345/pi-comms/pull/43)。实现分支：`feat/broker-mcp-group-context`。

## 实现

- 已拉取远程 main，按阶段 25 TODO 和 37 条 decision 实现。
- Pi 开发依赖升级到 0.99.2，声明最低 peer 版本；适配新版 TUI 的 TuiMainScreen 和测试桩。
- Broker 内置官方 MCP SDK 的 Streamable HTTP 服务，随 Broker 启停。动态 HTTP 端口写入运行时元数据，经已认证 TCP 返回给当前 Session。
- 五分钟独立 MCP token 绑定在线 Session 和当前有效 membership。提前刷新；离群、断线、移出成员、Session 结束和重启失效。Token 只放内存，不写入 Pi 会话或 Broker 数据库。
- Extension 自动注册 `pi-comms`，两个工具都为 direct。使用当前 TCP Broker 的 host，LAN 不回退本机消息数据库。
- 实现 get_group_context、read_group_messages 和两个 Resource。复用 participantContext、GroupContextSummary.snapshot、publicMessages。消息字段经过白名单投影；没有写工具或任意 groupId 参数。
- Context 最多 12 条，历史默认 20 条、上限 50 条。已有摘要包含覆盖范围；不足时标记 summaryIncomplete。MCP 不生成摘要，不修改群聊或 Proactive 状态。
- 显式请求增加 sourceGroupSeq，数据库升级到 v11，并从关联公开消息回填旧请求锚点。保留原有 Remote Request 和 Proactive 注入。
- 更新 Specification、README 和 TODO 索引。

## 自动测试

在 Node.js 22.23.3 下执行 `npm run check`。结果：类型检查通过，单元与集成测试 167 通过，原有 E2E 20 通过；1 个原有环境条件测试跳过。

新增 MCP 测试覆盖原生 Pi MCP Client 与官方 SDK Client 互通、Local/LAN、两个用户、最新 context、已有摘要读取、Provider 零调用、数据库 membership 不变、消息分页、50 条上限、公开字段过滤、两个 Resource、跨群参数拒绝、未入群、错误和过期 token、刷新、离群重入、移出成员、Session 结束、Broker 重启失效、请求锚点持久化。注册测试覆盖 direct exposure、远端地址、提前刷新和注销。

## 两用户、两 TUI 的实际验收

通过 execution command 创建独立 PTY，并持续使用 write_stdin 输入按键。运行实际 Pi 0.99.2 CLI 和原生 `builtin:mcp`，每轮两份独立配置目录和 Session。

| 路径 | Broker TCP | Broker MCP | 群组 | Alice | Bob |
| --- | --- | --- | --- | --- | --- |
| Local | 127.0.0.1:38271 | 127.0.0.1:33043 | MCPLocal | 四次 MCP 调用成功 | 四次 MCP 调用成功 |
| LAN | 0.0.0.0:40245 | 0.0.0.0:34089 | MCPLAN2 | 本机四次调用成功 | 经 192.168.0.103 四次调用成功 |

每轮流程：

1. Alice 创建群，Bob 加入同一个群。两端执行 `/comms`，显示在线 2 人。
2. Alice 在 ChatView 输入 hello，Bob 输入 reply；双方 TUI 显示同一组公开消息。
3. Alice 输入 `@Bob-Pi`，触发真实 Extension、TCP、Broker 投递和 Pi Agent 工具执行。
4. Bob 的原生 MCP 分别调用 get_group_context、read_group_messages，读取 current、context 两个 Resource。
5. Bob 的 Agent 将 `MCP_E2E_PASS` 发回群聊，Alice TUI 显示回复。
6. Bob 再 `@Alice-Pi`，反向完成相同闭环。

四个 Session 的模型请求声明中均直接出现 `mcp__pi_comms__get_group_context` 和 `mcp__pi_comms__read_group_messages`，未通过 tool_search 加载。总计 16 次工具/Resource 调用，全部 isError=false。两轮数据库中各有两条 completed 请求，source_group_seq 分别为 3 和 5，Agent 回复为公开消息 #4 和 #6。

调用证据：

- [Local Alice](./25-mcp-e2e/local-alice.jsonl)
- [Local Bob](./25-mcp-e2e/local-bob.jsonl)
- [LAN Alice](./25-mcp-e2e/lan-alice.jsonl)
- [LAN Bob](./25-mcp-e2e/lan-bob.jsonl)

日志只含测试公开消息、模型工具声明和结果，不包含凭证。测试 Pi Session 和 Broker 已关闭。

## 测试范围与复现

这次使用真实 Pi TUI、原生 MCP Client 和实际 TCP/HTTP 服务。模型层用测试专用确定性 Provider 发出工具调用，不需要模型账号或费用；没有验证远端 LLM 自主选择工具的能力。LAN 使用本机物理网卡 IP，未使用第二台物理设备，阶段 16B 仍等待设备。

复现入口是 `tests/fixtures/mcp-tui-broker.ts` 和 `tests/fixtures/mcp-tui-extension.ts`。Broker fixture 使用临时数据库、临时端口，并将网络准入显式设为允许；不改用户原有 Broker。正式 Broker 仍按现有网络准入规则运行。LAN 需要 HTTP 动态端口可达。数据库升级到 v11，旧 Broker 不支持该版本；回退到旧代码需要配套恢复旧数据库。

```bash
# 使用 Node 22，在仓库根目录执行。每轮用新的临时目录。
export PI_COMMS_E2E_DB=/tmp/pi-comms-proof/comms.db
export PI_COMMS_E2E_STATE=/tmp/pi-comms-proof/broker.json
mkdir -p /tmp/pi-comms-proof/alice /tmp/pi-comms-proof/bob
node --import tsx tests/fixtures/mcp-tui-broker.ts
```

在两个终端分别设置独立的 `PI_CODING_AGENT_DIR` 和 `PI_COMMS_E2E_LOG`，设置 Broker 输出的 `PI_COMMS_E2E_PORT`，执行：

```bash
node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --offline --no-extensions -e builtin:mcp \
  -e tests/fixtures/mcp-tui-extension.ts \
  --no-skills --no-context-files --no-session \
  --provider mcp-e2e --model proof --thinking off
```

Alice 输入 `/comms-create MCPTest Alice Alice-Pi`，Bob 输入 `/comms-join <Group ID> Bob Bob-Pi`。随后两端 `/comms`，发送普通消息并互相 @Agent。

LAN 复现时，Broker 和 Alice 都设置 `PI_COMMS_E2E_MODE=lan`。Alice 在群组管理的「附近加入」中开启直接加入。Bob 设置 `PI_COMMS_E2E_HOST=<网卡 IPv4>` 后启动 Pi，再加入该群。

版本准备为 v0.3.0，package.json、lockfile 和 Broker 公布的版本已同步。Tag 与 GitHub Release 由单独的手动发布流程创建。
