import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRequestPayload,
  AgentResultAckPayload,
  AgentResultPayload,
  BrokerEnvelope,
  HistoryMessage,
  PausedChainPayload,
  SnapshotPayload,
} from "../protocol.js";
import type { AgentPermission, Group, GroupSummary, Member } from "../types.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  validateConnectEndpoint,
  type TcpConnectEndpoint,
} from "../transport/tcp-endpoint.js";
import { ChatView } from "../tui/chat-view.js";
import { BrokerClient } from "./broker-client.js";
import { startLocalBroker } from "./broker-process.js";
import { RemoteQueue } from "./remote-queue.js";

const STATUS_KEY = "pi-comms";
const PERMISSION_ENTRY = "pi-comms-permission";
const DEFAULT_RESULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_BROKER_START_TIMEOUT_MS = 8_000;

export interface CommsExtensionOptions {
  endpoint?: TcpConnectEndpoint;
  reconnectIntervalMs?: number;
  resultRetryIntervalMs?: number;
  startBroker?: () => Promise<void> | void;
  registerTestCommands?: boolean;
}

export function createCommsExtension(
  options: CommsExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const endpoint = validateConnectEndpoint(options.endpoint ?? DEFAULT_BROKER_ENDPOINT);
  const resultRetryIntervalMs =
    options.resultRetryIntervalMs ?? DEFAULT_RESULT_RETRY_INTERVAL_MS;
  const startBroker = options.startBroker ?? (() => startLocalBroker(endpoint));

  return (pi: ExtensionAPI) => {
    const remoteQueue = new RemoteQueue();
    let context: ExtensionContext | undefined;
    let ui: ExtensionUIContext | undefined;
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let brokerInstanceId: string | undefined;
    let currentGroup: Group | undefined;
    let desiredMembership:
      | { groupId: string; userName: string; agentName: string }
      | undefined;
    let history: HistoryMessage[] = [];
    let availableGroups: GroupSummary[] = [];
    let members = new Map<string, Member>();
    let lastAssistantText: string | undefined;
    let resultRetryTimer: ReturnType<typeof setInterval> | undefined;
    let shuttingDown = false;
    let commsOpen = false;
    let activeView: ChatView | undefined;
    let cachedUserName = "";
    let cachedAgentName = "";
    let brokerStartTask: Promise<boolean> | undefined;
    let brokerStartError: string | undefined;
    let permission: AgentPermission = "auto";
    const pendingApprovals = new Map<string, AgentRequestPayload>();
    const pausedChains = new Map<string, PausedChainPayload>();

    const brokerClient = new BrokerClient({
      endpoint,
      reconnectIntervalMs: options.reconnectIntervalMs,
      onMessage: handleBrokerMessage,
      onDisconnected: (wasConnected) => {
        clientId = undefined;
        setConnected(false);
        if (!shuttingDown && commsOpen) {
          activeView?.setConnection("reconnecting");
          void connectOrStartBroker();
        }
      },
    });

    function updateContext(ctx: ExtensionContext): void {
      context = ctx;
      ui = ctx.ui;
      sessionId = ctx.sessionManager.getSessionId();
    }

    function setConnected(connected: boolean): void {
      activeView?.setConnection(connected ? "connected" : "reconnecting");
      if (activeView === undefined) {
        ui?.setStatus(
          STATUS_KEY,
          connected ? "Broker 已连接" : "Broker 未连接",
        );
      }
    }

    function handleBrokerMessage(message: BrokerEnvelope): void {
      switch (message.type) {
        case "snapshot":
          handleSnapshot(message.payload);
          return;
        case "groups.changed":
          availableGroups = message.payload.groups;
          activeView?.setGroups(availableGroups);
          return;
        case "presence.changed":
          if (message.payload.groupId === currentGroup?.groupId) {
            members.set(message.payload.memberId, message.payload);
            activeView?.updatePresence(message.payload);
          }
          return;
        case "presence.removed":
          for (const memberId of message.payload.memberIds) members.delete(memberId);
          activeView?.removeMembers(message.payload.memberIds);
          return;
        case "chat.message":
          if (
            message.payload.routeRequestId !== undefined &&
            message.payload.routeStatus !== "waiting_approval"
          ) {
            pendingApprovals.delete(message.payload.routeRequestId);
          }
          if (
            message.payload.requestId !== undefined &&
            message.payload.status !== "waiting_approval"
          ) {
            pendingApprovals.delete(message.payload.requestId);
          }
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          {
            const receivedMessage: HistoryMessage = {
              ...message.payload,
              messageId: message.id,
              timestamp: message.timestamp,
            };
            const historyIndex = history.findIndex(
              (item) => item.messageId === receivedMessage.messageId,
            );
            if (historyIndex === -1) {
              history.push(receivedMessage);
            } else {
              history[historyIndex] = receivedMessage;
            }
            activeView?.receiveMessage(receivedMessage);
          }
          if (activeView === undefined) {
            ui?.notify(`[${message.payload.senderName}] ${message.payload.text}`, "info");
          }
          return;
        case "agent.deliver":
          handleAgentDelivery(message.payload);
          return;
        case "request.pending":
          pendingApprovals.set(message.payload.requestId, message.payload);
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          return;
        case "chain.paused":
          pausedChains.set(message.payload.chainId, message.payload);
          activeView?.setPausedChains([...pausedChains.values()]);
          ui?.notify(
            `自动对话已达到第 ${message.payload.roundLimit} 轮，请在 Ctrl+P 中决定`,
            "warning",
          );
          return;
        case "chain.resolved":
          pausedChains.delete(message.payload.chainId);
          activeView?.setPausedChains([...pausedChains.values()]);
          activeView?.receiveChainResolved(message.payload);
          return;
        case "agent.result.ack":
          handleResultAck(message.payload);
          return;
        case "send.failed":
          pendingApprovals.delete(message.payload.requestId);
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          activeView?.receiveFailure(message.payload);
          if (activeView === undefined) ui?.notify(`请求失败：${failureMessage(message.payload.reason)}`, "error");
          return;
        case "error":
          activeView?.receiveError(message.payload);
          if (activeView === undefined) ui?.notify(`Broker 错误：${message.payload.message}`, "error");
          return;
      }
    }

    function handleSnapshot(snapshot: SnapshotPayload): void {
      const brokerRestarted =
        brokerInstanceId !== undefined &&
        brokerInstanceId !== snapshot.brokerInstanceId;
      if (brokerRestarted) {
        clearRemoteWork();
        if (activeView === undefined) {
          ui?.notify("Broker 已重启，旧远程请求已中止，正在恢复群组", "warning");
        }
      }

      const previousGroupId = currentGroup?.groupId;
      brokerInstanceId = snapshot.brokerInstanceId;
      clientId = snapshot.clientId;
      availableGroups = snapshot.groups;
      currentGroup = snapshot.group;
      history = snapshot.messages;
      pausedChains.clear();
      for (const chain of snapshot.pausedChains ?? []) pausedChains.set(chain.chainId, chain);
      members = new Map(
        snapshot.members.map((member) => [member.memberId, member]),
      );
      activeView?.applySnapshot(snapshot);
      activeView?.setPausedChains([...pausedChains.values()]);
      if (snapshot.group !== undefined) {
        const ownMembers = snapshot.members.filter(
          (member) => member.clientId === snapshot.clientId,
        );
        const user = ownMembers.find((member) => member.type === "user");
        const agent = ownMembers.find((member) => member.type === "agent");
        if (user !== undefined && agent !== undefined) {
          desiredMembership = {
            groupId: snapshot.group.groupId,
            userName: user.displayName,
            agentName: agent.displayName,
          };
        }
      }
      setConnected(true);
      if (
        snapshot.group !== undefined &&
        previousGroupId !== snapshot.group.groupId
      ) {
        if (activeView === undefined) {
          ui?.notify(
            `已加入群组：${snapshot.group.groupName}\nGroup ID: ${snapshot.group.groupId}`,
            "info",
          );
          if (history.length > 0) {
            ui?.notify(`已加载 ${history.length} 条历史消息`, "info");
          }
        }
      } else if (
        snapshot.group === undefined &&
        previousGroupId !== undefined &&
        !brokerRestarted
      ) {
        if (activeView === undefined) ui?.notify("已离开群组", "info");
        desiredMembership = undefined;
        history = [];
      } else if (previousGroupId === undefined && !brokerRestarted) {
        if (activeView === undefined) {
          ui?.notify(`Broker 已连接\nSession: ${sessionId}\nClient: ${clientId}`, "info");
        }
      }
      flushPendingResults();
      tryStartNext();
      if (
        brokerRestarted &&
        snapshot.group === undefined &&
        desiredMembership !== undefined
      ) {
        brokerClient.send("group.join", desiredMembership);
      }
    }

    function handleAgentDelivery(request: AgentRequestPayload): void {
      pendingApprovals.delete(request.requestId);
      activeView?.setPendingRequests([...pendingApprovals.values()]);
      const added = remoteQueue.enqueue(request);
      brokerClient.send("agent.deliver.ack", {
        requestId: request.requestId,
      });
      if (added) {
        tryStartNext();
      }
    }

    function tryStartNext(): void {
      if (
        remoteQueue.activeRequest !== undefined ||
        context?.isIdle() !== true
      ) {
        publishAgentStatus();
        return;
      }
      const request = remoteQueue.startNext();
      if (request === undefined) {
        publishAgentStatus();
        return;
      }
      publishAgentStatus();
      activeView?.setOwnAgentBusy(true);
      lastAssistantText = undefined;
      try {
        pi.sendUserMessage(formatAgentRequest(request));
      } catch {
        completeActive({
          requestId: request.requestId,
          ok: false,
          reason: "delivery_failed",
        });
      }
    }

    function completeActive(result: AgentResultPayload): void {
      remoteQueue.completeActive(result);
      lastAssistantText = undefined;
      flushPendingResults();
      tryStartNext();
      publishAgentStatus();
    }

    function flushPendingResults(): void {
      for (const result of remoteQueue.pendingResults()) {
        brokerClient.send("agent.result", result);
      }
    }

    function handleResultAck(ack: AgentResultAckPayload): void {
      remoteQueue.acknowledgeResult(ack.requestId);
      if (!ack.accepted) {
        ui?.notify(`请求 ${ack.requestId} 已被 Broker 清理`, "warning");
      }
    }

    function clearRemoteWork(): void {
      if (remoteQueue.activeRequest !== undefined) {
        context?.abort();
      }
      remoteQueue.clear();
      lastAssistantText = undefined;
      activeView?.setOwnAgentBusy(false);
      publishAgentStatus();
    }

    function publishAgentStatus(): void {
      const busy = remoteQueue.hasWork || context?.isIdle() === false;
      brokerClient.send("agent.status", { status: busy ? "busy" : "idle" });
      activeView?.setOwnAgentBusy(busy);
    }

    async function connectOrStartBroker(): Promise<boolean> {
      if (brokerClient.connected) return true;
      if (brokerStartTask !== undefined) return brokerStartTask;
      brokerStartTask = (async () => {
        if (sessionId === undefined) return false;
        if (await brokerClient.start(sessionId, permission)) return true;
        try {
          await startBroker();
          brokerStartError = undefined;
        } catch (error) {
          brokerStartError = error instanceof Error ? error.message : String(error);
          return false;
        }
        const deadline = Date.now() + DEFAULT_BROKER_START_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          if (await brokerClient.connect()) return true;
        }
        return false;
      })();
      try {
        return await brokerStartTask;
      } finally {
        brokerStartTask = undefined;
      }
    }

    async function ensureConnected(ctx: ExtensionContext): Promise<boolean> {
      updateContext(ctx);
      if (await connectOrStartBroker()) {
        return true;
      }
      ctx.ui.notify(
        brokerStartError ?? brokerClient.lastError ?? "无法启动或连接 Broker",
        "error",
      );
      return false;
    }

    pi.on("session_start", (_event, ctx) => {
      shuttingDown = false;
      updateContext(ctx);
      permission = restorePermission(ctx);
      brokerClient.setPermission(permission);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      updateContext(ctx);
      if (resultRetryTimer !== undefined) {
        clearInterval(resultRetryTimer);
        resultRetryTimer = undefined;
      }
      clearRemoteWork();
      await brokerClient.stop();
      clientId = undefined;
      currentGroup = undefined;
      desiredMembership = undefined;
      history = [];
      availableGroups = [];
      members.clear();
      pendingApprovals.clear();
      pausedChains.clear();
      commsOpen = false;
      activeView = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("input", (event, ctx) => {
      updateContext(ctx);
      if (
        remoteQueue.activeRequest !== undefined &&
        event.source !== "extension"
      ) {
        ctx.ui.notify("正在处理远程请求，请稍后", "warning");
        return { action: "handled" as const };
      }
      return { action: "continue" as const };
    });

    pi.on("message_end", (event, ctx) => {
      updateContext(ctx);
      if (
        remoteQueue.activeRequest !== undefined &&
        event.message.role === "assistant"
      ) {
        lastAssistantText = extractAssistantText(event.message.content);
      }
    });

    pi.on("agent_start", (_event, ctx) => {
      updateContext(ctx);
      publishAgentStatus();
    });

    pi.on("agent_settled", (_event, ctx) => {
      updateContext(ctx);
      const activeRequest = remoteQueue.activeRequest;
      if (activeRequest === undefined) {
        tryStartNext();
        return;
      }
      completeActive(
        lastAssistantText === undefined
          ? {
              requestId: activeRequest.requestId,
              ok: false,
              reason: "no_text",
            }
          : {
              requestId: activeRequest.requestId,
              ok: true,
              text: lastAssistantText,
            },
      );
      publishAgentStatus();
    });

    pi.registerCommand("comms", {
      description: "打开 Pi Comms 群聊",
      handler: async (_args, ctx) => {
        updateContext(ctx);
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/comms 只能在 Pi 交互式 TUI 中使用", "error");
          return;
        }
        if (commsOpen) return;
        commsOpen = true;
        shuttingDown = false;
        resultRetryTimer ??= setInterval(flushPendingResults, resultRetryIntervalMs);

        const connection = connectOrStartBroker();
        void connection.then((connected) => {
          if (!connected && commsOpen) {
            ctx.ui.notify(
              brokerStartError ?? brokerClient.lastError ?? "无法启动或连接 Broker",
              "error",
            );
          }
        });
        try {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            const view = new ChatView({
              tui,
              theme,
              keybindings,
              done,
              initialUserName: cachedUserName,
              initialAgentName: cachedAgentName,
              initialPermission: permission,
              initialPendingRequests: [...pendingApprovals.values()],
              initialPausedChains: [...pausedChains.values()],
              actions: {
                createGroup: (groupName, userName, agentName) =>
                  brokerClient.send("group.create", { groupName, userName, agentName }),
                joinGroup: (groupId, userName, agentName) => {
                  desiredMembership = { groupId, userName, agentName };
                  return brokerClient.send("group.join", { groupId, userName, agentName });
                },
                sendMessage: (text) => brokerClient.send("chat.send", { text }),
                updatePermission: (nextPermission) => {
                  permission = nextPermission;
                  brokerClient.setPermission(nextPermission);
                  pi.appendEntry(PERMISSION_ENTRY, { permission: nextPermission });
                  return brokerClient.send("permission.update", {
                    permission: nextPermission,
                  }) !== undefined;
                },
                approveRequest: (requestId) => {
                  return brokerClient.send("request.approve", { requestId });
                },
                rejectRequest: (requestId) => {
                  return brokerClient.send("request.reject", { requestId });
                },
                continueChain: (chainId) => {
                  return brokerClient.send("chain.continue", { chainId });
                },
                endChain: (chainId) => {
                  return brokerClient.send("chain.end", { chainId });
                },
                close: clearRemoteWork,
              },
            });
            activeView = view;
            ctx.ui.setStatus(STATUS_KEY, undefined);
            view.setGroups(availableGroups);
            view.setConnection(brokerClient.connected ? "connected" : "connecting");
            if (currentGroup !== undefined && clientId !== undefined) {
              view.applySnapshot({
                brokerInstanceId: brokerInstanceId ?? "",
                clientId,
                groups: availableGroups,
                group: currentGroup,
                members: [...members.values()],
                messages: history,
                pausedChains: [...pausedChains.values()],
              });
            }
            return view;
          });
        } finally {
          await connection;
          if (activeView !== undefined) {
            cachedUserName = activeView.userName;
            cachedAgentName = activeView.agentName;
          }
          activeView = undefined;
          commsOpen = false;
          clearRemoteWork();
          desiredMembership = undefined;
          await brokerClient.stop();
          clientId = undefined;
          currentGroup = undefined;
          history = [];
          members.clear();
          pendingApprovals.clear();
          pausedChains.clear();
          if (resultRetryTimer !== undefined) {
            clearInterval(resultRetryTimer);
            resultRetryTimer = undefined;
          }
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      },
    });

    if (options.registerTestCommands) {
      registerTestCommands(pi, ensureConnected, brokerClient, () => ({
        currentGroup,
        availableGroups,
        members,
      }), (membership) => {
        desiredMembership = membership;
      }, clearRemoteWork);
    }
  };
}

