import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI,
  TUI_KEYBINDINGS,
  setKeybindings,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatView, type ChatViewActions } from "../src/tui/chat-view.js";
import { GroupPicker, RequiredChoice } from "../src/tui/group-picker.js";
import type { HistoryMessage, SnapshotPayload } from "../src/protocol.js";

class TestTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  clearWrites(): void {
    this.writes.length = 0;
  }
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function snapshot(messages: HistoryMessage[] = []): SnapshotPayload {
  return {
    brokerInstanceId: "broker-1",
    clientId: "client-a",
    groups: [{ groupId: "group-a", groupName: "开发组", onlineSessionCount: 2 }],
    group: { groupId: "group-a", groupName: "开发组" },
    members: [
      {
        memberId: "user:client-a",
        clientId: "client-a",
        type: "user",
        displayName: "Alice",
        groupId: "group-a",
        online: true,
      },
      {
        memberId: "agent:client-a",
        clientId: "client-a",
        type: "agent",
        displayName: "Alice-Pi",
        groupId: "group-a",
        online: true,
        agentStatus: "idle",
      },
      {
        memberId: "user:client-b",
        clientId: "client-b",
        type: "user",
        displayName: "Bob",
        groupId: "group-a",
        online: true,
      },
      {
        memberId: "agent:client-b",
        clientId: "client-b",
        type: "agent",
        displayName: "Bob-Pi",
        groupId: "group-a",
        online: true,
        agentStatus: "busy",
      },
    ],
    messages,
  };
}

function message(overrides: Partial<HistoryMessage>): HistoryMessage {
  return {
    messageId: "message-1",
    groupId: "group-a",
    senderId: "user:client-a",
    senderName: "Alice",
    senderType: "user",
    text: "你好",
    mentionIds: [],
    timestamp: new Date("2026-07-15T09:30:00+08:00").getTime(),
    status: "sent",
    ...overrides,
  };
}

function createView(overrides: Partial<ChatViewActions> = {}) {
  const terminal = new TestTerminal();
  const tui = new TUI(terminal);
  const done = vi.fn();
  const actions: ChatViewActions = {
    createGroup: vi.fn(() => "create-1"),
    joinGroup: vi.fn(() => "join-1"),
    sendMessage: vi.fn(() => "message-new"),
    updatePermission: vi.fn(() => true),
    approveRequest: vi.fn(() => "approve-1"),
    rejectRequest: vi.fn(() => "reject-1"),
    continueChain: vi.fn(() => "continue-1"),
    endChain: vi.fn(() => "end-1"),
    close: vi.fn(),
    ...overrides,
  };
  const view = new ChatView({
    tui,
    theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    done,
    actions,
  });
  view.focused = true;
  return { view, terminal, tui, actions, done };
}

function type(view: ChatView, text: string): void {
  for (const character of text) view.handleInput(character);
}

async function flushRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

