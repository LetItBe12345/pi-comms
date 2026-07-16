



## 结论

**可以。Pi 对 TUI 的开放程度很高。**

Extension 可以：

- 注册 slash command。
- 临时切换到自定义交互界面。
- 接管键盘输入。
- 显示列表、表单、弹窗、侧边栏。
- 替换输入编辑器、Header、Footer。
- 添加状态栏和 Widget。
- 自定义消息和工具结果的渲染。citeturn257784view4

官方甚至提供了 `/snake` 游戏示例。它就是通过 slash command 进入一个独立的交互式 TUI 组件。fileciteturn6file0L52-L84

---

## Extension 能否跳转到“新 TUI 界面”

可以，核心 API 是：

```ts
await ctx.ui.custom((tui, theme, keybindings, done) => {
  return new YourComponent(...);
});
```

执行过程：

```text
用户输入 /session
       ↓
registerCommand 的 handler 执行
       ↓
ctx.ui.custom() 接管当前输入区域
       ↓
显示你的 Session 列表界面
       ↓
用户按 Enter / Escape
       ↓
调用 done(result)
       ↓
恢复 Pi 默认输入界面
```

自定义组件至少实现三个接口：

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}
```

`render()` 输出界面。`handleInput()` 接收键盘。`invalidate()` 清理渲染缓存。fileciteturn7file0L11-L29

---

## 最小可运行示例

创建：

```text
.pi/extensions/session-ui.ts
```

内容：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

class SessionPicker implements Component {
  private selected = 0;

  constructor(
    private sessions: string[],
    private done: (result: string | null) => void,
    private requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(
        this.sessions.length - 1,
        this.selected + 1,
      );
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.done(this.sessions[this.selected] ?? null);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done(null);
    }
  }

  render(width: number): string[] {
    const lines = [
      "Agent Sessions",
      "",
      ...this.sessions.map((session, index) => {
        const prefix = index === this.selected ? "> " : "  ";
        return truncateToWidth(prefix + session, width);
      }),
      "",
      "↑↓ Select   Enter Join   Esc Cancel",
    ];

    return lines;
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session", {
    description: "Open agent session communication UI",

    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("This command requires TUI mode", "error");
        return;
      }

      // MVP：先使用静态数据。
      // 之后替换为 Unix Socket / 本地 Registry 的发现结果。
      const sessions = [
        "pi-session-main",
        "pi-session-worker",
        "pi-session-reviewer",
      ];

      const selected = await ctx.ui.custom<string | null>(
        (tui, _theme, _keybindings, done) =>
          new SessionPicker(
            sessions,
            done,
            () => tui.requestRender(),
          ),
      );

      if (!selected) {
        return;
      }

      ctx.ui.setStatus("agent-comm", `connected: ${selected}`);

      ctx.ui.setWidget(
        "agent-comm",
        [
          `Connected: ${selected}`,
          "Use /session to switch session",
        ],
        { placement: "aboveEditor" },
      );
    },
  });
}
```

运行测试：

```bash
pi -e .pi/extensions/session-ui.ts
```

然后输入：

```text
/session
```

正式放到 `.pi/extensions/` 后，可以通过 `/reload` 热加载。全局 Extension 则放在 `~/.pi/agent/extensions/`。citeturn874783view0

---

## 对你的 Agent 通信项目，推荐这样设计

### `/session` 子界面

使用 `ctx.ui.custom()`：

```text
┌ Agent Sessions ────────────────────┐
│                                    │
│ > pi-main       online     local   │
│   pi-worker     busy       local   │
│   pi-reviewer   online     local   │
│                                    │
│ Enter: join   R: refresh   Esc: back
└────────────────────────────────────┘
```

按 Enter 后：

1. 调用本地通信层加入 Session。
2. `done(sessionId)` 退出子界面。
3. 返回 Pi 主界面。
4. 用 `setStatus()` 显示连接状态。
5. 用 `setWidget()` 显示成员和未读消息。

这是最简单的 MVP。不要一开始重做整个 Pi 界面。

### 收到其他 Session 的消息

第一版直接：

- 写入 Widget。
- 弹出 `ctx.ui.notify()`。
- 用户通过 `/session` 打开通信界面。

后续再加入：

- `pi.sendMessage()`。
- `registerMessageRenderer()`。
- `appendEntry()`。
- `registerEntryRenderer()`。

这样可以让通信消息出现在 Pi 的消息历史中，而不是只存在于临时界面。官方 Extension API支持自定义消息和 TUI 渲染器。citeturn393474view0

---

## 边界：Extension 不能完整替换 Pi 根界面

`ctx.ui.custom()` 的官方定义是：

> 临时使用自定义组件替换编辑区域，直到调用 `done()`。

它还可以使用 overlay，在原界面上显示浮层。fileciteturn7file0L89-L119

因此可以做：

- Session 选择器。
- 通信聊天室。
- 设置页。
- 表单。
- 全宽交互面板。
- 浮动侧边栏。

但从当前公开 Extension API 看，**不能直接替换整个 Pi 根应用**。例如完整接管消息历史区、Session 路由和所有核心界面。没有公开的 `replaceRoot()` 或 `setApplication()` 接口。

要完整重做 TUI，应使用：

```text
@earendil-works/pi-coding-agent SDK
              +
@earendil-works/pi-tui
```

官方 SDK 明确支持“构建自定义界面”和将 Pi 嵌入其他应用。fileciteturn8file0L5-L16

你的 MVP 不需要走 SDK。**Extension + `ctx.ui.custom()` 已经足够。**

---

## 官方文档

旧仓库 `badlogic/pi-mono` 当前会重定向到新的官方仓库 `earendil-works/pi`。citeturn621086view0

- [Pi 官方仓库](https://github.com/earendil-works/pi)
- [Extension 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [TUI Component 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
- [Extension 示例目录](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
- [Q&A 自定义 UI 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/qna.ts)
- [Snake 完整交互界面示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/snake.ts)
- [SDK 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

**明确判断：你的 `/session → Session 发现界面 → 选择并加入 → 返回主界面` 方案完全可以使用官方 Extension API 实现，不需要 fork Pi。**