export function formatAgentRequest(request: AgentRequestPayload): string {
  const online = request.onlineMembers.length
    ? request.onlineMembers
        .map(
          (member) =>
            `${member.displayName}(${member.type === "user" ? "用户" : "Agent"})`,
        )
        .join("、")
    : "无其他在线成员";
  return [
    "[Pi Comms 群聊请求]",
    `你是：${request.targetAgentName}（Agent）`,
    `所属用户：${request.ownerUserName}`,
    `来自：${request.senderName}${request.senderType === "agent" ? "（Agent）" : "（用户）"}`,
    ...(request.senderType === "agent" && request.senderOwnerUserName
      ? [`${request.senderName} 所属用户：${request.senderOwnerUserName}`]
      : []),
    `群组：${request.groupName}`,
    `在线：${online}`,
    ...(request.round > 1 ? [`这是第 ${request.round} 轮自动对话。`] : []),
    "",
    request.text,
    "",
    `你的回答会作为公开消息发送到群组「${request.groupName}」，用于回应 ${request.senderName}。请直接回答。`,
    `如果这个问题更适合群里其他在线 Agent 处理，可在回答开头 @Agent名称 并附上要转交的问题，任务会转给该 Agent；每次只转一次。`,
  ].join("\n");
}

function restorePermission(ctx: ExtensionContext): AgentPermission {
  let permission: AgentPermission = "auto";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === PERMISSION_ENTRY &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "permission" in entry.data &&
      isAgentPermission(entry.data.permission)
    ) {
      permission = entry.data.permission;
    }
  }
  return permission;
}

