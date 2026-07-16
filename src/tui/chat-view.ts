import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  ErrorPayload,
  AgentRequestPayload,
  ChainResolvedPayload,
  HistoryMessage,
  PausedChainPayload,
  SendFailedPayload,
  SnapshotPayload,
} from "../protocol.js";
import type { AgentPermission, GroupSummary, Member } from "../types.js";

type SetupStage = "user" | "agent" | "action" | "create" | "join" | "chat";
type ConnectionState = "connecting" | "connected" | "reconnecting";

export interface ChatViewActions {
  createGroup(groupName: string, userName: string, agentName: string): string | undefined;
  joinGroup(groupId: string, userName: string, agentName: string): string | undefined;
  sendMessage(text: string): string | undefined;
  updatePermission(permission: AgentPermission): boolean;
  approveRequest(requestId: string): string | undefined;
  rejectRequest(requestId: string): string | undefined;
  continueChain?(chainId: string): string | undefined;
  endChain?(chainId: string): string | undefined;
  close(): void;
}

export interface ChatViewOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: () => void;
  actions: ChatViewActions;
  initialUserName?: string;
  initialAgentName?: string;
  initialPermission?: AgentPermission;
  initialPendingRequests?: AgentRequestPayload[];
  initialPausedChains?: PausedChainPayload[];
}

interface PendingSetup {
  id: string;
  stage: "create" | "join";
}

interface SystemNotice {
  id: string;
  timestamp: number;
  text: string;
}

