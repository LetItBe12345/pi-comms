import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI,
  TUI_KEYBINDINGS,
  setKeybindings,
  type Terminal,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatView, type ChatViewActions } from "../src/tui/chat-view.js";
import type { HistoryMessage, SnapshotPayload } from "../src/protocol.js";

class TestTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
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
  return { view, terminal, actions, done };
}

function type(view: ChatView, text: string): void {
  for (const character of text) view.handleInput(character);
}

beforeAll(() => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("最小群聊 TUI", () => {
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

  it("将当前用户放左侧，其余成员和 Agent 放右侧", () => {
    const history = [
      message({ messageId: "own", text: "左侧消息" }),
      message({
        messageId: "other",
        senderId: "agent:client-b",
        senderName: "Bob-Pi",
        senderType: "agent",
        text: "右侧回答",
      }),
    ];
    const { view } = createView();
    view.applySnapshot(snapshot(history));
    view.setConnection("connected");

    const lines = view.render(100);
    const own = lines.find((line) => line.includes("左侧消息"));
    const other = lines.find((line) => line.includes("右侧回答"));
    expect(own?.startsWith("左侧消息")).toBe(true);
    expect(other?.startsWith(" ")).toBe(true);
    expect(lines.join("\n")).toContain("Bob-Pi [Agent]");
    expect(lines.join("\n")).toContain("Bob-Pi [Agent·忙碌]");
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
    expect(screen).toContain("2 人在线");
    expect(screen).toContain("窄屏消息");
    expect(screen).toContain("Enter 发送");
  });
});