function isAgentPermission(value: unknown): value is AgentPermission {
  return value === "auto" || value === "approval" || value === "blocked";
}

function registerTestCommands(
  pi: ExtensionAPI,
  ensureConnected: (ctx: ExtensionContext) => Promise<boolean>,
  brokerClient: BrokerClient,
  getState: () => {
    currentGroup: Group | undefined;
    availableGroups: GroupSummary[];
    members: Map<string, Member>;
  },
  setDesiredMembership: (
    membership: { groupId: string; userName: string; agentName: string },
  ) => void,
  clearRemoteWork: () => void,
): void {
  pi.registerCommand("comms-create", {
    description: "测试：创建群组",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const values = parseCommandArgs(args, 3);
      if (values === undefined) return;
      brokerClient.send("group.create", {
        groupName: values[0],
        userName: values[1],
        agentName: values[2],
      });
    },
  });
  pi.registerCommand("comms-join", {
    description: "测试：加入群组",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const values = parseCommandArgs(args, 3);
      if (values === undefined) return;
      setDesiredMembership({ groupId: values[0], userName: values[1], agentName: values[2] });
      brokerClient.send("group.join", {
        groupId: values[0],
        userName: values[1],
        agentName: values[2],
      });
    },
  });
  pi.registerCommand("comms-members", {
    description: "测试：显示成员",
    handler: async (_args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const state = getState();
      if (state.currentGroup === undefined) {
        ctx.ui.notify(
          state.availableGroups.length
            ? state.availableGroups.map((group) => `${group.groupName} ${group.onlineSessionCount} 人在线`).join("\n")
            : "暂无群组",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `群组：${state.currentGroup.groupName}\n${[...state.members.values()]
          .map((member) => `${member.displayName} (${member.type === "user" ? "用户" : "Agent"})`)
          .join("\n")}`,
        "info",
      );
    },
  });
  pi.registerCommand("comms-leave", {
    description: "测试：离开群组",
    handler: async (_args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      clearRemoteWork();
      brokerClient.send("group.leave", {});
    },
  });
  pi.registerCommand("comms-test", {
    description: "测试：发送消息",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      if (getState().currentGroup === undefined) {
        ctx.ui.notify("请先创建或加入群组", "error");
        return;
      }
      brokerClient.send("chat.send", { text: args.trim() || "测试消息" });
    },
  });
}

function parseCommandArgs(args: string, count: number): string[] | undefined {
  const values = args.trim().split(/\s+/).filter(Boolean);
  return values.length === count ? values : undefined;
}

function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content.trim()
      ? content.trim()
      : undefined;
  }
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("")
    .trim();
  return text || undefined;
}

function failureMessage(reason: string): string {
  switch (reason) {
    case "target_not_found":
      return "当前群组中找不到目标";
    case "target_offline":
    case "target_disconnected":
      return "目标 Agent 不在线";
    case "target_blocked":
      return "目标 Agent 已禁止接收";
    case "request_rejected":
      return "目标 Agent 主人已拒绝";
    case "request_invalid":
      return "请求已失效";
    case "agent_busy":
      return "目标 Agent 正忙";
    case "no_text":
      return "Agent 未产生文本回答";
    case "delivery_failed":
      return "请求无法注入目标 Agent";
    default:
      return "未知错误";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default createCommsExtension();
