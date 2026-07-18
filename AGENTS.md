# AGENTS.md

本项目是一个运行在 Pi CLI 中的群聊通信工具，包含 TUI、消息路由、Agent 通信等模块。以下规则适用于本仓库的所有编码与交互。

## 1. 文档索引

- [PRD](./PRD.md)：说明产品背景、用户需求、功能范围和产品路线。
- [Specification](./SPECIFICATION.md)：定义 MVP 的系统行为、技术约束、数据边界、协议和验收标准。开发实现以此文档为准。
- [Pi Extension 开发参考](./extensions_for_pi.md)：提供 Pi Extension 的完整 API 参考，包括安装位置、生命周期事件、Session 与 Agent 事件、工具和命令注册、状态管理及自定义 TUI。开发 Extension 前先检索此文档。
- [TODO 总览](./TODO/README.md)：列出实施阶段、执行顺序、依赖关系和当前状态。
- [进行中的 TODO](./TODO/in-progress/README.md)：存放尚未完成或正在实施的任务。
- [已完成的 TODO](./TODO/done/README.md)：存放已经满足完成条件的任务，作为实施记录。
- [发布](./RELEASE.md)：说明 Pi Package 的发布路线、安装命令和 `package.json` 发布要求。
- [领域语言](./docs/CONTEXT.md)：统一群组、群主、长期成员、附近加入和 Broker 的产品术语。
- [旧 TODO 入口](./TODO(1).md)：仅用于兼容旧链接，并导航到 Specification 和 TODO 总览；不要在这里新增任务。

### TODO 状态规则

- 新任务放入 `TODO/in-progress/`。
- 未开始和正在处理的任务都属于 `in-progress`。
- 一个任务文件的任务和完成条件全部满足后，才移入 `TODO/done/`。
- 移动任务文件后，同步更新 `TODO/README.md` 中的状态和链接。
- 产品规则写入 `SPECIFICATION.md`，可执行动作写入 TODO，避免重复。

## 2. 沟通风格

- 用短句。
- 用简单的词语。
- 控制回答篇幅，不啰嗦。

## 3. 检索与复用

- 先检索后回复，先检索后修改。
- 检索包括本地代码检索和联网搜索。
- 能复用就复用：开源项目的组件、设置、逻辑，以及本仓库已有代码。
- 不重复造轮子。

## 4. 编码原则：多读少改

- 多读少改，动手前先理解现有代码。
- 优先 MVP，先想最简单的实现方案。
- 不写过多的兜底代码。
- 不写防御性代码。
- 不过度考虑安全问题。
- 不考虑几乎碰不到的边界条件。

## 5. CI/CD 与发布规则

- 普通 PR、合并和推送只运行 CI，绝不自动创建 GitHub Release。
- Release 使用单独的 `release.yml`，只允许通过 `workflow_dispatch` 手动触发。
- 触发时必须提供版本号，并输入确认词 `RELEASE`；确认词不完全一致就停止。
- 用户明确说出 `RELEASE vX.Y.Z`，才代表授权创建对应 Tag 和 GitHub Release。只说“提交”“推送”或“合并”不代表发布。
- 发布前必须确认：当前代码来自 `main`、`package.json` 版本与输入版本一致、对应 Tag 和 Release 不存在、CI 与生产依赖安装测试通过。
- 发布成功后创建 `vX.Y.Z` Tag 和同名 GitHub Release。已有 Tag 或 Release 不覆盖、不重建。
- MVP 不发布 npm，不上传二进制包；用户通过固定 Git Tag 安装。

示例：

```bash
gh workflow run release.yml -f version=0.1.0 -f confirm=RELEASE
```

## 6. Pi Extension 开发参考速查

完整 API 与示例见 [extensions_for_pi.md](./extensions_for_pi.md)。开发 Extension 前先检索该文档对应章节，本节只作速查。

### 放置与热加载

- 全局：`~/.pi/agent/extensions/`；项目级：`.pi/extensions/`。
- 这两处可被 `/reload` 热加载；`pi -e ./path.ts` 仅用于快速测试。

### 核心能力

- 自定义工具：`pi.registerTool()`，LLM 可调用。
- 事件拦截：拦截或改写工具调用、注入上下文、自定义压缩。
- 用户交互：`ctx.ui`（select/confirm/input/notify）。
- 自定义 UI：`ctx.ui.custom()` 做带键盘输入的 TUI 组件。
- 自定义命令：`pi.registerCommand()` 注册 `/mycommand`。
- 会话持久化：`pi.appendEntry()` 存可跨重启的状态。
- 自定义渲染：控制工具调用/结果和消息在 TUI 中的显示。

### 章节索引

- Quick Start / Extension Locations / Available Imports
- Writing an Extension（含 Extension Styles）
- Events：Lifecycle Overview、Resource/Session/Agent/Model/Tool Events
- ExtensionContext / ExtensionCommandContext
- ExtensionAPI Methods
- State Management
- Custom Tools（含 Dynamic Tool Loading）
- Custom UI
- Error Handling / Mode Behavior / Examples Reference

## 7. 项目结构

- `src/extension/index.ts` 是 Pi 唯一直接加载的 Extension 入口，负责注册命令、生命周期和组装模块，不承载全部实现。
- `package.json` 通过 `pi.extensions` 只声明该入口。其他模块由 `index.ts` 正常导入，不需要被 Pi 单独发现。
- TUI 放在 `src/tui/`，必须由 Extension 入口导入，并通过 `ctx.ui.custom()` 启动。目录位置不影响它作为 Extension 功能运行。
- Extension 的 Broker 客户端、Agent 桥接和 Session 状态放在 `src/extension/`；Broker 服务端放在 `src/broker/`。
- 公共协议放在 `src/protocol.ts`，测试放在 `tests/`。
- 新增项目文档统一放入 `docs/`；已有根目录文档只在专门的迁移任务中移动，并同步更新全部链接。
- 文档迁移完成后，根目录只保留 `README.md`、`AGENTS.md` 和工程配置文件。
- 新文件必须放入对应模块，不在根目录随意创建。
- 按职责拆分，避免循环依赖；TUI 不反向导入 `extension/index.ts`。
- 以下是目标结构，文件在对应阶段需要时再创建：

```text
pi-comms/
├── README.md
├── AGENTS.md
├── package.json
├── tsconfig.json
├── docs/
│   ├── PRD.md
│   ├── SPECIFICATION.md
│   ├── extensions_for_pi.md
│   └── development-and-release.md
├── TODO/
│   ├── README.md
│   ├── in-progress/
│   └── done/
├── src/
│   ├── protocol.ts
│   ├── types.ts
│   ├── extension/
│   │   ├── index.ts
│   │   ├── broker-client.ts
│   │   ├── agent-bridge.ts
│   │   ├── remote-queue.ts
│   │   └── session-state.ts
│   ├── broker/
│   │   ├── server.ts
│   │   ├── group-state.ts
│   │   ├── router.ts
│   │   ├── store.ts
│   │   └── database.ts
│   └── tui/
│       ├── chat-view.ts
│       └── components/
└── tests/
```