export class ChatView implements Component, Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: () => void;
  readonly #actions: ChatViewActions;
  readonly #userInput = new Input();
  readonly #agentInput = new Input();
  readonly #groupInput = new Input();
  readonly #editor: Editor;
  #stage: SetupStage = "user";
  #connection: ConnectionState = "connecting";
  #groups: GroupSummary[] = [];
  #snapshot: SnapshotPayload | undefined;
  #messages: HistoryMessage[] = [];
  #members = new Map<string, Member>();
  #notices: SystemNotice[] = [];
  #actionList: SelectList;
  #groupList: SelectList;
  #exitList: SelectList | undefined;
  #permissionList: SelectList;
  #pendingList: SelectList;
  #decisionList: SelectList;
  #chainList: SelectList;
  #chainDecisionList: SelectList;
  #panel: "permission" | "pending" | "decision" | "chains" | "chain-decision" | undefined;
  #permission: AgentPermission;
  #pendingRequests: AgentRequestPayload[];
  #selectedRequest: AgentRequestPayload | undefined;
  #pausedChains: PausedChainPayload[];
  #selectedChain: PausedChainPayload | undefined;
  #pendingSetup: PendingSetup | undefined;
  #pendingMessage: { id: string; text: string } | undefined;
  #error: string | undefined;
  #focused = false;
  #noticeCounter = 0;

  constructor(options: ChatViewOptions) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#keybindings = options.keybindings;
    this.#done = options.done;
    this.#actions = options.actions;
    this.#userInput.setValue(options.initialUserName ?? "");
    this.#agentInput.setValue(options.initialAgentName ?? "");
    this.#permission = options.initialPermission ?? "auto";
    this.#pendingRequests = sortPendingRequests(options.initialPendingRequests ?? []);
    this.#pausedChains = sortPausedChains(options.initialPausedChains ?? []);

    this.#actionList = this.#createSelectList([
      { value: "create", label: "创建群组", description: "创建并进入新群组" },
      { value: "join", label: "加入群组", description: "从已有群组中选择" },
    ]);
    this.#actionList.onSelect = (item) => {
      this.#error = undefined;
      this.#stage = item.value === "create" ? "create" : "join";
      this.#syncFocus();
      this.#tui.requestRender();
    };
    this.#actionList.onCancel = () => this.#goBack();
    this.#groupList = this.#createGroupList();
    this.#permissionList = this.#createPermissionList();
    this.#pendingList = this.#createPendingList();
    this.#decisionList = this.#createDecisionList();
    this.#chainList = this.#createChainList();
    this.#chainDecisionList = this.#createChainDecisionList();

    this.#editor = new Editor(this.#tui, {
      borderColor: (text) => this.#theme.fg("borderAccent", text),
      selectList: this.#selectTheme(),
    });
    this.#editor.setAutocompleteProvider(this.#memberAutocomplete());
    this.#editor.onSubmit = (value) => this.#submitMessage(value);
    this.#editor.onChange = () => this.#tui.requestRender();

    this.#userInput.onSubmit = (value) => {
      if (!this.#acceptName(value)) return;
      this.#userInput.setValue(value.trim());
      if (!this.#agentInput.getValue().trim()) {
        this.#agentInput.setValue(`${value.trim()}-Pi`);
      }
      this.#stage = "agent";
      this.#syncFocus();
      this.#tui.requestRender();
    };
    this.#agentInput.onSubmit = (value) => {
      if (!this.#acceptName(value)) return;
      if (value.trim().toLocaleLowerCase("en-US") === this.userName.toLocaleLowerCase("en-US")) {
        this.#error = "用户名称与 Agent 名称不能相同";
        this.#tui.requestRender();
        return;
      }
      this.#agentInput.setValue(value.trim());
      this.#stage = "action";
      this.#syncFocus();
      this.#tui.requestRender();
    };
    this.#groupInput.onSubmit = (value) => this.#submitCreate(value);
    this.#userInput.onEscape = () => this.#requestClose();
    this.#agentInput.onEscape = () => this.#goBack();
    this.#groupInput.onEscape = () => this.#goBack();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#syncFocus();
  }

  get userName(): string {
    return this.#userInput.getValue().trim();
  }

  get agentName(): string {
    return this.#agentInput.getValue().trim();
  }

  get stage(): SetupStage {
    return this.#stage;
  }

  setConnection(state: ConnectionState): void {
    this.#connection = state;
    this.#editor.disableSubmit = state !== "connected" || this.#pendingMessage !== undefined;
    this.#tui.requestRender();
  }

  setGroups(groups: GroupSummary[]): void {
    this.#groups = sortGroups(groups);
    this.#groupList = this.#createGroupList();
    this.#tui.requestRender();
  }

  applySnapshot(snapshot: SnapshotPayload): void {
    this.#snapshot = snapshot;
    this.setGroups(snapshot.groups);
    this.#messages = dedupeMessages(snapshot.messages);
    this.#members = new Map(snapshot.members.map((member) => [member.memberId, member]));
    if (snapshot.group !== undefined) {
      this.#stage = "chat";
      this.#pendingSetup = undefined;
      this.#error = undefined;
      this.#editor.setAutocompleteProvider(this.#memberAutocomplete());
    }
    this.#syncFocus();
    this.#tui.requestRender();
  }

  updatePresence(member: Member): void {
    const previous = this.#members.get(member.memberId);
    this.#members.set(member.memberId, member);
    if (member.type === "agent" && previous?.online !== member.online) {
      const owner = [...this.#members.values()].find(
        (item) => item.clientId === member.clientId && item.type === "user",
      );
      if (owner !== undefined) {
        this.#addNotice(
          member.online
            ? `${owner.displayName} 和 ${member.displayName} 已加入群组`
            : `${owner.displayName} 和 ${member.displayName} 已离开群组`,
        );
      }
    }
    this.#editor.setAutocompleteProvider(this.#memberAutocomplete());
    this.#tui.requestRender();
  }

  removeMembers(memberIds: string[]): void {
    for (const memberId of memberIds) this.#members.delete(memberId);
    this.#editor.setAutocompleteProvider(this.#memberAutocomplete());
    this.#tui.requestRender();
  }

  receiveMessage(message: HistoryMessage): void {
    const existing = this.#messages.findIndex((item) => item.messageId === message.messageId);
    if (existing === -1) this.#messages.push(message);
    else this.#messages[existing] = message;

    if (message.requestId !== undefined && message.senderType === "agent") {
      const request = this.#messages.find(
        (item) => item.messageId === message.requestId || item.routeRequestId === message.requestId,
      );
      if (request?.routeRequestId === message.requestId) request.routeStatus = "completed";
      else if (request !== undefined) request.status = "completed";
    }
    if (this.#pendingMessage?.id === message.messageId && message.status !== "failed") {
      const sentText = this.#pendingMessage.text;
      this.#editor.addToHistory(sentText);
      if (this.#editor.getExpandedText() === sentText) this.#editor.setText("");
      this.#pendingMessage = undefined;
      this.#editor.disableSubmit = this.#connection !== "connected";
      this.#error = undefined;
    }
    this.#tui.requestRender();
  }

  receiveFailure(failure: SendFailedPayload): void {
    const message = this.#messages.find(
      (item) => item.messageId === failure.requestId || item.routeRequestId === failure.requestId,
    );
    if (message !== undefined) {
      if (message.routeRequestId === failure.requestId) {
        message.routeStatus = "failed";
        message.routeFailureReason = failure.reason;
      } else {
        message.status = "failed";
        message.failureReason = failure.reason;
      }
    }
    if (this.#pendingMessage?.id === failure.requestId) {
      this.#pendingMessage = undefined;
      this.#editor.disableSubmit = this.#connection !== "connected";
    }
    this.#error = `发送失败：${failureText(failure.reason)}`;
    this.#tui.requestRender();
  }

  receiveError(error: ErrorPayload): void {
    const pendingSetup = this.#pendingSetup;
    if (pendingSetup !== undefined && error.requestId === pendingSetup.id) {
      const failedStage = pendingSetup.stage;
      this.#pendingSetup = undefined;
      this.#stage =
        error.message.startsWith("用户名称") ? "user" :
        error.message.startsWith("Agent 名称") || error.message.startsWith("用户名称与 Agent") ? "agent" :
        error.code === "group_not_found" ? "join" : failedStage;
    }
    if (error.requestId === this.#pendingMessage?.id) {
      this.#pendingMessage = undefined;
      this.#editor.disableSubmit = this.#connection !== "connected";
    }
    this.#error = error.message;
    this.#syncFocus();
    this.#tui.requestRender();
  }

  setOwnAgentBusy(busy: boolean): void {
    const ownAgent = this.#ownMember("agent");
    if (ownAgent !== undefined) {
      ownAgent.agentStatus = busy ? "busy" : "idle";
      this.#tui.requestRender();
    }
  }

  setPendingRequests(requests: AgentRequestPayload[]): void {
    this.#pendingRequests = sortPendingRequests(requests);
    this.#pendingList = this.#createPendingList();
    if (
      this.#selectedRequest !== undefined &&
      !this.#pendingRequests.some(
        (request) => request.requestId === this.#selectedRequest?.requestId,
      )
    ) {
      this.#selectedRequest = undefined;
      if (this.#panel === "decision") this.#panel = "pending";
    }
    this.#permissionList = this.#createPermissionList();
    this.#syncFocus();
    this.#tui.requestRender();
  }

  setPermission(permission: AgentPermission): void {
    this.#permission = permission;
    this.#permissionList = this.#createPermissionList();
    this.#tui.requestRender();
  }

  setPausedChains(chains: PausedChainPayload[]): void {
    this.#pausedChains = sortPausedChains(chains);
    this.#chainList = this.#createChainList();
    if (
      this.#selectedChain !== undefined &&
      !this.#pausedChains.some((chain) => chain.chainId === this.#selectedChain?.chainId)
    ) {
      this.#selectedChain = undefined;
      if (this.#panel === "chain-decision") this.#panel = "chains";
    }
    this.#permissionList = this.#createPermissionList();
    this.#syncFocus();
    this.#tui.requestRender();
  }

  receiveChainResolved(result: ChainResolvedPayload): void {
    const text =
      result.action === "continued"
        ? `${result.initiatorName} 已允许自动对话继续至第 ${result.roundLimit} 轮`
        : result.action === "ended"
          ? `${result.initiatorName} 已结束自动对话`
          : "自动对话继续失败，目标当前不可用";
    this.#addNotice(text);
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.#exitList !== undefined) {
      this.#exitList.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    if (this.#panel !== undefined) {
      if (matchesKey(data, Key.escape)) this.#closePanel();
      else this.#activePanel()?.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    if (this.#stage === "chat" && matchesKey(data, "ctrl+p")) {
      this.#panel = "permission";
      this.#permissionList = this.#createPermissionList();
      this.#syncFocus();
      this.#tui.requestRender();
      return;
    }
    if (this.#stage === "chat" && matchesKey(data, Key.escape)) {
      this.#requestClose();
      return;
    }
    this.#activeInput()?.handleInput?.(data);
    this.#tui.requestRender();
  }

  invalidate(): void {
    this.#userInput.invalidate();
    this.#agentInput.invalidate();
    this.#groupInput.invalidate();
    this.#editor.invalidate();
    this.#actionList.invalidate();
    this.#groupList.invalidate();
    this.#permissionList.invalidate();
    this.#pendingList.invalidate();
    this.#decisionList.invalidate();
    this.#chainList.invalidate();
    this.#chainDecisionList.invalidate();
  }

  render(width: number): string[] {
    if (this.#exitList !== undefined) return this.#renderExit(width);
    if (this.#panel !== undefined) return this.#renderPanel(width);
    if (this.#stage !== "chat") return this.#renderSetup(width);
    return this.#renderChat(width);
  }

  dispose(): void {
    this.#actions.close();
  }

  #activeInput(): Component & Partial<Focusable> | undefined {
    if (this.#panel !== undefined) return this.#activePanel();
    switch (this.#stage) {
      case "user": return this.#userInput;
      case "agent": return this.#agentInput;
      case "action": return this.#actionList;
      case "create": return this.#groupInput;
      case "join": return this.#groupList;
      case "chat": return this.#editor;
    }
  }

  #syncFocus(): void {
    for (const input of [
      this.#userInput,
      this.#agentInput,
      this.#groupInput,
      this.#editor,
    ]) {
      input.focused = false;
    }
    const active = this.#activeInput();
    if (active !== undefined && "focused" in active) active.focused = this.#focused;
  }

  #acceptName(value: string): boolean {
    const name = value.trim();
    if ([...name].length < 1 || [...name].length > 24 || !/^[\p{Script=Han}A-Za-z0-9_-]+$/u.test(name)) {
      this.#error = "名称须为 1～24 个中文、英文、数字、_ 或 -";
      this.#tui.requestRender();
      return false;
    }
    this.#error = undefined;
    return true;
  }

  #submitCreate(value: string): void {
    if (!this.#acceptName(value) || this.#pendingSetup !== undefined) return;
    const id = this.#actions.createGroup(value.trim(), this.userName, this.agentName);
    if (id === undefined) {
      this.#error = "Broker 未连接，正在重试";
      return;
    }
    this.#groupInput.setValue(value.trim());
    this.#pendingSetup = { id, stage: "create" };
    this.#error = "正在创建群组…";
    this.#tui.requestRender();
  }

  #submitMessage(value: string): void {
    const text = value.trim();
    if (!text || this.#pendingMessage !== undefined || this.#connection !== "connected") return;
    const id = this.#actions.sendMessage(text);
    if (id === undefined) {
      this.#error = "Broker 未连接，消息尚未发送";
      this.#tui.requestRender();
      return;
    }
    this.#pendingMessage = { id, text };
    this.#editor.disableSubmit = true;
    this.#error = "正在确认消息…";
    this.#tui.requestRender();
  }

  #goBack(): void {
    this.#error = undefined;
    this.#stage =
      this.#stage === "agent" ? "user" :
      this.#stage === "action" ? "agent" :
      this.#stage === "create" || this.#stage === "join" ? "action" : this.#stage;
    this.#syncFocus();
    this.#tui.requestRender();
  }

  #requestClose(): void {
    const needsConfirmation =
      this.#stage === "chat" &&
      (Boolean(this.#editor.getExpandedText().trim()) || this.#ownMember("agent")?.agentStatus === "busy");
    if (!needsConfirmation) {
      this.#actions.close();
      this.#done();
      return;
    }
    this.#exitList = this.#createSelectList([
      { value: "cancel", label: "继续聊天", description: "保留草稿和当前任务" },
      { value: "exit", label: "确认退出", description: "丢弃草稿并中止当前群聊任务" },
    ]);
    this.#exitList.onSelect = (item) => {
      if (item.value === "exit") {
        this.#actions.close();
        this.#done();
      } else {
        this.#exitList = undefined;
        this.#syncFocus();
        this.#tui.requestRender();
      }
    };
    this.#exitList.onCancel = () => {
      this.#exitList = undefined;
      this.#syncFocus();
      this.#tui.requestRender();
    };
    this.#syncFocus();
    this.#tui.requestRender();
  }

  #renderSetup(width: number): string[] {
    const title = this.#theme.bold(this.#theme.fg("accent", "Pi Comms"));
    const step =
      this.#stage === "user" ? "设置用户名称" :
      this.#stage === "agent" ? "设置 Agent 名称" :
      this.#stage === "action" ? "选择操作" :
      this.#stage === "create" ? "创建群组" : "选择群组";
    const lines = [title, this.#theme.fg("muted", step), ""];
    if (this.#stage === "join" && this.#groups.length === 0) {
      lines.push(this.#theme.fg("muted", "暂无群组，请按 Esc 返回创建群组"));
    } else {
      lines.push(...(this.#activeInput()?.render(width) ?? []));
    }
    if (this.#error !== undefined) lines.push("", this.#theme.fg("warning", this.#error));
    lines.push("", this.#theme.fg("dim", this.#stage === "user" ? "Enter 继续 · Esc 退出" : "Enter 继续 · Esc 返回"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  #renderChat(width: number): string[] {
    const header = this.#renderHeader(width);
    const timeline = this.#renderTimeline(width);
    const status = this.#renderStatus(width);
    const editor = this.#editor.render(width);
    const hint = truncateToWidth(
      this.#theme.fg("dim", "Enter 发送 · Shift+Enter 换行 · Ctrl+P 控制 · Esc 退出"),
      width,
    );
    const error = this.#error === undefined
      ? []
      : [truncateToWidth(this.#theme.fg("warning", this.#error), width)];
    return [...header, "", ...timeline, ...status, ...error, ...editor, hint];
  }

  #renderHeader(width: number): string[] {
    const group = this.#snapshot?.group?.groupName ?? "未加入群组";
    return [truncateToWidth(this.#theme.bold(this.#theme.fg("accent", `Pi Comms · ${group}`)), width)];
  }

  #renderStatus(width: number): string[] {
    const state =
      this.#connection === "connected" ? this.#theme.fg("success", "● 已连接") :
      this.#connection === "reconnecting" ? this.#theme.fg("warning", "● 正在重连") :
      this.#theme.fg("warning", "● 正在连接");
    const online = [...this.#members.values()].filter((member) => member.online);
    const sessions = new Set(online.map((member) => member.clientId)).size;
    const busy = online.filter((member) => member.type === "agent" && member.agentStatus === "busy").length;
    const pending = this.#pendingRequests.length > 0 ? ` · 待批准：${this.#pendingRequests.length}` : "";
    const chains = this.#pausedChains.length > 0 ? ` · 待决定：${this.#pausedChains.length}` : "";
    const first = `${state} · ${sessions} 人在线 · ${busy} 个 Agent 忙碌 · 接收：${permissionLabel(this.#permission)}${pending}${chains}`;
    const lines = [truncateToWidth(this.#theme.fg("muted", first), width)];
    if (width >= 80) {
      const members = sortedMembers(online, this.#snapshot?.clientId)
        .map((member) => memberLabel(member, this.#snapshot?.clientId))
        .join("、");
      lines.push(...wrapTextWithAnsi(this.#theme.fg("dim", `成员：${members || "暂无"}`), width));
    }
    return ["", ...lines];
  }

  #renderTimeline(width: number): string[] {
    const entries = [
      ...this.#messages.map((message) => ({ ...message, entryType: "message" as const })),
      ...this.#notices.map((notice) => ({ ...notice, entryType: "notice" as const })),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const result: string[] = [];
    let currentDate = "";
    let previousMessage: HistoryMessage | undefined;
    for (const entry of entries) {
      const date = formatDate(entry.timestamp);
      if (date !== currentDate) {
        currentDate = date;
        previousMessage = undefined;
        result.push(centerLine(` ${date} `, width, "─", (text) => this.#theme.fg("dim", text)));
      }
      if (entry.entryType === "notice") {
        result.push(centerLine(` ${entry.text} `, width, " ", (text) => this.#theme.fg("dim", text)), "");
        previousMessage = undefined;
        continue;
      }
      const showHeader =
        previousMessage === undefined ||
        previousMessage.senderId !== entry.senderId ||
        entry.timestamp - previousMessage.timestamp > 2 * 60 * 1000;
      result.push(...this.#renderMessage(entry, width, showHeader), "");
      previousMessage = entry;
    }
    if (result.length === 0) result.push(this.#theme.fg("dim", "还没有消息，发一条试试。"));
    return result;
  }

  #renderMessage(message: HistoryMessage, width: number, showHeader: boolean): string[] {
    const own = message.senderId === this.#ownMember("user")?.memberId;
    const blockWidth = messageBlockWidth(width, message.senderType);
    const role = message.senderType === "agent"
      ? ` [Agent${message.round === undefined ? "" : ` · 第 ${message.round} 轮`}]`
      : "";
    const sender = own ? "你" : message.senderName;
    const label = `${sender}${role}  ${formatTime(message.timestamp)}`;
    const lines: string[] = [];
    if (showHeader) {
      lines.push(this.#theme.fg(message.senderType === "agent" ? "accent" : "muted", label));
    }
    lines.push(...wrapTextWithAnsi(message.text, blockWidth));
    const state = messageState(message);
    const route = routeState(message);
    if (state !== undefined) {
      lines.push(...wrapTextWithAnsi(
        this.#theme.fg(message.status === "failed" ? "error" : "warning", state),
        blockWidth,
      ));
    }
    if (route !== undefined) {
      lines.push(...wrapTextWithAnsi(
        this.#theme.fg(message.routeStatus === "failed" ? "error" : "warning", route),
        blockWidth,
      ));
    }
    const clipped = lines.map((line) => truncateToWidth(line, blockWidth));
    return own ? alignBlockRight(clipped, width) : clipped;
  }

  #renderExit(width: number): string[] {
    return [
      this.#theme.bold("退出群聊？"),
      this.#theme.fg("warning", "草稿会丢失，正在处理的群聊请求会中止。"),
      "",
      ...(this.#exitList?.render(width) ?? []),
      "",
      this.#theme.fg("dim", "Enter 确认 · Esc 返回"),
    ].map((line) => truncateToWidth(line, width));
  }

  #renderPanel(width: number): string[] {
    const title =
      this.#panel === "permission" ? "Agent 控制" :
      this.#panel === "pending" ? "待批准请求" :
      this.#panel === "decision" ? "处理请求" :
      this.#panel === "chains" ? "待决定自动对话" : "处理自动对话";
    const lines = [this.#theme.bold(title), ""];
    if (this.#panel === "pending" && this.#pendingRequests.length === 0) {
      lines.push(this.#theme.fg("muted", "暂无待批准请求"));
    } else if (this.#panel === "chains" && this.#pausedChains.length === 0) {
      lines.push(this.#theme.fg("muted", "暂无待决定自动对话"));
    } else if (this.#panel === "decision" && this.#selectedRequest !== undefined) {
      const request = this.#selectedRequest;
      lines.push(
        this.#theme.fg(
          "muted",
          `来自：${request.senderName}  ${formatTime(request.createdAt ?? Date.now())}`,
        ),
        ...request.text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", width)),
        "",
        ...this.#decisionList.render(width),
      );
    } else if (this.#panel === "chain-decision" && this.#selectedChain !== undefined) {
      const chain = this.#selectedChain;
      lines.push(
        this.#theme.fg("muted", `待发送：${chain.sourceAgentName} → ${chain.targetAgentName} · 下一轮 ${chain.nextRound}`),
        this.#theme.fg("muted", `参与 Agent：${chain.participants.join("、")}`),
        ...chain.text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", width)),
        "",
        ...this.#chainDecisionList.render(width),
      );
    } else {
      lines.push(...(this.#activePanel()?.render(width) ?? []));
    }
    if (this.#error !== undefined) {
      lines.push("", this.#theme.fg("warning", this.#error));
    }
    lines.push("", this.#theme.fg("dim", "Enter 确认 · Esc 返回"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  #activePanel(): SelectList | undefined {
    if (this.#panel === "permission") return this.#permissionList;
    if (this.#panel === "pending") return this.#pendingList;
    if (this.#panel === "decision") return this.#decisionList;
    if (this.#panel === "chains") return this.#chainList;
    if (this.#panel === "chain-decision") return this.#chainDecisionList;
    return undefined;
  }

  #closePanel(): void {
    if (this.#panel === "decision") this.#panel = "pending";
    else if (this.#panel === "chain-decision") this.#panel = "chains";
    else if (this.#panel === "pending") this.#panel = "permission";
    else if (this.#panel === "chains") this.#panel = "permission";
    else this.#panel = undefined;
    this.#error = undefined;
    this.#syncFocus();
  }

  #createSelectList(items: SelectItem[]): SelectList {
    return new SelectList(items, 8, this.#selectTheme());
  }

  #createPermissionList(): SelectList {
    const current = "（当前）";
    const list = this.#createSelectList([
      {
        value: "pending",
        label: `待批准请求（${this.#pendingRequests.length}）`,
        description: "逐条查看、批准或拒绝",
      },
      {
        value: "chains",
        label: `待决定自动对话（${this.#pausedChains.length}）`,
        description: "每 10 轮选择继续或结束",
      },
      {
        value: "auto",
        label: `自动接收${this.#permission === "auto" ? current : ""}`,
        description: "@Agent 后立即进入队列",
      },
      {
        value: "approval",
        label: `需要批准${this.#permission === "approval" ? current : ""}`,
        description: "批准后才进入队列",
      },
      {
        value: "blocked",
        label: `禁止接收${this.#permission === "blocked" ? current : ""}`,
        description: "拒绝新的 @Agent 请求",
      },
    ]);
    list.onSelect = (item) => {
      if (item.value === "pending") {
        this.#panel = "pending";
      } else if (item.value === "chains") {
        this.#panel = "chains";
      } else {
        const permission = item.value as AgentPermission;
        this.#permission = permission;
        const synced = this.#actions.updatePermission(permission);
        this.#panel = undefined;
        this.#error = synced ? undefined : "权限已保存，等待同步";
      }
      this.#syncFocus();
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#closePanel();
    return list;
  }

  #createPendingList(): SelectList {
    const list = this.#createSelectList(
      this.#pendingRequests.map((request) => ({
        value: request.requestId,
        label: `${request.senderName}  ${formatTime(request.createdAt ?? Date.now())}`,
        description: request.text.replace(/\s+/g, " "),
      })),
    );
    list.onSelect = (item) => {
      this.#selectedRequest = this.#pendingRequests.find(
        (request) => request.requestId === item.value,
      );
      if (this.#selectedRequest !== undefined) this.#panel = "decision";
      this.#syncFocus();
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#closePanel();
    return list;
  }

  #createDecisionList(): SelectList {
    const list = this.#createSelectList([
      { value: "approve", label: "批准", description: "进入 Agent 处理队列" },
      { value: "reject", label: "拒绝", description: "公开显示已拒绝" },
      { value: "back", label: "返回", description: "暂不处理" },
    ]);
    list.onSelect = (item) => {
      if (item.value === "back") {
        this.#closePanel();
        return;
      }
      const request = this.#selectedRequest;
      if (request === undefined) return;
      const id = item.value === "approve"
        ? this.#actions.approveRequest(request.requestId)
        : this.#actions.rejectRequest(request.requestId);
      if (id === undefined) {
        this.#error = "Broker 未连接，操作尚未发送";
        this.#tui.requestRender();
        return;
      }
      this.#selectedRequest = undefined;
      this.#panel = "pending";
      this.#error = undefined;
      this.#syncFocus();
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#closePanel();
    return list;
  }

  #createChainList(): SelectList {
    const list = this.#createSelectList(
      this.#pausedChains.map((chain) => ({
        value: chain.chainId,
        label: `${chain.sourceAgentName} → ${chain.targetAgentName} · 下一轮 ${chain.nextRound}`,
        description: `${chain.text.replace(/\s+/g, " ")} · ${chain.participants.length} 个 Agent · ${formatTime(chain.pausedAt)}`,
      })),
    );
    list.onSelect = (item) => {
      this.#selectedChain = this.#pausedChains.find((chain) => chain.chainId === item.value);
      if (this.#selectedChain !== undefined) this.#panel = "chain-decision";
      this.#syncFocus();
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#closePanel();
    return list;
  }

  #createChainDecisionList(): SelectList {
    const list = this.#createSelectList([
      { value: "continue", label: "继续 10 轮", description: "沿用通信链和轮数" },
      { value: "end", label: "结束对话", description: "不再发送下一轮请求" },
      { value: "back", label: "返回", description: "暂不处理" },
    ]);
    list.onSelect = (item) => {
      if (item.value === "back") {
        this.#closePanel();
        return;
      }
      const chain = this.#selectedChain;
      if (chain === undefined) return;
      const id = item.value === "continue"
        ? this.#actions.continueChain?.(chain.chainId)
        : this.#actions.endChain?.(chain.chainId);
      if (id === undefined) {
        this.#error = "Broker 未连接，操作尚未发送";
        this.#tui.requestRender();
        return;
      }
      this.#selectedChain = undefined;
      this.#panel = "chains";
      this.#error = undefined;
      this.#syncFocus();
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#closePanel();
    return list;
  }

  #createGroupList(): SelectList {
    const list = this.#createSelectList(
      this.#groups.map((group) => ({
        value: group.groupId,
        label: group.groupName,
        description: `${group.onlineSessionCount} 人在线`,
      })),
    );
    list.onSelect = (item) => {
      if (this.#pendingSetup !== undefined) return;
      const id = this.#actions.joinGroup(item.value, this.userName, this.agentName);
      if (id === undefined) {
        this.#error = "Broker 未连接，正在重试";
      } else {
        this.#pendingSetup = { id, stage: "join" };
        this.#error = "正在加入群组…";
      }
      this.#tui.requestRender();
    };
    list.onCancel = () => this.#goBack();
    return list;
  }

  #selectTheme() {
    return {
      selectedPrefix: (text: string) => this.#theme.fg("accent", text),
      selectedText: (text: string) => this.#theme.bold(text),
      description: (text: string) => this.#theme.fg("dim", text),
      scrollInfo: (text: string) => this.#theme.fg("muted", text),
      noMatch: (text: string) => this.#theme.fg("warning", text),
    };
  }

  #memberAutocomplete(): AutocompleteProvider {
    const members = [...this.#members.values()].filter((member) => member.online);
    return {
      triggerCharacters: ["@"],
      getSuggestions: async (lines, line, col) => {
        if (line !== 0) return null;
        const before = (lines[0] ?? "").slice(0, col);
        const match = before.match(/^@([^\s@]*)$/u);
        if (match === null) return null;
        const query = match[1].toLocaleLowerCase("en-US");
        const items: AutocompleteItem[] = members
          .filter((member) => member.displayName.toLocaleLowerCase("en-US").includes(query))
          .map((member) => ({
            value: member.displayName,
            label: member.displayName,
            description: member.type === "agent" ? "Agent" : "用户",
          }));
        return items.length === 0 ? null : { prefix: `@${match[1]}`, items };
      },
      applyCompletion: (lines, line, col, item, prefix) => {
        const current = lines[line] ?? "";
        const start = Math.max(0, col - prefix.length);
        const replacement = `@${item.value} `;
        const next = [...lines];
        next[line] = current.slice(0, start) + replacement + current.slice(col);
        return { lines: next, cursorLine: line, cursorCol: start + replacement.length };
      },
    };
  }

  #ownMember(type: "user" | "agent"): Member | undefined {
    return [...this.#members.values()].find(
      (member) => member.clientId === this.#snapshot?.clientId && member.type === type,
    );
  }

  #addNotice(text: string): void {
    this.#noticeCounter += 1;
    this.#notices.push({ id: `notice-${this.#noticeCounter}`, timestamp: Date.now(), text });
  }
}

function sortGroups(groups: GroupSummary[]): GroupSummary[] {
  return [...groups].sort(
    (a, b) => b.onlineSessionCount - a.onlineSessionCount || a.groupName.localeCompare(b.groupName, "zh-CN"),
  );
}

function sortPendingRequests(requests: AgentRequestPayload[]): AgentRequestPayload[] {
  return [...requests].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
}

function sortPausedChains(chains: PausedChainPayload[]): PausedChainPayload[] {
  return [...chains].sort((a, b) => b.pausedAt - a.pausedAt);
}

function sortedMembers(members: Member[], clientId?: string): Member[] {
  return [...members].sort((a, b) => {
    const own = Number(b.clientId === clientId) - Number(a.clientId === clientId);
    if (own !== 0) return own;
    if (a.clientId === b.clientId && a.type !== b.type) return a.type === "user" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, "zh-CN");
  });
}

function memberLabel(member: Member, clientId?: string): string {
  const own = member.clientId === clientId && member.type === "user" ? "（我）" : "";
  const activity = member.online
    ? member.agentStatus === "busy" ? "忙碌" : "空闲"
    : "离线";
  const permission = member.agentPermission === undefined
    ? ""
    : `·${permissionLabel(member.agentPermission)}`;
  const pending = (member.pendingApprovalCount ?? 0) > 0
    ? `·待批准 ${member.pendingApprovalCount}`
    : "";
  const agent = member.type === "agent"
    ? ` [Agent·${activity}${permission}${pending}]`
    : "";
  return `${member.displayName}${own}${agent}`;
}

function permissionLabel(permission: AgentPermission): string {
  if (permission === "approval") return "需批准";
  if (permission === "blocked") return "禁止接收";
  return "自动";
}

function dedupeMessages(messages: HistoryMessage[]): HistoryMessage[] {
  return [...new Map(messages.map((message) => [message.messageId, { ...message }])).values()];
}

function messageBlockWidth(width: number, senderType: HistoryMessage["senderType"]): number {
  const ratio = width < 60 ? 0.94 : senderType === "agent" ? 0.85 : 0.7;
  return Math.min(width, Math.max(12, Math.floor(width * ratio)));
}

function alignBlockRight(lines: string[], width: number): string[] {
  const contentWidth = Math.min(
    width,
    Math.max(1, ...lines.map((line) => visibleWidth(line))),
  );
  const indent = " ".repeat(Math.max(0, width - contentWidth));
  return lines.map((line) => `${indent}${truncateToWidth(line, contentWidth)}`);
}

function centerLine(text: string, width: number, fill: string, style: (text: string) => string): string {
  const clipped = truncateToWidth(text, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  return style(`${fill.repeat(left)}${clipped}${fill.repeat(remaining - left)}`);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
}

function messageState(message: HistoryMessage): string | undefined {
  if (message.status === "waiting_approval") return "等待目标批准";
  if (message.status === "queued") return "排队处理中…";
  if (message.status === "processing") return "处理中…";
  if (message.status === "completed") return "已完成";
  if (message.status === "interrupted") return "已中断";
  if (message.status === "failed") return `失败：${failureText(message.failureReason)}`;
  return undefined;
}

function routeState(message: HistoryMessage): string | undefined {
  const target = message.routeTargetName ?? "目标 Agent";
  const round = message.nextRound === undefined ? "" : ` · 下一轮：${message.nextRound}`;
  switch (message.routeStatus) {
    case "waiting_approval": return `等待 ${target} 所属用户批准${round}`;
    case "queued":
    case "processing": return `已进入 ${target} 队列${round}`;
    case "completed": return `${target} 已回答${round}`;
    case "failed": return `自动对话未继续：${failureText(message.routeFailureReason)}`;
    case "paused": return `已达到第 ${message.round ?? 0} 轮，等待原发起者决定`;
    case "ended": return `原发起者已结束自动对话（停在第 ${message.round ?? 0} 轮）`;
    default: return undefined;
  }
}

function failureText(reason?: string): string {
  switch (reason) {
    case "target_not_found": return "找不到目标";
    case "target_offline":
    case "target_disconnected": return "目标 Agent 不在线";
    case "target_blocked": return "目标 Agent 已禁止接收";
    case "request_rejected": return "目标 Agent 主人已拒绝";
    case "request_invalid": return "请求已失效";
    case "agent_busy": return "目标 Agent 正忙";
    case "no_text": return "Agent 未产生文本回答";
    case "broker_restarted": return "Broker 已重启";
    case "target_self": return "Agent 不能 @ 自己";
    case "empty_mention": return "@Agent 后缺少内容";
    default: return "请求处理失败";
  }
}
