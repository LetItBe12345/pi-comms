import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SOCKET_PATH } from "../broker/server.js";
import type {
  AgentFailureReason,
  AgentRequestPayload,
  AgentResultAckPayload,
  AgentResultPayload,
  BrokerEnvelope,
  SnapshotPayload,
} from "../protocol.js";
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
    let knownClients = new Set<string>();
    let lastAssistantText: string | undefined;
    let resultRetryTimer: ReturnType<typeof setInterval> | undefined;
    let shuttingDown = false;

    const brokerClient = new BrokerClient({
      socketPath,
      reconnectIntervalMs: options.reconnectIntervalMs,
      onMessage: handleBrokerMessage,
      onDisconnected: (wasConnected) => {
        clientId = undefined;
        knownClients.clear();
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
        case "presence.changed":
          if (message.payload.online) {
            knownClients.add(message.payload.clientId);
          } else {
            knownClients.delete(message.payload.clientId);
          }
          return;
        case "chat.message":
          ui?.notify(
            `[${message.payload.senderClientId.slice(0, 8)}] ${message.payload.text}`,
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
      if (
        brokerInstanceId !== undefined &&
        brokerInstanceId !== snapshot.brokerInstanceId
      ) {
        if (remoteQueue.activeRequest !== undefined) {
          context?.abort();
        }
        remoteQueue.clear();
        lastAssistantText = undefined;
        ui?.notify("Broker 已重启，旧远程请求已清理", "warning");
      }

      brokerInstanceId = snapshot.brokerInstanceId;
      clientId = snapshot.clientId;
      knownClients = new Set(snapshot.clients);
      setConnected(true);
      ui?.notify(
        `Broker 已连接\nSession: ${sessionId}\nClient: ${clientId}`,
        "info",
      );
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

    pi.on("session_start", async (_event, ctx) => {
      shuttingDown = false;
      updateContext(ctx);
      resultRetryTimer ??= setInterval(
        flushPendingResults,
        resultRetryIntervalMs,
      );
      if (!(await brokerClient.start(sessionId!))) {
        ctx.ui.notify(
          "Broker 未连接，正在等待 npm run broker 启动",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      updateContext(ctx);
      if (resultRetryTimer !== undefined) {
        clearInterval(resultRetryTimer);
        resultRetryTimer = undefined;
      }
      remoteQueue.clear();
      lastAssistantText = undefined;
      await brokerClient.stop();
      clientId = undefined;
      knownClients.clear();
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
        remoteQueue.activeRequest === undefined ||
        event.message.role !== "assistant"
      ) {
        return;
      }
      lastAssistantText = extractAssistantText(event.message.content);
    });

    pi.on("agent_settled", (_event, ctx) => {
      updateContext(ctx);
      const activeRequest = remoteQueue.activeRequest;
      if (activeRequest === undefined) {
        tryStartNext();
        return;
      }

      const result: AgentResultPayload =
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
            };
      completeActive(result);
    });

    pi.registerCommand("comms-test", {
      description: "通过 Local Broker 广播测试消息",
      handler: async (args, ctx) => {
        updateContext(ctx);
        if (!brokerClient.connected && !(await brokerClient.connect())) {
          ctx.ui.notify(
            "无法连接 Broker，后台仍会自动重试",
            "error",
          );
          return;
        }
        brokerClient.send("chat.send", {
          text: args.trim() || DEFAULT_TEST_MESSAGE,
        });
      },
    });
  };
}

function formatAgentRequest(request: AgentRequestPayload): string {
  return [
    "[Pi Comms 远程请求]",
    `发送者：${request.senderName}`,
    `群组：${request.groupId}`,
    `目标：@${request.targetAgentId}`,
    `消息：${request.text}`,
    "",
    "请直接回答该消息。",
  ].join("\n");
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
    case "target_offline":
      return "目标 Agent 不在线";
    case "target_disconnected":
      return "目标 Agent 已断线";
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
