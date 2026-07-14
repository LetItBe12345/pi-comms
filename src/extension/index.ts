import { createConnection, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SOCKET_PATH } from "../broker/server.js";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type AgentFailureReason,
  type AgentRequestPayload,
  type AgentResultPayload,
} from "../protocol.js";

const STATUS_KEY = "pi-comms";
const DEFAULT_TEST_MESSAGE = "来自 Pi Session 的测试消息";

export interface CommsExtensionOptions {
  socketPath?: string;
}

export function createCommsExtension(
  options: CommsExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;

  return (pi: ExtensionAPI) => {
    let socket: Socket | undefined;
    let connectTask: Promise<boolean> | undefined;
    let context: ExtensionContext | undefined;
    let ui: ExtensionUIContext | undefined;
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let knownClients = new Set<string>();
    let activeRequest: AgentRequestPayload | undefined;
    let lastAssistantText: string | undefined;
    let shuttingDown = false;

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

    function resetConnection(connection: Socket): void {
      if (socket !== connection) {
        return;
      }
      socket = undefined;
      clientId = undefined;
      knownClients = new Set();
      setConnected(false);
    }

    function openConnection(): Promise<boolean> {
      setConnected(false);

      return new Promise<boolean>((resolveConnection) => {
        const connection = createConnection(socketPath);
        const decoder = new JsonlDecoder();
        let settled = false;
        socket = connection;

        const settle = (connected: boolean) => {
          if (!settled) {
            settled = true;
            resolveConnection(connected);
          }
        };

        connection.on("data", (chunk) => {
          for (const result of decoder.push(chunk)) {
            if (!result.ok) {
              ui?.notify(result.error, "error");
              continue;
            }

            const connected = handleBrokerMessage(result.value);
            if (connected) {
              settle(true);
            }
          }
        });

        connection.on("error", () => {
          settle(false);
        });

        connection.once("close", () => {
          const wasConnected = clientId !== undefined;
          resetConnection(connection);
          settle(false);

          if (!shuttingDown && wasConnected) {
            ui?.notify("Broker 连接已断开", "warning");
          }
        });
      });
    }

    async function ensureConnected(ctx: ExtensionContext): Promise<boolean> {
      updateContext(ctx);

      if (socket !== undefined && !socket.destroyed && clientId !== undefined) {
        return true;
      }
      if (connectTask !== undefined) {
        return connectTask;
      }

      connectTask = openConnection();
      try {
        return await connectTask;
      } finally {
        connectTask = undefined;
      }
    }

    function handleBrokerMessage(value: unknown): boolean {
      if (!isRecord(value) || typeof value.type !== "string") {
        ui?.notify("收到无效的 Broker 消息", "error");
        return false;
      }

      const payload = value.payload;
      if (!isRecord(payload)) {
        ui?.notify("收到无效的 Broker payload", "error");
        return false;
      }

      switch (value.type) {
        case "snapshot": {
          if (
            typeof payload.clientId !== "string" ||
            !Array.isArray(payload.clients) ||
            !payload.clients.every((item) => typeof item === "string")
          ) {
            ui?.notify("收到无效的 Broker snapshot", "error");
            return false;
          }

          clientId = payload.clientId;
          knownClients = new Set(payload.clients);
          setConnected(true);
          ui?.notify(
            `Broker 已连接\nSession: ${sessionId}\nClient: ${clientId}`,
            "info",
          );
          return true;
        }

        case "presence.changed": {
          if (
            typeof payload.clientId === "string" &&
            typeof payload.online === "boolean"
          ) {
            if (payload.online) {
              knownClients.add(payload.clientId);
            } else {
              knownClients.delete(payload.clientId);
            }
          }
          return false;
        }

        case "chat.message": {
          if (
            typeof payload.senderClientId === "string" &&
            typeof payload.text === "string"
          ) {
            ui?.notify(
              `[${payload.senderClientId.slice(0, 8)}] ${payload.text}`,
              "info",
            );
          }
          return false;
        }

        case "agent.deliver": {
          if (!isAgentRequest(payload)) {
            ui?.notify("收到无效的 Agent 请求", "error");
            return false;
          }
          handleAgentDelivery(payload);
          return false;
        }

        case "send.failed": {
          const reason =
            typeof payload.reason === "string" ? payload.reason : "unknown";
          ui?.notify(`请求失败：${failureMessage(reason)}`, "error");
          return false;
        }

        case "error":
          ui?.notify(
            `Broker 错误：${typeof payload.message === "string" ? payload.message : "未知错误"}`,
            "error",
          );
          return false;

        default:
          return false;
      }
    }

    function handleAgentDelivery(request: AgentRequestPayload): void {
      if (activeRequest !== undefined || context?.isIdle() !== true) {
        sendAgentFailure(request.requestId, "agent_busy");
        return;
      }

      activeRequest = request;
      lastAssistantText = undefined;
      try {
        pi.sendUserMessage(formatAgentRequest(request));
      } catch {
        activeRequest = undefined;
        sendAgentFailure(request.requestId, "delivery_failed");
      }
    }

    function sendAgentFailure(
      requestId: string,
      reason: AgentFailureReason,
    ): void {
      sendAgentResult({ requestId, ok: false, reason });
    }

    function sendAgentResult(result: AgentResultPayload): boolean {
      if (socket === undefined || socket.destroyed || clientId === undefined) {
        ui?.notify("Agent 回答回传失败：Broker 未连接", "error");
        return false;
      }
      socket.write(encodeEnvelope(createEnvelope("agent.result", result)));
      return true;
    }

    async function disconnect(): Promise<void> {
      const connection = socket;
      if (connection === undefined || connection.destroyed) {
        socket = undefined;
        clientId = undefined;
        knownClients.clear();
        return;
      }

      await new Promise<void>((resolveClose) => {
        connection.once("close", resolveClose);
        connection.end();
      });
    }

    pi.on("session_start", async (_event, ctx) => {
      shuttingDown = false;
      if (!(await ensureConnected(ctx))) {
        ctx.ui.notify(
          "Broker 未连接，请先运行 npm run broker；之后可执行 /comms-test 重试",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      updateContext(ctx);
      activeRequest = undefined;
      lastAssistantText = undefined;
      await disconnect();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("input", (event, ctx) => {
      updateContext(ctx);
      if (activeRequest !== undefined && event.source !== "extension") {
        ctx.ui.notify("正在处理远程请求，请稍后", "warning");
        return { action: "handled" as const };
      }
      return { action: "continue" as const };
    });

    pi.on("message_end", (event, ctx) => {
      updateContext(ctx);
      if (activeRequest === undefined || event.message.role !== "assistant") {
        return;
      }
      lastAssistantText = extractAssistantText(event.message.content);
    });

    pi.on("agent_settled", (_event, ctx) => {
      updateContext(ctx);
      if (activeRequest === undefined) {
        return;
      }

      const requestId = activeRequest.requestId;
      const answer = lastAssistantText;
      activeRequest = undefined;
      lastAssistantText = undefined;

      if (answer === undefined) {
        sendAgentFailure(requestId, "no_text");
      } else {
        sendAgentResult({ requestId, ok: true, text: answer });
      }
    });

    pi.registerCommand("comms-test", {
      description: "通过 Local Broker 广播测试消息",
      handler: async (args, ctx) => {
        if (!(await ensureConnected(ctx))) {
          ctx.ui.notify(
            "无法连接 Broker，请确认 npm run broker 正在运行",
            "error",
          );
          return;
        }

        const text = args.trim() || DEFAULT_TEST_MESSAGE;
        socket?.write(
          encodeEnvelope(createEnvelope("chat.send", { text })),
        );
      },
    });
  };
}

function isAgentRequest(payload: unknown): payload is AgentRequestPayload {
  if (!isRecord(payload)) {
    return false;
  }
  return (
    typeof payload.requestId === "string" &&
    typeof payload.groupId === "string" &&
    typeof payload.senderId === "string" &&
    typeof payload.senderName === "string" &&
    typeof payload.targetAgentId === "string" &&
    typeof payload.text === "string" &&
    typeof payload.chainId === "string" &&
    typeof payload.round === "number"
  );
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
