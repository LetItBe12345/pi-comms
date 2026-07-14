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
    let ui: ExtensionUIContext | undefined;
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let knownClients = new Set<string>();
    let shuttingDown = false;

    function updateContext(ctx: ExtensionContext): void {
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

        case "send.failed":
          ui?.notify("测试消息发送失败：目标不在线", "error");
          return false;

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
      await disconnect();
      ctx.ui.setStatus(STATUS_KEY, undefined);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default createCommsExtension();
