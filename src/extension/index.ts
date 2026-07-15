import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SOCKET_PATH } from "../broker/server.js";
import type {
  AgentRequestPayload,
  AgentResultAckPayload,
  AgentResultPayload,
  BrokerEnvelope,
  SnapshotPayload,
} from "../protocol.js";
import type { Group, GroupSummary, Member } from "../types.js";
import { BrokerClient } from "./broker-client.js";
import { RemoteQueue } from "./remote-queue.js";

const STATUS_KEY = "pi-comms";
const DEFAULT_TEST_MESSAGE = "来自 Pi Session 的测试消息";
const DEFAULT_RESULT_RETRY_INTERVAL_MS = 1_000;

export interface CommsExtensionOptions {
  socketPath?: string;
  reconnectIntervalMs?: number;
  resultRetryIntervalMs?: number;
}

export function createCommsExtension(
  options: CommsExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const resultRetryIntervalMs =
    options.resultRetryIntervalMs ?? DEFAULT_RESULT_RETRY_INTERVAL_MS;

  return (pi: ExtensionAPI) => {
    const remoteQueue = new RemoteQueue();
    let context: ExtensionContext | undefined;
    let ui: ExtensionUIContext | undefined;
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let brokerInstanceId: string | undefined;
    let currentGroup: Group | undefined;
    let availableGroups: GroupSummary[] = [];
    let members = new Map<string, Member>();
    let lastAssistantText: string | undefined;
    let resultRetryTimer: ReturnType<typeof setInterval> | undefined;
    let shuttingDown = false;

    const brokerClient = new BrokerClient({
      socketPath,
      reconnectIntervalMs: options.reconnectIntervalMs,
      onMessage: handleBrokerMessage,
      onDisconnected: (wasConnected) => {
        clientId = undefined;
        members.clear();
        setConnected(false);
        if (!shuttingDown && wasConnected) {
          ui?.notify("Broker 连接已断开，正在自动重连", "warning");
        }
      },
    });

    function updateContext(ctx: ExtensionContext): void {
      context = ctx;
      ui = ctx.ui;
      sessionId = ctx.sessionManager.getSessionId();
    }

    function setConnected(connected: boolean): void {
      ui?.setStatus(
        STATUS_KEY,
        connected ? "Broker 已连接" : "Broker 未连接",
      );
    }

    function handleBrokerMessage(message: BrokerEnvelope): void {
      switch (message.type) {
        case "snapshot":
          handleSnapshot(message.payload);
          return;
        case "groups.changed":
          availableGroups = message.payload.groups;
          return;
        case "presence.changed":
          if (message.payload.groupId === currentGroup?.groupId) {
            if (message.payload.online) {
              members.set(message.payload.memberId, message.payload);
            } else {
              members.delete(message.payload.memberId);
            }
          }
          return;
        case "chat.message":
          ui?.notify(
            `[${message.payload.senderName}] ${message.payload.text}`,
            "info",
          );
          return;
        case "agent.deliver":
          handleAgentDelivery(message.payload);
          return;
        case "agent.result.ack":
          handleResultAck(message.payload);
          return;
        case "send.failed":
          ui?.notify(
            `请求失败：${failureMessage(message.payload.reason)}`,
            "error",
          );
          return;
        case "error":
          ui?.notify(`Broker 错误：${message.payload.message}`, "error");
          return;
      }
    }

    function handleSnapshot(snapshot: SnapshotPayload): void {
      const brokerRestarted =
        brokerInstanceId !== undefined &&
        brokerInstanceId !== snapshot.brokerInstanceId;
      if (brokerRestarted) {
        clearRemoteWork();
        ui?.notify("Broker 已重启，群组和旧远程请求已清理", "warning");
      }

      const previousGroupId = currentGroup?.groupId;
      brokerInstanceId = snapshot.brokerInstanceId;
      clientId = snapshot.clientId;
      availableGroups = snapshot.groups;
      currentGroup = snapshot.group;
      members = new Map(
        snapshot.members.map((member) => [member.memberId, member]),
      );
      setConnected(true);
      if (snapshot.group !== undefined && previousGroupId !== snapshot.group.groupId) {
        ui?.notify(
          `已加入群组：${snapshot.group.groupName}\nGroup ID: ${snapshot.group.groupId}`,
          "info",
        );
      } else if (snapshot.group === undefined && previousGroupId !== undefined) {
        ui?.notify("已离开群组", "info");
      } else if (previousGroupId === undefined && !brokerRestarted) {
        ui?.notify(
          `Broker 已连接\nSession: ${sessionId}\nClient: ${clientId}`,
          "info",
        );
      }
      flushPendingResults();
      tryStartNext();
    }

    function handleAgentDelivery(request: AgentRequestPayload): void {
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
        return;
      }
      const request = remoteQueue.startNext();
      if (request === undefined) {
        return;
      }
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
    }

    async function ensureConnected(ctx: ExtensionContext): Promise<boolean> {
      updateContext(ctx);
      if (brokerClient.connected || (await brokerClient.connect())) {
        return true;
      }
      ctx.ui.notify("无法连接 Broker，后台仍会自动重试", "error");
      return false;
    }

    pi.on("session_start", async (_event, ctx) => {
      shuttingDown = false;
      updateContext(ctx);
      resultRetryTimer ??= setInterval(
        flushPendingResults,
        resultRetryIntervalMs,
      );
      if (!(await brokerClient.start(sessionId!))) {
        ctx.ui.notify("Broker 未连接，正在等待 npm run broker 启动", "warning");
      }
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
      availableGroups = [];
      members.clear();
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
    });

    pi.registerCommand("comms-create", {
      description: "创建并加入群组：<群名> <用户名> <Agent名>",
      handler: async (args, ctx) => {
        if (!(await ensureConnected(ctx))) return;
        const values = parseCommandArgs(args, 3);
        if (values === undefined) {
          ctx.ui.notify("用法：/comms-create <群名> <用户名> <Agent名>", "error");
          return;
        }
        brokerClient.send("group.create", {
          groupName: values[0],
          userName: values[1],
          agentName: values[2],
        });
      },
    });

    pi.registerCommand("comms-join", {
      description: "加入群组：<groupId> <用户名> <Agent名>",
      handler: async (args, ctx) => {
        if (!(await ensureConnected(ctx))) return;
        const values = parseCommandArgs(args, 3);
        if (values === undefined) {
          ctx.ui.notify("用法：/comms-join <groupId> <用户名> <Agent名>", "error");
          return;
        }
        brokerClient.send("group.join", {
          groupId: values[0],
          userName: values[1],
          agentName: values[2],
        });
      },
    });

    pi.registerCommand("comms-members", {
      description: "显示群组和在线成员",
      handler: async (_args, ctx) => {
        updateContext(ctx);
        if (currentGroup === undefined) {
          const list = availableGroups.length
            ? availableGroups
                .map(
                  (group) =>
                    `${group.groupName} (${group.groupId}) ${group.onlineSessionCount} 个 Session`,
                )
                .join("\n")
            : "暂无群组";
          ctx.ui.notify(list, "info");
          return;
        }
        const list = [...members.values()]
          .map(
            (member) =>
              `${member.displayName} (${member.type === "user" ? "用户" : "Agent"})`,
          )
          .join("\n");
        ctx.ui.notify(`群组：${currentGroup.groupName}\n${list}`, "info");
      },
    });

    pi.registerCommand("comms-leave", {
      description: "离开当前群组",
      handler: async (_args, ctx) => {
        if (!(await ensureConnected(ctx))) return;
        if (currentGroup === undefined) {
          ctx.ui.notify("当前未加入群组", "warning");
          return;
        }
        clearRemoteWork();
        brokerClient.send("group.leave", {});
      },
    });

    pi.registerCommand("comms-test", {
      description: "通过 Local Broker 发送群聊测试消息",
      handler: async (args, ctx) => {
        if (!(await ensureConnected(ctx))) return;
        if (currentGroup === undefined) {
          ctx.ui.notify("请先创建或加入群组", "error");
          return;
        }
        brokerClient.send("chat.send", {
          text: args.trim() || DEFAULT_TEST_MESSAGE,
        });
      },
    });
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
    `来自：${request.senderName}  群组：${request.groupName}`,
    `在线：${online}`,
    ...(request.round > 1 ? [`这是第 ${request.round} 轮自动对话。`] : []),
    "",
    request.text,
    "",
    `你的回答会作为公开消息发送到群组「${request.groupName}」，用于回应 ${request.senderName}。请直接回答。`,
  ].join("\n");
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
