import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  parseClientEnvelope,
  type AgentRequestPayload,
  type AgentResultPayload,
  type BrokerEnvelope,
  type ClientHelloEnvelope,
  type Envelope,
  type ErrorPayload,
  type SendFailedPayload,
} from "../protocol.js";

export const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "broker.sock",
);

const DEFAULT_DISCONNECT_GRACE_MS = 3_000;

export interface BrokerServerOptions {
  socketPath?: string;
  disconnectGraceMs?: number;
}

export interface BrokerServer {
  readonly socketPath: string;
  readonly instanceId: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface ClientSession {
  clientId: string;
  socket?: Socket;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
  targetClientId: string;
  request: AgentRequestPayload;
  deliveryAcknowledged: boolean;
}

export function createBrokerServer(
  options: BrokerServerOptions = {},
): BrokerServer {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const disconnectGraceMs =
    options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  const instanceId = randomUUID();
  const clients = new Map<string, Socket>();
  const sessions = new Map<string, ClientSession>();
  const pendingRequests = new Map<string, PendingRequest>();
  const completedRequests = new Map<string, string>();
  const closedRequestIds = new Set<string>();
  const server = createServer(handleConnection);
  let started = false;
  let closing = false;

  function handleConnection(socket: Socket): void {
    const decoder = new JsonlDecoder();
    let sessionId: string | undefined;
    let clientId: string | undefined;

    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) {
          sendError(socket, {
            code: "invalid_json",
            message: result.error,
          });
          continue;
        }

        const parsed = parseClientEnvelope(result.value);
        if (!parsed.ok) {
          sendError(socket, {
            code: parsed.code,
            message: parsed.message,
            requestId: parsed.requestId,
          });
          continue;
        }

        if (parsed.envelope.type === "client.hello") {
          if (clientId !== undefined) {
            sendError(socket, {
              code: "invalid_payload",
              message: "连接已经完成 client.hello",
              requestId: parsed.envelope.id,
            });
            continue;
          }
          const identity = registerClient(socket, parsed.envelope);
          sessionId = identity.sessionId;
          clientId = identity.clientId;
          continue;
        }

        if (clientId === undefined || sessionId === undefined) {
          sendError(socket, {
            code: "invalid_payload",
            message: "发送消息前必须先发送 client.hello",
            requestId: parsed.envelope.id,
          });
          continue;
        }

        if (parsed.envelope.type === "client.goodbye") {
          if (parsed.envelope.payload.sessionId !== sessionId) {
            sendError(socket, {
              code: "invalid_payload",
              message: "client.goodbye sessionId 不匹配",
              requestId: parsed.envelope.id,
            });
            continue;
          }
          removeClientSession(sessionId, clientId, socket);
          socket.end();
          continue;
        }

        handleClientMessage(clientId, socket, parsed.envelope);
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });

    socket.once("close", () => {
      if (clientId === undefined || sessionId === undefined) {
        return;
      }
      handleUnexpectedDisconnect(sessionId, clientId, socket);
    });
  }

  function registerClient(
    socket: Socket,
    hello: ClientHelloEnvelope,
  ): { sessionId: string; clientId: string } {
    const sessionId = hello.payload.sessionId;
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = { clientId: randomUUID() };
      sessions.set(sessionId, session);
    }

    if (session.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
    if (session.socket !== undefined && session.socket !== socket) {
      session.socket.destroy();
    }

    const clientId = session.clientId;
    session.socket = socket;
    clients.set(clientId, socket);

    send(
      socket,
      createEnvelope("snapshot", {
        brokerInstanceId: instanceId,
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
    resendUnacknowledgedDeliveries(clientId, socket);
    return { sessionId, clientId };
  }

  function handleUnexpectedDisconnect(
    sessionId: string,
    clientId: string,
    socket: Socket,
  ): void {
    if (clients.get(clientId) !== socket) {
      return;
    }

    clients.delete(clientId);
    const session = sessions.get(sessionId);
    if (session !== undefined && session.socket === socket) {
      session.socket = undefined;
    }
    if (closing) {
      return;
    }

    broadcast(
      createEnvelope("presence.changed", {
        clientId,
        online: false,
      }) as BrokerEnvelope,
    );
    if (session !== undefined) {
      session.disconnectTimer = setTimeout(() => {
        session.disconnectTimer = undefined;
        if (!clients.has(clientId)) {
          failRequestsForDisconnectedTarget(clientId);
        }
      }, disconnectGraceMs);
    }
  }

  function removeClientSession(
    sessionId: string,
    clientId: string,
    socket: Socket,
  ): void {
    const session = sessions.get(sessionId);
    if (session?.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
    }
    sessions.delete(sessionId);
    if (clients.get(clientId) === socket) {
      clients.delete(clientId);
      broadcast(
        createEnvelope("presence.changed", {
          clientId,
          online: false,
        }) as BrokerEnvelope,
      );
      failRequestsForDisconnectedTarget(clientId);
    }
  }

  function handleClientMessage(
    senderClientId: string,
    senderSocket: Socket,
    envelope: Exclude<
      ReturnType<typeof parseClientEnvelope>,
      { ok: false }
    >["envelope"],
  ): void {
    if (envelope.type === "agent.deliver.ack") {
      const pending = pendingRequests.get(envelope.payload.requestId);
      if (pending?.targetClientId === senderClientId) {
        pending.deliveryAcknowledged = true;
      }
      return;
    }

    if (envelope.type === "agent.result") {
      handleAgentResult(senderClientId, senderSocket, envelope.payload);
      return;
    }

    if (envelope.type !== "chat.send") {
      return;
    }

    const { id, payload } = envelope;
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
    const existing = pendingRequests.get(requestId);
    if (existing !== undefined) {
      const target = clients.get(existing.targetClientId);
      if (
        !existing.deliveryAcknowledged &&
        target !== undefined &&
        !target.destroyed
      ) {
        sendAgentDelivery(target, existing.request);
      }
      return;
    }
    if (completedRequests.has(requestId) || closedRequestIds.has(requestId)) {
      return;
    }

    const mention = parseAgentMention(rawText);
    if (mention === undefined) {
      sendError(senderSocket, {
        code: "invalid_payload",
        message: "@Agent 格式应为：@完整clientId 消息正文",
        requestId,
      });
      return;
    }

    broadcast(
      createEnvelope(
        "chat.message",
        {
          senderClientId,
          targetClientId: mention.targetClientId,
          text: rawText,
          requestId,
        },
        { id: requestId },
      ) as BrokerEnvelope,
    );

    const target = clients.get(mention.targetClientId);
    if (target === undefined || target.destroyed) {
      closedRequestIds.add(requestId);
      broadcastFailure({
        requestId,
        targetClientId: mention.targetClientId,
        reason: "target_offline",
      });
      return;
    }

    const request: AgentRequestPayload = {
      requestId,
      groupId: "default",
      senderId: senderClientId,
      senderName: `Client-${senderClientId.slice(0, 8)}`,
      targetAgentId: mention.targetClientId,
      text: mention.text,
      chainId: requestId,
      round: 1,
    };
    pendingRequests.set(requestId, {
      targetClientId: mention.targetClientId,
      request,
      deliveryAcknowledged: false,
    });
    sendAgentDelivery(target, request);
  }

  function sendAgentDelivery(socket: Socket, request: AgentRequestPayload): void {
    send(socket, createEnvelope("agent.deliver", request) as BrokerEnvelope);
  }

  function resendUnacknowledgedDeliveries(
    targetClientId: string,
    socket: Socket,
  ): void {
    for (const pending of pendingRequests.values()) {
      if (
        pending.targetClientId === targetClientId &&
        !pending.deliveryAcknowledged
      ) {
        sendAgentDelivery(socket, pending.request);
      }
    }
  }

  function handleAgentResult(
    senderClientId: string,
    senderSocket: Socket,
    result: AgentResultPayload,
  ): void {
    if (completedRequests.get(result.requestId) === senderClientId) {
      sendResultAck(senderSocket, result.requestId, true);
      return;
    }

    const pending = pendingRequests.get(result.requestId);
    if (pending === undefined || pending.targetClientId !== senderClientId) {
      sendResultAck(senderSocket, result.requestId, false);
      return;
    }

    pendingRequests.delete(result.requestId);
    completedRequests.set(result.requestId, senderClientId);
    if (result.ok) {
      broadcast(
        createEnvelope("chat.message", {
          senderClientId,
          text: result.text,
          requestId: result.requestId,
          kind: "agent" as const,
        }) as BrokerEnvelope,
      );
    } else {
      broadcastFailure({
        requestId: result.requestId,
        targetClientId: senderClientId,
        reason: result.reason,
      });
    }
    sendResultAck(senderSocket, result.requestId, true);
  }

  function sendResultAck(
    socket: Socket,
    requestId: string,
    accepted: boolean,
  ): void {
    send(
      socket,
      createEnvelope("agent.result.ack", {
        requestId,
        accepted,
        ...(accepted ? {} : { reason: "unknown_request" as const }),
      }) as BrokerEnvelope,
    );
  }

  function failRequestsForDisconnectedTarget(targetClientId: string): void {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.targetClientId !== targetClientId) {
        continue;
      }
      pendingRequests.delete(requestId);
      closedRequestIds.add(requestId);
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
    for (const session of sessions.values()) {
      if (session.disconnectTimer !== undefined) {
        clearTimeout(session.disconnectTimer);
      }
      session.socket?.destroy();
    }
    clients.clear();
    sessions.clear();
    pendingRequests.clear();

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

  return { socketPath, instanceId, start, close };
}

function parseAgentMention(
  text: string,
): { targetClientId: string; text: string } | undefined {
  const match = text.match(
    /^@([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s+([\s\S]*\S)$/i,
  );
  return match === null
    ? undefined
    : { targetClientId: match[1], text: match[2] };
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
