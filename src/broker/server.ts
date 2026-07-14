import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createConnection,
  createServer,
  type Socket,
} from "node:net";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  parseClientEnvelope,
  type BrokerEnvelope,
  type Envelope,
  type ErrorPayload,
  type AgentResultPayload,
  type SendFailedPayload,
} from "../protocol.js";

export const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "broker.sock",
);

export interface BrokerServerOptions {
  socketPath?: string;
}

export interface BrokerServer {
  readonly socketPath: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createBrokerServer(
  options: BrokerServerOptions = {},
): BrokerServer {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const clients = new Map<string, Socket>();
  const pendingRequests = new Map<string, { targetClientId: string }>();
  const server = createServer(handleConnection);
  let started = false;
  let closing = false;

  function handleConnection(socket: Socket): void {
    const clientId = randomUUID();
    const decoder = new JsonlDecoder();
    clients.set(clientId, socket);

    send(
      socket,
      createEnvelope("snapshot", {
        clientId,
        clients: [...clients.keys()],
      }) as BrokerEnvelope,
    );
    broadcast(
      createEnvelope("presence.changed", {
        clientId,
        online: true,
      }) as BrokerEnvelope,
    );

    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) {
          sendError(socket, {
            code: "invalid_json",
            message: result.error,
          });
          continue;
        }

        handleMessage(clientId, socket, result.value);
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });

    socket.once("close", () => {
      if (clients.get(clientId) !== socket) {
        return;
      }

      clients.delete(clientId);
      if (!closing) {
        broadcast(
          createEnvelope("presence.changed", {
            clientId,
            online: false,
          }) as BrokerEnvelope,
        );
        failRequestsForDisconnectedTarget(clientId);
      }
    });
  }

  function handleMessage(
    senderClientId: string,
    senderSocket: Socket,
    value: unknown,
  ): void {
    const parsed = parseClientEnvelope(value);
    if (!parsed.ok) {
      sendError(senderSocket, {
        code: parsed.code,
        message: parsed.message,
        requestId: parsed.requestId,
      });
      return;
    }

    if (parsed.envelope.type === "agent.result") {
      handleAgentResult(senderClientId, senderSocket, parsed.envelope.payload);
      return;
    }

    const { id, payload } = parsed.envelope;

    if (payload.targetClientId === undefined && payload.text.startsWith("@")) {
      handleAgentRequest(senderClientId, senderSocket, id, payload.text);
      return;
    }

    const message = createEnvelope(
      "chat.message",
      {
        senderClientId,
        text: payload.text,
        ...(payload.targetClientId === undefined
          ? {}
          : { targetClientId: payload.targetClientId }),
      },
      { id },
    ) as BrokerEnvelope;

    if (payload.targetClientId === undefined) {
      broadcast(message);
      return;
    }

    const target = clients.get(payload.targetClientId);
    if (target === undefined || target.destroyed) {
      send(
        senderSocket,
        createEnvelope("send.failed", {
          requestId: id,
          targetClientId: payload.targetClientId,
          reason: "target_offline" as const,
        }) as BrokerEnvelope,
      );
      return;
    }

    send(target, message);
  }

  function handleAgentRequest(
    senderClientId: string,
    senderSocket: Socket,
    requestId: string,
    rawText: string,
  ): void {
    const mention = parseAgentMention(rawText);
    if (mention === undefined) {
      sendError(senderSocket, {
        code: "invalid_payload",
        message: "@Agent 格式应为：@完整clientId 消息正文",
        requestId,
      });
      return;
    }

    const publicMessage = createEnvelope(
      "chat.message",
      {
        senderClientId,
        targetClientId: mention.targetClientId,
        text: rawText,
        requestId,
      },
      { id: requestId },
    ) as BrokerEnvelope;
    broadcast(publicMessage);

    const target = clients.get(mention.targetClientId);
    if (target === undefined || target.destroyed) {
      broadcastFailure({
        requestId,
        targetClientId: mention.targetClientId,
        reason: "target_offline",
      });
      return;
    }

    pendingRequests.set(requestId, {
      targetClientId: mention.targetClientId,
    });
    send(
      target,
      createEnvelope("agent.deliver", {
        requestId,
        groupId: "default",
        senderId: senderClientId,
        senderName: `Client-${senderClientId.slice(0, 8)}`,
        targetAgentId: mention.targetClientId,
        text: mention.text,
        chainId: requestId,
        round: 1,
      }) as BrokerEnvelope,
    );
  }

  function handleAgentResult(
    senderClientId: string,
    senderSocket: Socket,
    result: AgentResultPayload,
  ): void {
    const pending = pendingRequests.get(result.requestId);
    if (pending === undefined || pending.targetClientId !== senderClientId) {
      sendError(senderSocket, {
        code: "invalid_payload",
        message: "agent.result 没有对应的待处理请求",
        requestId: result.requestId,
      });
      return;
    }

    pendingRequests.delete(result.requestId);
    if (!result.ok) {
      broadcastFailure({
        requestId: result.requestId,
        targetClientId: senderClientId,
        reason: result.reason,
      });
      return;
    }

    broadcast(
      createEnvelope("chat.message", {
        senderClientId,
        text: result.text,
        requestId: result.requestId,
        kind: "agent" as const,
      }) as BrokerEnvelope,
    );
  }

  function failRequestsForDisconnectedTarget(targetClientId: string): void {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.targetClientId !== targetClientId) {
        continue;
      }
      pendingRequests.delete(requestId);
      broadcastFailure({
        requestId,
        targetClientId,
        reason: "target_disconnected",
      });
    }
  }

  function broadcastFailure(payload: SendFailedPayload): void {
    broadcast(createEnvelope("send.failed", payload) as BrokerEnvelope);
  }

  function sendError(socket: Socket, payload: ErrorPayload): void {
    send(socket, createEnvelope("error", payload) as BrokerEnvelope);
  }

  function broadcast(envelope: BrokerEnvelope): void {
    for (const socket of clients.values()) {
      send(socket, envelope);
    }
  }

  async function start(): Promise<void> {
    if (started) {
      return;
    }

    await mkdir(dirname(socketPath), { recursive: true });
    if (await canConnect(socketPath)) {
      throw new Error(`Broker 已经在运行：${socketPath}`);
    }
    await removeSocketIfPresent(socketPath);

    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveStart();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });

    started = true;
    closing = false;
  }

  async function close(): Promise<void> {
    if (!started) {
      return;
    }

    closing = true;
    for (const socket of clients.values()) {
      socket.destroy();
    }
    clients.clear();

    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      });
    });

    started = false;
  }

  return { socketPath, start, close };
}

function parseAgentMention(
  text: string,
): { targetClientId: string; text: string } | undefined {
  const match = text.match(
    /^@([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s+([\s\S]*\S)$/i,
  );
  if (match === null) {
    return undefined;
  }
  return { targetClientId: match[1], text: match[2] };
}

function send(socket: Socket, envelope: Envelope): void {
  if (!socket.destroyed) {
    socket.write(encodeEnvelope(envelope));
  }
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolveConnection, rejectConnection) => {
    const socket = createConnection(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        resolveConnection(false);
      } else {
        rejectConnection(error);
      }
    });
  });
}

async function removeSocketIfPresent(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function runBroker(): Promise<void> {
  const broker = createBrokerServer();
  await broker.start();
  console.log(`Pi Comms Broker 正在监听 ${broker.socketPath}`);

  const shutdown = async () => {
    await broker.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  void runBroker().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