beforeAll(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("最小群聊 TUI", () => {
  it("群主与普通成员显示清楚的 Ctrl+G 和快捷键帮助", () => {
    const { view } = createView();
    const ownerSnapshot = snapshot();
    ownerSnapshot.isOwner = true;
    ownerSnapshot.groupSettings = {
      groupId: "group-a",
      groupName: "开发组",
      visibility: "nearby",
      inviteRequired: false,
      keepAvailableWhenEmpty: false,
      openAtLogin: false,
    };
    ownerSnapshot.members[0]!.isOwner = true;
    view.applySnapshot(ownerSnapshot);
    view.setConnection("connected");

    expect(view.render(80).join("\n")).toContain("Ctrl+G 群组管理");
    view.handleInput("\x07");
    expect(view.render(80).join("\n")).toContain("群组管理");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(view.render(80).join("\n")).toContain("Alice [群主]");
    view.handleInput("\x1b");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(view.render(80).join("\n")).toContain("复制加入信息");

    view.handleInput("\x1b");
    view.handleInput("\x1b");
    view.handleInput("?");
    expect(view.render(40).join("\n")).toContain("Ctrl+P  Agent 控制");
    expect(view.render(40).join("\n")).toContain("Esc     返回或退出");
  });

  it("按用户、Agent、操作和群组列表完成加入流程", () => {
    const { view, actions } = createView();
    view.setGroups([
      { groupId: "empty", groupName: "无人组", onlineSessionCount: 0 },
      { groupId: "active", groupName: "开发组", onlineSessionCount: 2 },
    ]);

    type(view, "Alice");
    view.handleInput("\r");
    expect(view.stage).toBe("agent");
    expect(view.agentName).toBe("Alice-Pi");
    view.handleInput("\r");
    expect(view.stage).toBe("action");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(view.stage).toBe("join");
    view.handleInput("\r");

    expect(actions.joinGroup).toHaveBeenCalledWith("active", "Alice", "Alice-Pi");
    expect(view.render(80).join("\n")).toContain("正在加入群组");
  });

  it("邀请码错误后停留在输入框并允许直接重试", () => {
    const joinGroup = vi.fn(() => "join-1");
    const { view } = createView({ joinGroup });
    view.setGroups([
      { groupId: "nearby", groupName: "附近开发组", onlineSessionCount: 1 },
    ]);
    type(view, "Alice");
    view.handleInput("\r");
    view.handleInput("\r");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    view.handleInput("\r");
    view.receiveError({
      code: "invite_invalid",
      message: "邀请码不正确",
      requestId: "join-1",
    });
    expect(view.render(80).join("\n")).toContain("输入群组邀请码");

    type(view, "ABCDE-FGHJK");
    view.handleInput("\r");
    expect(joinGroup).toHaveBeenLastCalledWith(
      "nearby",
      "Alice",
      "Alice-Pi",
      "ABCDEFGHJK",
    );
  });

  it("将当前用户放右侧，其余用户和所有 Agent 放左侧", () => {
    const history = [
      message({ messageId: "own", text: "右侧消息" }),
      message({
        messageId: "other",
        senderId: "user:client-b",
        senderName: "Bob",
        text: "其他用户在左侧",
        timestamp: new Date("2026-07-15T09:33:00+08:00").getTime(),
      }),
      message({
        messageId: "other-agent",
        senderId: "agent:client-b",
        senderName: "Bob-Pi",
        senderType: "agent",
        text: "其他 Agent 在左侧",
        timestamp: new Date("2026-07-15T09:36:00+08:00").getTime(),
      }),
      message({
        messageId: "own-agent",
        senderId: "agent:client-a",
        senderName: "Alice-Pi",
        senderType: "agent",
        text: "自己的 Agent 也在左侧",
        timestamp: new Date("2026-07-15T09:39:00+08:00").getTime(),
      }),
    ];
    const { view } = createView();
    view.applySnapshot(snapshot(history));
    view.setConnection("connected");

    const lines = view.render(100);
    const own = lines.find((line) => line.includes("右侧消息"));
    const other = lines.find((line) => line.includes("其他用户在左侧"));
    const otherAgent = lines.find((line) => line.includes("其他 Agent 在左侧"));
    const ownAgent = lines.find((line) => line.includes("自己的 Agent 也在左侧"));
    expect(own?.startsWith(" ")).toBe(true);
    expect(other?.startsWith("其他用户在左侧")).toBe(true);
    expect(otherAgent?.startsWith("其他 Agent 在左侧")).toBe(true);
    expect(ownAgent?.startsWith("自己的 Agent 也在左侧")).toBe(true);
    expect(lines.join("\n")).toContain("Bob-Pi [Agent]");
    expect(lines.join("\n")).not.toContain("Agent·忙碌");
  });

  it("让右侧多行消息使用完全一致的缩进", () => {
    const { view } = createView();
    view.applySnapshot(snapshot([message({
      text: "第一行内容很长，需要在固定消息块宽度内换行。\n第二段手动换行",
    })]));
    view.setConnection("connected");

    const block = view.render(40).filter((line) =>
      line.includes("Alice  ") || line.includes("第一行") || line.includes("固定消息") || line.includes("第二段"),
    );
    expect(block.length).toBeGreaterThanOrEqual(3);
    expect(new Set(block.map(leadingSpaces))).toHaveLength(1);
  });

  it("Broker 确认后清空输入并显示消息", () => {
    const sendMessage = vi.fn(() => "message-new");
    const { view } = createView({ sendMessage });
    view.applySnapshot(snapshot());
    view.setConnection("connected");
    type(view, "公开消息");
    view.handleInput("\r");
    expect(sendMessage).toHaveBeenCalledWith("公开消息");
    expect(view.render(80).join("\n")).toContain("正在确认消息");

    view.receiveMessage(message({ messageId: "message-new", text: "公开消息" }));
    const screen = view.render(80).join("\n");
    expect(screen).toContain("公开消息");
    expect(screen).not.toContain("正在确认消息");
  });

  it("有草稿或 Agent 忙碌时 Esc 显示退出确认", () => {
    const { view, done } = createView();
    view.applySnapshot(snapshot());
    view.setConnection("connected");
    type(view, "未发送草稿");
    view.handleInput("\x1b");

    expect(view.render(80).join("\n")).toContain("退出群聊？");
    expect(done).not.toHaveBeenCalled();
  });

  it("窄窗口压缩成员信息但仍显示聊天和输入", () => {
    const { view, terminal } = createView();
    terminal.columns = 45;
    terminal.rows = 16;
    view.applySnapshot(snapshot([message({ text: "窄屏消息" })]));
    view.setConnection("connected");

    const screen = view.render(45).join("\n");
    expect(screen).toContain("在线 2");
    expect(screen).toContain("窄屏消息");
    expect(screen).toContain("? 快捷键");
  });

  it("通过 Ctrl+P 切换权限并批准待处理请求", () => {
    const updatePermission = vi.fn(() => true);
    const approveRequest = vi.fn(() => "approve-1");
    const { view } = createView({ updatePermission, approveRequest });
    view.applySnapshot(snapshot());
    view.setConnection("connected");

    view.handleInput("\x10");
    expect(view.render(80).join("\n")).toContain("Agent 控制");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(updatePermission).toHaveBeenCalledWith("approval");
    expect(view.render(80).join("\n")).toContain("接收 需批准");

    view.setPendingRequests([{
      requestId: "request-1",
      groupId: "group-a",
      groupName: "开发组",
      senderId: "user:client-b",
      senderName: "Bob",
      targetAgentId: "agent:client-a",
      targetAgentName: "Alice-Pi",
      ownerUserName: "Alice",
      onlineMembers: [],
      text: "请检查测试",
      chainId: "request-1",
      round: 1,
      createdAt: new Date("2026-07-15T09:31:00+08:00").getTime(),
    }]);
    view.handleInput("\x10");
    view.handleInput("\r");
    view.handleInput("\r");
    expect(view.render(80).join("\n")).toContain("请检查测试");
    view.handleInput("\r");
    expect(approveRequest).toHaveBeenCalledWith("request-1");
  });

  it("显示自动路由轮数，并通过 Ctrl+P 继续暂停链", () => {
    const continueChain = vi.fn(() => "continue-1");
    const { view } = createView({ continueChain });
    view.applySnapshot(snapshot([
      message({
        messageId: "answer-10",
        senderId: "agent:client-b",
        senderName: "Bob-Pi",
        senderType: "agent",
        text: "@Alice-Pi 请继续",
        kind: "agent",
        chainId: "chain-1",
        round: 10,
        routeStatus: "paused",
        routeTargetName: "Alice-Pi",
        nextRound: 11,
      }),
    ]));
    view.setConnection("connected");
    view.setPausedChains([{
      chainId: "chain-1",
      groupId: "group-a",
      initiatorName: "Alice",
      sourceAgentName: "Bob-Pi",
      sourceOwnerUserName: "Bob",
      targetAgentName: "Alice-Pi",
      text: "请继续",
      nextRound: 11,
      roundLimit: 10,
      participants: ["Alice-Pi", "Bob-Pi", "Carol-Pi"],
      pausedAt: new Date("2026-07-15T09:35:00+08:00").getTime(),
    }]);

    const chat = view.render(80).join("\n");
    expect(chat).toContain("Bob-Pi [Agent · 第 10 轮]");
    expect(chat).toContain("已达到第 10 轮，等待原发起者决定");
    expect(chat).toContain("待处理 1");

    view.handleInput("\x10");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(view.render(80).join("\n")).toContain("Bob-Pi → Alice-Pi · 下一轮 11");
    view.handleInput("\r");
    expect(view.render(80).join("\n")).toContain("参与 Agent：Alice-Pi、Bob-Pi、Carol-Pi");
    view.handleInput("\r");
    expect(continueChain).toHaveBeenCalledWith("chain-1");
  });

  it("按两分钟规则合并连续消息标题，并由系统消息打断", () => {
    const base = new Date("2026-07-15T09:30:00+08:00").getTime();
    const { view } = createView();
    view.applySnapshot(snapshot([
      message({ messageId: "one", text: "第一条", timestamp: base }),
      message({ messageId: "two", text: "第二条", timestamp: base + 120_000 }),
      message({ messageId: "three", text: "第三条", timestamp: base + 241_000 }),
    ]));
    view.setConnection("connected");

    const beforeNotice = view.render(80).join("\n");
    expect(beforeNotice.match(/Alice  \d{2}:\d{2}/gu)).toHaveLength(2);

    view.updatePresence({
      memberId: "agent:client-b",
      clientId: "client-b",
      type: "agent",
      displayName: "Bob-Pi",
      groupId: "group-a",
      online: false,
      agentStatus: "idle",
    });
    const withNotice = view.render(80).join("\n");
    expect(withNotice).toContain("Bob 和 Bob-Pi 已离开群组");
  });

  it("保留完整 timeline，初始 100 条后继续追加且不截断", () => {
    const base = new Date("2026-07-15T09:30:00+08:00").getTime();
    const history = Array.from({ length: 100 }, (_, index) => message({
      messageId: `history-${index}`,
      text: `历史消息 ${index + 1}`,
      timestamp: base + index * 180_000,
    }));
    const { view, terminal } = createView();
    terminal.rows = 12;
    view.applySnapshot(snapshot(history));
    view.setConnection("connected");
    for (let index = 100; index < 105; index += 1) {
      view.receiveMessage(message({
        messageId: `history-${index}`,
        text: `历史消息 ${index + 1}`,
        timestamp: base + index * 180_000,
      }));
    }

    const lines = view.render(80);
    expect(lines.join("\n")).toContain("历史消息 1");
    expect(lines.join("\n")).toContain("历史消息 105");
    expect(lines.length).toBeGreaterThan(terminal.rows);
  });

  it.each([40, 80, 120])("在 %i 列下正确换行且所有输出不超宽", (width) => {
    const longUrl = `https://example.com/${"very-long-path-".repeat(12)}`;
    const { view } = createView();
    view.applySnapshot(snapshot([
      message({
        messageId: "unicode",
        text: `中文与 Emoji 👨‍👩‍👧‍👦 e\u0301\n\n${longUrl}`,
      }),
      message({
        messageId: "markdown",
        senderId: "agent:client-b",
        senderName: "Bob-Pi",
        senderType: "agent",
        text: "## 检查结果\n\n- **通过**\n- `npm run check`",
        timestamp: new Date("2026-07-15T09:33:00+08:00").getTime(),
      }),
    ]));
    view.setConnection("connected");

    const lines = view.render(width);
    expect(lines.join("\n")).toContain("中文与 Emoji");
    expect(lines.join("\n")).toContain("检查结果");
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("用户消息保持纯文本，Agent 消息使用 Markdown", () => {
    const { view } = createView();
    view.applySnapshot(snapshot([
      message({ messageId: "plain", text: "# 用户标题 **原样**" }),
      message({
        messageId: "agent-md",
        senderId: "agent:client-b",
        senderName: "Bob-Pi",
        senderType: "agent",
        text: "# Agent 标题\n\n**加粗内容**",
        timestamp: new Date("2026-07-15T09:33:00+08:00").getTime(),
      }),
    ]));
    view.setConnection("connected");

    const screen = view.render(80).join("\n");
    expect(screen).toContain("# 用户标题 **原样**");
    expect(screen).toContain("Agent 标题");
    expect(screen).not.toContain("**加粗内容**");
  });

  it("普通消息、输入和底部状态变化都不清空终端 scrollback", async () => {
    const { view, terminal, tui } = createView();
    tui.addChild(view);
    tui.start();
    try {
      view.applySnapshot(snapshot(Array.from({ length: 12 }, (_, index) => message({
        messageId: `render-${index}`,
        text: `渲染消息 ${index}`,
        timestamp: new Date("2026-07-15T09:30:00+08:00").getTime() + index * 180_000,
      }))));
      view.setConnection("connected");
      await flushRender();

      terminal.clearWrites();
      view.receiveMessage(message({
        messageId: "render-new",
        text: "普通新消息",
        timestamp: new Date("2026-07-15T10:30:00+08:00").getTime(),
      }));
      await flushRender();
      expect(terminal.writes.join("")).not.toContain("\x1b[3J");

      terminal.clearWrites();
      type(view, "输入中");
      await flushRender();
      expect(terminal.writes.join("")).not.toContain("\x1b[3J");

      terminal.clearWrites();
      view.setConnection("reconnecting");
      await flushRender();
      expect(terminal.writes.join("")).not.toContain("\x1b[3J");
    } finally {
      tui.stop();
    }
  });

  it("较旧请求晚到失败时追加系统消息，不回改旧消息状态", () => {
    const base = new Date("2026-07-15T09:30:00+08:00").getTime();
    const { view } = createView();
    view.applySnapshot(snapshot([
      message({
        messageId: "request-old",
        text: "@Bob-Pi 请检查",
        status: "processing",
        routeTargetName: "Bob-Pi",
        timestamp: base,
      }),
      message({ messageId: "newer", text: "后来的消息", timestamp: base + 180_000 }),
    ]));
    view.setConnection("connected");
    view.receiveMessage(message({
      messageId: "request-old",
      text: "@Bob-Pi 请检查",
      status: "failed",
      failureReason: "target_offline",
      routeTargetName: "Bob-Pi",
      timestamp: base,
    }));

    const lines = view.render(80);
    const oldMessageIndex = lines.findIndex((line) => line.includes("@Bob-Pi 请检查"));
    const noticeIndex = lines.findIndex((line) => line.includes("Alice 发给 Bob-Pi 的请求未完成"));
    expect(noticeIndex).toBeGreaterThan(oldMessageIndex);
    expect(lines[oldMessageIndex + 1]).not.toContain("失败");
  });
});

describe("群组首屏", () => {
  it("同屏显示三个分区，并在附近更新时保持选择", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal);
    const done = vi.fn();
    const refresh = vi.fn();
    const picker = new GroupPicker({
      tui,
      theme,
      done,
      onRefresh: refresh,
      memberships: [
        {
          key: "local:mine",
          groupId: "mine",
          groupName: "我的项目",
          owner: true,
          updatedAt: 2,
        },
        {
          key: "broker-b:joined",
          groupId: "joined",
          groupName: "设计协作",
          owner: false,
          updatedAt: 1,
        },
      ],
    });
    picker.focused = true;
    picker.setNearby([
      {
        brokerId: "broker-a",
        groupId: "nearby",
        groupName: "附近开发组",
        onlineSessionCount: 2,
        endpoint: { host: "192.168.1.8", port: 43_127 },
        connectionState: "available",
      },
    ], { searching: false });

    const screen = picker.render(80).join("\n");
    expect(screen).toContain("我的群组");
    expect(screen).toContain("已加入");
    expect(screen).toContain("附近群组");
    expect(screen).toContain("R 重新查找");
    expect(screen).toContain("可直接加入");

    picker.handleInput("\x1b[A");
    picker.setNearby([
      {
        brokerId: "broker-a",
        groupId: "nearby",
        groupName: "附近开发组",
        onlineSessionCount: 3,
        endpoint: { host: "192.168.1.9", port: 43_127 },
        connectionState: "available",
      },
    ], { searching: false });
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      type: "nearby",
      group: expect.objectContaining({ onlineSessionCount: 3 }),
    }));

    picker.handleInput("r");
    expect(refresh).toHaveBeenCalled();
  });

  it("创建附近群组时默认选择直接加入", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal);
    const done = vi.fn();
    const choice = new RequiredChoice({
      tui,
      theme,
      done,
      initialValue: "open",
      title: "其他人如何加入？",
      choices: [
        { value: "open", label: "直接加入", description: "默认" },
        { value: "invite", label: "使用邀请码", description: "需要验证" },
      ],
    });
    choice.focused = true;

    expect(choice.render(80).join("\n")).toContain("› 直接加入");
    choice.handleInput("\r");
    expect(done).toHaveBeenCalledWith("open");
  });
});
