import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadOrCreateDeviceId } from "../device-identity.js";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  PI_COMMS_BUILD_CHANNEL,
  PI_COMMS_VERSION,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  parseClientEnvelope,
  type AgentRequestPayload,
  type AgentResultPayload,
  type BrokerEnvelope,
  type ChatMessagePayload,
  type ClientEnvelope,
  type ClientHelloEnvelope,
  type Envelope,
  type ErrorPayload,
  type GroupCreatePayload,
  type GroupJoinPayload,
  type HistoryMessage,
  type PausedChainPayload,
  type ProactiveResultPayload,
  type SendFailedPayload,
} from "../protocol.js";
import { createSessionKey, type SessionKey } from "../session-key.js";
import {
  publishBrokerMdns,
  type MdnsPublisher,
} from "../discovery/mdns.js";
import { primaryOrdinaryNetwork } from "../discovery/network.js";
import { NetworkAccessStore } from "../discovery/network-access.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  formatEndpoint,
  validateListenEndpoint,
  type TcpListenEndpoint,
} from "../transport/tcp-endpoint.js";
import type { AgentPermission, Member } from "../types.js";
import {
  BrokerDatabase,
  historyMessage,
  type AgentChainContext,
  type StoredPausedChain,
} from "./database.js";
import { GroupState, GroupStateError } from "./group-state.js";
import { generateInviteCode, normalizeInviteCode } from "./invite-code.js";
import { assertNoLiveLegacyBroker } from "./legacy-migration.js";
import { acquireBrokerProcessLock, type BrokerProcessLock } from "./process-lock.js";
import { configureBrokerAutostart } from "./autostart.js";
import {
  removeBrokerRuntimeMetadata,
  writeBrokerRuntimeMetadata,
  type BrokerMode,
} from "./runtime-metadata.js";
import {
  DEFAULT_PROACTIVE_CONFIG_PATH,
  normalizeAgentDescription,
  ProactiveConfigStore,
} from "./proactive-config.js";
import {
  DeepSeekProactiveProvider,
  ProactiveProviderError,
  type ProactiveProvider,
  withProactiveRetry,
} from "./proactive-provider.js";
import {
  ProactiveCoordinator,
  type PendingProactive,
} from "./proactive-coordinator.js";
import { ProactiveCallScheduler } from "./proactive-scheduler.js";
import { GroupContextSummary } from "./group-context-summary.js";
import { participantContext } from "../participant-context.js";

export const DEFAULT_DATABASE_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "comms.db",
);

export const DEFAULT_LOCAL_DISCONNECT_GRACE_MS = 3_000;
export const DEFAULT_LAN_DISCONNECT_GRACE_MS = 15_000;
export const DEFAULT_HELLO_TIMEOUT_MS = 3_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
export const DEFAULT_INVITE_FAILURE_WINDOW_MS = 60_000;
export const DEFAULT_INVITE_FAILURE_LIMIT = 5;
export const DEFAULT_INVITE_COOLDOWN_MS = 30_000;
export const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;

export interface BrokerServerOptions {
  listen?: TcpListenEndpoint;
  dbPath?: string;
  disconnectGraceMs?: number;
  localDisconnectGraceMs?: number;
  lanDisconnectGraceMs?: number;
  helloTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxFrameBytes?: number;
  deviceId?: string;
  mode?: BrokerMode;
  inviteFailureWindowMs?: number;
  inviteFailureLimit?: number;
  inviteCooldownMs?: number;
  isLoopback?: (address: string | undefined) => boolean;
  idleShutdownMs?: number;
  mdnsPublisherFactory?: typeof publishBrokerMdns;
  networkAccessRequired?: boolean;
  configureAutostart?: typeof configureBrokerAutostart;
  proactiveConfigPath?: string;
  proactiveProvider?: ProactiveProvider;
  proactiveLog?(event: string, fields?: Record<string, unknown>): void;
  proactiveTimings?: {
    debounceMs?: number;
    maxWaitMs?: number;
    groupIntervalMs?: number;
    deliveryTtlMs?: number;
    cooldownMs?: number;
    pauseMs?: number;
  };
}

export interface BrokerServer {
  readonly endpoint: TcpListenEndpoint;
  readonly dbPath: string;
  readonly instanceId: string;
  readonly brokerId: string;
  readonly mode: BrokerMode;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface ClientSession {
  clientId: string;
  resumeToken: string;
  socket?: Socket;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
  targetClientId: string;
  targetAgentId: string;
  targetName: string;
  groupId: string;
  request: AgentRequestPayload;
  message: HistoryMessage;
  state: "awaiting_approval" | "delivering";
  deliveryAcknowledged: boolean;
  context: AgentChainContext;
}

interface InviteFailureState {
  failures: number;
  windowStartedAt: number;
  cooldownUntil: number;
}

export function createBrokerServer(
  options: BrokerServerOptions = {},
): BrokerServer {
  const listen = validateListenEndpoint(options.listen ?? DEFAULT_BROKER_ENDPOINT);
  let endpoint = listen;
  const dbPath = options.dbPath ?? DEFAULT_DATABASE_PATH;
  const proactiveConfigPath = options.proactiveConfigPath ??
    (dbPath === DEFAULT_DATABASE_PATH
      ? DEFAULT_PROACTIVE_CONFIG_PATH
      : join(dirname(dbPath), "config.json"));
  const proactiveConfig = new ProactiveConfigStore(proactiveConfigPath);
  const proactiveProvider = options.proactiveProvider ?? new DeepSeekProactiveProvider();
  const proactiveScheduler = new ProactiveCallScheduler();
  const proactiveLog = options.proactiveLog ?? (
    options.proactiveProvider === undefined
      ? (event: string, fields?: Record<string, unknown>) => console.error(JSON.stringify({
          component: "pi-comms-proactive",
          event,
          ...fields,
        }))
      : undefined
  );
  const groupContext = new GroupContextSummary({
    database: () => db(),
    provider: proactiveProvider,
    scheduler: proactiveScheduler,
    log: proactiveLog,
  });
  const localDisconnectGraceMs = options.disconnectGraceMs ??
    options.localDisconnectGraceMs ?? DEFAULT_LOCAL_DISCONNECT_GRACE_MS;
  const lanDisconnectGraceMs = options.disconnectGraceMs ??
    options.lanDisconnectGraceMs ?? DEFAULT_LAN_DISCONNECT_GRACE_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes;
  const deviceId = options.deviceId ?? loadOrCreateDeviceId();
  const instanceId = randomUUID();
  const mode = options.mode ?? (listen.host === "127.0.0.1" ? "local" : "lan-host");
  const inviteFailureWindowMs =
    options.inviteFailureWindowMs ?? DEFAULT_INVITE_FAILURE_WINDOW_MS;
  const inviteFailureLimit = options.inviteFailureLimit ?? DEFAULT_INVITE_FAILURE_LIMIT;
  const inviteCooldownMs = options.inviteCooldownMs ?? DEFAULT_INVITE_COOLDOWN_MS;
  const isLoopback = options.isLoopback ?? isLoopbackAddress;
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const mdnsPublisherFactory =
    options.mdnsPublisherFactory ?? publishBrokerMdns;
  const publishMdns =
    options.mdnsPublisherFactory !== undefined ||
    process.env.PI_COMMS_DISABLE_MDNS !== "1";
  const networkAccessStore = new NetworkAccessStore(dbPath);
  const networkAccessRequired = options.networkAccessRequired ?? true;
  const updateAutostart =
    options.configureAutostart ?? configureBrokerAutostart;
  const clients = new Map<string, Socket>();
  const sessions = new Map<SessionKey, ClientSession>();
  let groups = new GroupState();
  let database: BrokerDatabase | undefined;
  let proactive: ProactiveCoordinator | undefined;
  const pendingRequests = new Map<string, PendingRequest>();
  const permissions = new Map<string, AgentPermission>();
  const resolvedApprovalRequests = new Map<string, string>();
  const completedRequests = new Map<string, string>();
  const closedRequestIds = new Set<string>();
  const inviteFailures = new Map<string, InviteFailureState>();
  const proactiveCursors = new Map<string, number>();
  const server = createServer(handleConnection);
  let started = false;
  let closing = false;
  let processLock: BrokerProcessLock | undefined;
  let stableBrokerId = "";
  let mdnsPublisher: MdnsPublisher | undefined;
  let networkAccessAllowed = mode !== "lan-host";
  let networkAccessAddress: string | undefined;
  let observedNetworkKey: string | undefined;
  let networkRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function handleConnection(socket: Socket): void {
    const decoder = new JsonlDecoder(maxFrameBytes);
    let sessionKey: SessionKey | undefined;
    let clientId: string | undefined;
    let acceptedProbe = false;
    let helloTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      sendError(socket, { code: "hello_timeout", message: "client.hello 握手超时" });
      socket.end();
    }, helloTimeoutMs);

    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) {
          sendError(socket, { code: result.code, message: result.error });
          if (result.code === "frame_too_large") {
            socket.end();
            return;
          }
          continue;
        }
        const parsed = parseClientEnvelope(result.value);
        if (!parsed.ok) {
          sendError(socket, {
            code: parsed.code,
            message: parsed.message,
            requestId: parsed.requestId,
          });
          if (parsed.code === "protocol_mismatch") socket.end();
          continue;
        }

        if (parsed.envelope.type === "broker.probe") {
          if (
            parsed.envelope.payload.service !== BROKER_SERVICE ||
            parsed.envelope.payload.protocolVersion !== BROKER_PROTOCOL_VERSION
          ) {
            sendError(socket, {
              code: "protocol_mismatch",
              message: "Pi Comms 协议版本不兼容",
              requestId: parsed.envelope.id,
            });
            socket.end();
            return;
          }
          if (
            !isLoopback(socket.remoteAddress) &&
            mode === "lan-host" &&
            (
              !networkAccessAllowed ||
              (
                networkAccessRequired &&
                !isAddressOnOrdinaryNetwork(
                  socket.remoteAddress,
                  networkAccessAddress,
                )
              )
            )
          ) {
            sendError(socket, {
              code: "network_unavailable",
              message: "当前网络尚未允许附近设备连接",
              requestId: parsed.envelope.id,
            });
            socket.end();
            return;
          }
          acceptedProbe = true;
          send(socket, createEnvelope("broker.ready", {
            service: BROKER_SERVICE,
            protocolVersion: BROKER_PROTOCOL_VERSION,
            brokerId: stableBrokerId,
            brokerInstanceId: instanceId,
            brokerMode: mode,
            appVersion: PI_COMMS_VERSION,
            buildChannel: PI_COMMS_BUILD_CHANNEL,
            requestId: parsed.envelope.id,
          }) as BrokerEnvelope);
          continue;
        }

        if (parsed.envelope.type === "broker.shutdown") {
          if (!acceptedProbe || !isLoopback(socket.remoteAddress)) {
            sendError(socket, {
              code: "invalid_payload",
              message: "只能从本机停止协作空间",
              requestId: parsed.envelope.id,
            });
            socket.end();
            return;
          }
          send(socket, createEnvelope("broker.stopping", {
            requestId: parsed.envelope.id,
          }) as BrokerEnvelope);
          socket.end();
          setImmediate(() => void close());
          return;
        }

        if (parsed.envelope.type === "group.catalog") {
          if (!acceptedProbe || parsed.envelope.payload.brokerId !== stableBrokerId) {
            sendError(socket, {
              code: "broker_changed",
              message: "附近设备信息已变化，请刷新后重试",
              requestId: parsed.envelope.id,
            });
            socket.end();
            return;
          }
          send(socket, createEnvelope("group.catalog.result", {
            groups: nearbyGroupSummaries(),
          }) as BrokerEnvelope);
          socket.end();
          return;
        }

        if (parsed.envelope.type === "client.hello") {
          if (!acceptedProbe) {
            sendError(socket, {
              code: "invalid_payload",
              message: "client.hello 前必须完成兼容的 broker.probe",
              requestId: parsed.envelope.id,
            });
            continue;
          }
          if (clientId !== undefined) {
            sendError(socket, {
              code: "invalid_payload",
              message: "连接已经完成 client.hello",
              requestId: parsed.envelope.id,
            });
            continue;
          }
          const identity = registerClient(socket, parsed.envelope);
          if (identity === undefined) return;
          if (helloTimer !== undefined) {
            clearTimeout(helloTimer);
            helloTimer = undefined;
          }
          sessionKey = identity.sessionKey;
          clientId = identity.clientId;
          continue;
        }

        if (clientId === undefined || sessionKey === undefined) {
          sendError(socket, {
            code: "invalid_payload",
            message: "发送消息前必须先发送 client.hello",
            requestId: parsed.envelope.id,
          });
          continue;
        }

        if (parsed.envelope.type === "ping") {
          const session = sessions.get(sessionKey);
          if (session?.socket === socket) armHeartbeat(sessionKey, session, socket);
          send(socket, createEnvelope("pong", { requestId: parsed.envelope.id }) as BrokerEnvelope);
          continue;
        }

        if (parsed.envelope.type === "client.goodbye") {
          removeClientSession(sessionKey, clientId, socket);
          socket.end();
          continue;
        }

        handleClientMessage(sessionKey, clientId, socket, parsed.envelope);
      }
    });

    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (helloTimer !== undefined) clearTimeout(helloTimer);
      if (clientId !== undefined && sessionKey !== undefined) {
        handleUnexpectedDisconnect(sessionKey, clientId, socket);
      }
    });
  }

  function rejectInvite(
    socket: Socket,
    requestId: string,
    supplied: boolean,
  ): void {
    const source = socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const previous = inviteFailures.get(source);
    if (previous !== undefined && previous.cooldownUntil > now) {
      sendError(socket, {
        code: "invite_rate_limited",
        message: "尝试过多，请稍后再试",
        requestId,
      });
      socket.end();
      return;
    }
    const current = previous === undefined ||
        now - previous.windowStartedAt >= inviteFailureWindowMs
      ? { failures: 1, windowStartedAt: now, cooldownUntil: 0 }
      : { ...previous, failures: previous.failures + 1 };
    if (current.failures >= inviteFailureLimit) {
      current.cooldownUntil = now + inviteCooldownMs;
    }
    inviteFailures.set(source, current);
    sendError(socket, {
      code: supplied ? "invite_invalid" : "invite_required",
      message: supplied ? "邀请码不正确" : "请输入群组邀请码",
      requestId,
    });
    socket.end();
  }

  function registerClient(
    socket: Socket,
    hello: ClientHelloEnvelope,
  ): { sessionKey: SessionKey; clientId: string } | undefined {
    const sessionKey = createSessionKey(hello.payload.deviceId, hello.payload.sessionId);
    let session = sessions.get(sessionKey);
    if (session === undefined) {
      if (hello.payload.clientId !== undefined) {
        sendError(socket, { code: "resume_rejected", message: "无法恢复原连接" });
        socket.end();
        return undefined;
      }
      session = {
        clientId: randomUUID(),
        resumeToken: randomBytes(32).toString("base64url"),
      };
      sessions.set(sessionKey, session);
    } else if (
      hello.payload.clientId !== session.clientId ||
      hello.payload.resumeToken !== session.resumeToken
    ) {
      sendError(socket, {
        code: hello.payload.clientId === undefined ? "session_in_use" : "resume_rejected",
        message: hello.payload.clientId === undefined
          ? "该 Pi Session 已在使用中"
          : "无法恢复原连接",
      });
      socket.end();
      return undefined;
    }
    if (session.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
    if (session.socket !== undefined && session.socket !== socket) {
      session.socket.destroy();
    }

    const clientId = session.clientId;
    permissions.set(clientId, hello.payload.permission);
    session.socket = socket;
    clients.set(clientId, socket);
    clearIdleShutdown();
    armHeartbeat(sessionKey, session, socket);
    groups.setAgentPermission(clientId, hello.payload.permission);
    const reconnectedMembers = groups.setOnline(clientId, true);
    send(socket, createEnvelope("client.welcome", {
      brokerInstanceId: instanceId,
      clientId,
      resumeToken: session.resumeToken,
    }) as BrokerEnvelope);
    sendSnapshot(clientId, socket);
    sendConfigStatus(socket);
    if (reconnectedMembers.length > 0) {
      broadcastPresence(reconnectedMembers, clientId);
      broadcastGroupsChanged();
    }
    resendUnacknowledgedDeliveries(clientId, socket);
    resendPendingApprovals(clientId, socket);
    return { sessionKey, clientId };
  }

  function armHeartbeat(
    sessionKey: SessionKey,
    session: ClientSession,
    socket: Socket,
  ): void {
    if (session.heartbeatTimer !== undefined) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => {
      session.heartbeatTimer = undefined;
      if (sessions.get(sessionKey)?.socket !== socket) return;
      sendError(socket, { code: "heartbeat_timeout", message: "客户端心跳超时" });
      socket.end();
    }, heartbeatTimeoutMs);
  }

  function handleUnexpectedDisconnect(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
  ): void {
    if (clients.get(clientId) !== socket) {
      return;
    }
    clients.delete(clientId);
    const session = sessions.get(sessionKey);
    if (session?.socket === socket) {
      session.socket = undefined;
      if (session.heartbeatTimer !== undefined) {
        clearTimeout(session.heartbeatTimer);
        session.heartbeatTimer = undefined;
      }
    }
    if (closing) {
      return;
    }

    proactive?.cancelForClient(clientId);
    const offlineMembers = groups.setOnline(clientId, false);
    broadcastPresence(offlineMembers, clientId);
    if (offlineMembers.length > 0) {
      broadcastGroupsChanged();
    }
    if (session !== undefined) {
      const graceMs = isLoopbackAddress(socket.remoteAddress)
        ? localDisconnectGraceMs
        : lanDisconnectGraceMs;
      session.disconnectTimer = setTimeout(() => {
        session.disconnectTimer = undefined;
        if (!clients.has(clientId)) {
          const removed = groups.removeIfJoined(clientId);
          if (removed !== undefined) {
            broadcastPresenceRemoved(removed.groupId, [
              removed.user.memberId,
              removed.agent.memberId,
            ]);
          }
          failRequestsForTarget(clientId, "target_offline");
          permissions.delete(clientId);
          sessions.delete(sessionKey);
          scheduleIdleShutdown();
        }
      }, graceMs);
    }
  }

  function removeClientSession(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
  ): void {
    const session = sessions.get(sessionKey);
    if (session?.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
    }
    if (session?.heartbeatTimer !== undefined) clearTimeout(session.heartbeatTimer);
    sessions.delete(sessionKey);
    permissions.delete(clientId);
    if (clients.get(clientId) !== socket) {
      return;
    }
    leaveClientGroup(clientId);
    clients.delete(clientId);
    scheduleIdleShutdown();
  }

  function handleClientMessage(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
    envelope: Exclude<ClientEnvelope, ClientHelloEnvelope>,
  ): void {
    if (envelope.type === "proactive.update") {
      const membership = groups.membershipForClient(clientId);
      if (
        membership === undefined ||
        membership.groupId !== envelope.payload.groupId
      ) {
        send(socket, createEnvelope("proactive.update.ack", {
          groupId: envelope.payload.groupId,
          enabled: envelope.payload.enabled,
          accepted: false,
          reason: "not_in_group",
        }) as BrokerEnvelope);
        return;
      }
      if (!db().updateProactiveEnabled(
        envelope.payload.groupId,
        sessionKey,
        envelope.payload.enabled,
      )) {
        send(socket, createEnvelope("proactive.update.ack", {
          groupId: envelope.payload.groupId,
          enabled: envelope.payload.enabled,
          accepted: false,
          reason: "not_in_group",
        }) as BrokerEnvelope);
        return;
      }
      groups.setProactiveEnabled(clientId, envelope.payload.enabled);
      if (envelope.payload.lastSeenGroupSeq !== undefined) {
        proactiveCursors.set(clientId, envelope.payload.lastSeenGroupSeq);
      }
      if (!envelope.payload.enabled) proactive?.cancelForClient(clientId);
      send(socket, createEnvelope("proactive.update.ack", {
        groupId: envelope.payload.groupId,
        enabled: envelope.payload.enabled,
        accepted: true,
      }) as BrokerEnvelope);
      return;
    }
    if (envelope.type === "proactive.deliver.ack") {
      proactive?.acknowledge(envelope.payload.proactiveId);
      return;
    }
    if (envelope.type === "proactive.decline") {
      proactive?.decline(envelope.payload.proactiveId, envelope.payload.reason);
      return;
    }
    if (envelope.type === "proactive.result") {
      void handleProactiveResult(socket, envelope.payload);
      return;
    }
    if (
      envelope.type === "broker.config.validate" ||
      envelope.type === "broker.config.update" ||
      envelope.type === "broker.config.delete"
    ) {
      if (!isLoopback(socket.remoteAddress)) {
        sendError(socket, {
          code: "invalid_payload",
          message: "只能在 Broker 本机管理 Proactive Router",
          requestId: envelope.id,
        });
        return;
      }
      if (envelope.type === "broker.config.delete") {
        proactiveScheduler.abortAll();
        proactive?.clear();
        if (envelope.payload.rebuild === true) {
          const rebuilt = proactiveConfig.rebuild();
          sendConfigStatus(
            socket,
            envelope.id,
            "Broker 配置已重建",
            rebuilt.backupPath,
          );
        } else {
          proactiveConfig.delete();
          sendConfigStatus(socket, envelope.id, "DeepSeek API Key 已删除");
        }
      } else {
        void validateConfigKey(
          socket,
          envelope.id,
          envelope.payload.apiKey,
          envelope.type === "broker.config.update",
        );
      }
      return;
    }
    if (envelope.type === "broker.network.refresh") {
      if (!isLoopback(socket.remoteAddress)) {
        sendError(socket, {
          code: "invalid_payload",
          message: "只能在这台电脑上更新网络状态",
          requestId: envelope.id,
        });
        return;
      }
      void refreshNetworkAccess().then((result) => {
        send(socket, createEnvelope("broker.network.updated", {
          requestId: envelope.id,
          allowed: result.allowed,
          ...(result.address === undefined ? {} : { address: result.address }),
        }) as BrokerEnvelope);
      }).catch((error: unknown) => {
        sendError(socket, {
          code: "database_error",
          message: error instanceof Error ? error.message : String(error),
          requestId: envelope.id,
        });
      });
      return;
    }
    if (envelope.type === "agent.deliver.ack") {
      const pending = pendingRequests.get(envelope.payload.requestId);
      if (pending?.targetClientId === clientId) {
        db().markDelivered(envelope.payload.requestId);
        pending.deliveryAcknowledged = true;
        broadcastRequestMessageStatus(pending);
      }
      return;
    }
    if (envelope.type === "agent.result") {
      handleAgentResult(clientId, socket, envelope.payload);
      return;
    }
    if (envelope.type === "agent.status") {
      const agent = groups.setAgentStatus(clientId, envelope.payload.status);
      if (agent !== undefined) {
        broadcastPresence([agent]);
      }
      return;
    }
    if (envelope.type === "permission.update") {
      permissions.set(clientId, envelope.payload.permission);
      const agent = groups.setAgentPermission(clientId, envelope.payload.permission);
      if (agent !== undefined) broadcastPresence([agent]);
      return;
    }
    if (envelope.type === "request.approve") {
      handleRequestDecision(clientId, socket, envelope.payload.requestId, true);
      return;
    }
    if (envelope.type === "request.reject") {
      handleRequestDecision(clientId, socket, envelope.payload.requestId, false);
      return;
    }
    if (envelope.type === "chain.continue") {
      handleChainDecision(clientId, socket, envelope.payload.chainId, true);
      return;
    }
    if (envelope.type === "chain.end") {
      handleChainDecision(clientId, socket, envelope.payload.chainId, false);
      return;
    }
    if (envelope.type === "group.create") {
      handleGroupCreate(sessionKey, clientId, socket, envelope.id, envelope.payload);
      return;
    }
    if (envelope.type === "group.join") {
      handleGroupJoin(sessionKey, clientId, socket, envelope.id, envelope.payload);
      return;
    }
    if (envelope.type === "group.leave") {
      handleGroupLeave(sessionKey, clientId, socket, envelope.id);
      return;
    }
    if (envelope.type === "group.rename") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      try {
        const previousName = groups.groupForClient(clientId)?.groupName ??
          db().storedGroup(envelope.payload.groupId)?.groupName;
        groups.renameGroup(envelope.payload.groupId, envelope.payload.groupName);
        db().updateGroupName(envelope.payload.groupId, envelope.payload.groupName);
        const notice = createEnvelope("chat.message", {
          groupId: envelope.payload.groupId,
          groupSeq: db().nextGroupSeq(envelope.payload.groupId),
          senderId: "system",
          senderName: "系统",
          senderType: "user" as const,
          text: `群组已从「${previousName ?? "未命名"}」改名为「${envelope.payload.groupName}」`,
          mentionIds: [],
          status: "sent" as const,
        });
        db().insertMessage(
          historyMessage(
            notice.id,
            notice.timestamp,
            notice.payload,
            "sent",
          ),
        );
        broadcastToGroup(envelope.payload.groupId, notice as BrokerEnvelope);
        sendSnapshotsForGroup(envelope.payload.groupId);
        broadcastGroupsChanged();
      } catch (error) {
        sendGroupError(socket, envelope.id, error);
      }
      return;
    }
    if (envelope.type === "group.visibility.update") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      db().updateGroupInvite(
        envelope.payload.groupId,
        envelope.payload.visibility,
        undefined,
      );
      if (envelope.payload.visibility === "local") {
        disconnectRemoteGroupMembers(envelope.payload.groupId);
      }
      send(socket, createEnvelope("group.invite.updated", {
        groupId: envelope.payload.groupId,
        visibility: envelope.payload.visibility,
        inviteRequired: false,
      }) as BrokerEnvelope);
      sendSnapshotsForGroup(envelope.payload.groupId);
      void refreshNetworkAccess();
      void syncBackgroundSupervisor().catch((error) => {
        sendError(socket, {
          code: "database_error",
          message: `后台开放设置失败：${error instanceof Error ? error.message : String(error)}`,
          requestId: envelope.id,
        });
      });
      return;
    }
    if (envelope.type === "group.availability.update") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      const group = db().storedGroup(envelope.payload.groupId)!;
      if (
        group.visibility !== "nearby" ||
        (envelope.payload.openAtLogin && !envelope.payload.keepAvailableWhenEmpty)
      ) {
        sendError(socket, {
          code: "invalid_payload",
          message: "请先开放附近加入；登录后自动开放依赖后台可加入",
          requestId: envelope.id,
        });
        return;
      }
      db().updateGroupAvailability(
        envelope.payload.groupId,
        envelope.payload.keepAvailableWhenEmpty,
        envelope.payload.openAtLogin,
      );
      void syncBackgroundSupervisor().catch((error) => {
        sendError(socket, {
          code: "database_error",
          message: `登录后自动开放设置失败：${error instanceof Error ? error.message : String(error)}`,
          requestId: envelope.id,
        });
      });
      sendSnapshotsForGroup(envelope.payload.groupId);
      scheduleIdleShutdown();
      return;
    }
    if (envelope.type === "group.invite.rotate") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      const group = db().storedGroup(envelope.payload.groupId)!;
      if (group.visibility !== "nearby") {
        sendError(socket, {
          code: "invalid_payload",
          message: "该群组尚未开放附近加入",
          requestId: envelope.id,
        });
        return;
      }
      if (!group.inviteRequired) {
        sendError(socket, {
          code: "invalid_payload",
          message: "这个群组允许直接加入，没有启用邀请码",
          requestId: envelope.id,
        });
        return;
      }
      const inviteCode = generateInviteCode();
      db().updateGroupInvite(group.groupId, "nearby", hashSecret(inviteCode));
      send(socket, createEnvelope("group.invite.updated", {
        groupId: group.groupId,
        visibility: "nearby",
        inviteRequired: true,
        inviteCode,
      }) as BrokerEnvelope);
      return;
    }
    if (envelope.type === "group.member.remove") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      const group = db().storedGroup(envelope.payload.groupId)!;
      if (group.ownerSessionKey === envelope.payload.sessionKey) {
        sendError(socket, {
          code: "invalid_payload",
          message: "不能移出群主",
          requestId: envelope.id,
        });
        return;
      }
      const member = db().membership(
        envelope.payload.groupId,
        envelope.payload.sessionKey as SessionKey,
      );
      if (member === undefined) {
        sendError(socket, {
          code: "request_invalid",
          message: "成员不存在",
          requestId: envelope.id,
        });
        return;
      }
      db().setMembershipStatus(
        envelope.payload.groupId,
        envelope.payload.sessionKey as SessionKey,
        "removed",
      );
      const targetClientId = groups.clientIdForSessionMember(
        envelope.payload.groupId,
        member.userName,
      );
      if (targetClientId !== undefined) {
        const removed = groups.removeIfJoined(targetClientId);
        if (removed !== undefined) {
          broadcastPresenceRemoved(removed.groupId, [
            removed.user.memberId,
            removed.agent.memberId,
          ]);
          const targetSocket = clients.get(targetClientId);
          if (targetSocket !== undefined) {
            sendError(targetSocket, {
              code: "member_removed",
              message: "你已被群主移出该群组",
            });
            sendSnapshot(targetClientId, targetSocket);
          }
        }
      }
      sendSnapshotsForGroup(envelope.payload.groupId);
      return;
    }
    if (envelope.type === "group.member.allow") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      db().deleteMembership(
        envelope.payload.groupId,
        envelope.payload.sessionKey as SessionKey,
      );
      sendSnapshotsForGroup(envelope.payload.groupId);
      return;
    }
    if (envelope.type === "group.delete") {
      if (!requireOwner(sessionKey, socket, envelope.id, envelope.payload)) return;
      const removed = groups.removeGroupAndMemberships(envelope.payload.groupId);
      db().deleteGroup(envelope.payload.groupId);
      for (const membership of removed) {
        const targetSocket = clients.get(membership.user.clientId);
        if (targetSocket !== undefined) sendSnapshot(membership.user.clientId, targetSocket);
      }
      broadcastGroupsChanged();
      void refreshNetworkAccess();
      void syncBackgroundSupervisor().catch(() => undefined);
      scheduleIdleShutdown();
      return;
    }
    if (envelope.type === "group.owner.recover") {
      if (!isLoopback(socket.remoteAddress)) {
        sendError(socket, {
          code: "owner_required",
          message: "只能在群组所在设备恢复群主管理权",
          requestId: envelope.id,
        });
        return;
      }
      const membership = db().membershipByCredential(
        envelope.payload.groupId,
        hashSecret(envelope.payload.membershipCredential),
      );
      if (
        membership === undefined ||
        membership.status !== "active" ||
        membership.sessionKey !== sessionKey
      ) {
        sendError(socket, {
          code: "membership_invalid",
          message: "请先以长期成员身份进入该群组",
          requestId: envelope.id,
        });
        return;
      }
      const ownerCredential = createCredential();
      db().updateOwner(
        envelope.payload.groupId,
        sessionKey,
        hashSecret(ownerCredential),
      );
      groups.setOwnerSession(envelope.payload.groupId, sessionKey);
      send(socket, createEnvelope("group.owner.welcome", {
        groupId: envelope.payload.groupId,
        ownerCredential,
      }) as BrokerEnvelope);
      sendSnapshotsForGroup(envelope.payload.groupId);
      return;
    }
    if (envelope.type === "chat.send") {
      handleChatSend(clientId, socket, envelope.id, envelope.payload.text);
    }
  }

  async function handleProactiveResult(
    socket: Socket,
    result: ProactiveResultPayload,
  ): Promise<void> {
    const accepted = await proactive?.result(result) ?? false;
    send(socket, createEnvelope("proactive.result.ack", {
      proactiveId: result.proactiveId,
      accepted,
    }) as BrokerEnvelope);
  }

  async function validateConfigKey(
    socket: Socket,
    requestId: string,
    apiKey: string,
    save: boolean,
  ): Promise<void> {
    try {
      await proactiveScheduler.schedule("validation", (signal) =>
        withProactiveRetry(() => proactiveProvider.validate(apiKey, signal))
      );
      if (save) proactiveConfig.saveVerified(apiKey);
      sendConfigStatus(socket, requestId, save ? "DeepSeek API Key 已验证并保存" : "验证成功");
    } catch (error) {
      if (
        save &&
        error instanceof ProactiveProviderError &&
        (error.kind === "network" || error.kind === "timeout") &&
        proactiveConfig.snapshot().apiKey === undefined
      ) {
        proactiveConfig.saveUnverified(apiKey);
        sendConfigStatus(socket, requestId, "网络不可用，Key 已保存为未验证");
        return;
      }
      sendConfigStatus(
        socket,
        requestId,
        error instanceof Error ? error.message : "验证失败",
      );
    }
  }

  function currentProactiveStatus() {
    return proactive?.status() ?? proactiveConfig.snapshot().proactiveStatus;
  }

  function sendConfigStatus(
    socket: Socket,
    requestId?: string,
    message?: string,
    backupPath?: string,
  ): void {
    const snapshot = proactiveConfig.snapshot();
    send(socket, createEnvelope("broker.config.status", {
      proactiveStatus: currentProactiveStatus(),
      ...(isLoopback(socket.remoteAddress) && snapshot.maskedApiKey !== undefined
        ? { maskedApiKey: snapshot.maskedApiKey }
        : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...(message === undefined ? {} : { message }),
      ...(backupPath === undefined ? {} : { backupPath }),
    }) as BrokerEnvelope);
  }

  function createProactiveCoordinator(): ProactiveCoordinator {
    return new ProactiveCoordinator({
      provider: proactiveProvider,
      scheduler: proactiveScheduler,
      credentials: () => proactiveConfig.snapshot(),
      groupName: (groupId) => db().storedGroup(groupId)?.groupName,
      candidates: (groupId) => groups.members(groupId)
        .filter((member) =>
          member.type === "agent" &&
          member.online &&
          member.agentStatus === "idle" &&
          member.proactiveEnabled === true &&
          typeof member.agentDescription === "string" &&
          member.agentDescription.length > 0
        )
        .map((member) => ({
          agentId: member.memberId,
          clientId: member.clientId,
          name: member.displayName,
          description: member.agentDescription!,
        })),
      messages: (groupId, afterSeq = 0, limit = 20) =>
        db().publicMessages(groupId, { afterSeq, limit }),
      latestSeq: (groupId) => db().latestGroupSeq(groupId),
      context: (groupId, throughSeq, apiKey) =>
        groupContext.prepare(groupId, apiKey, throughSeq),
      contextSnapshot: (groupId, throughSeq) => groupContext.snapshot(groupId, throughSeq),
      participants: participantDirectory,
      deliver: (clientId, payload) => {
        const target = groups.membershipForClient(clientId)?.agent;
        const targetSocket = clients.get(clientId);
        if (
          targetSocket === undefined || target === undefined ||
          !target.online || target.agentStatus !== "idle" ||
          target.proactiveEnabled !== true
        ) return false;
        const cursor = proactiveCursors.get(clientId) ?? 0;
        const delta = db().publicMessages(payload.groupId, {
          afterSeq: cursor,
          limit: 13,
        });
        const messages = delta.slice(-12);
        const omitted = delta.length > 12;
        const omittedThroughSeq = omitted ? delta[0]!.groupSeq : undefined;
        send(targetSocket, createEnvelope("proactive.deliver", {
          ...payload,
          observedToSeq: db().latestGroupSeq(payload.groupId),
          messages: messages.map((message) => ({
            groupSeq: message.groupSeq,
            senderName: message.senderName,
            senderType: message.senderType,
            text: message.text,
          })),
          omitted,
          summaryIncomplete: payload.summaryIncomplete || (
            omittedThroughSeq !== undefined &&
            (payload.summary === undefined || payload.summary.throughSeq < omittedThroughSeq)
          ),
        }) as BrokerEnvelope);
        return true;
      },
      publish: publishProactiveAnswer,
      onInvalidKey: () => {
        proactiveScheduler.abortAll();
        proactiveConfig.markInvalid();
        broadcastConfigStatus();
      },
      onStatusChanged: broadcastConfigStatus,
      log: proactiveLog,
      ...(options.proactiveTimings ?? {}),
    });
  }

  function broadcastConfigStatus(): void {
    for (const socket of clients.values()) sendConfigStatus(socket);
  }

  function publishProactiveAnswer(pending: PendingProactive, text: string): void {
    const source = groups.membershipForClient(pending.target.clientId);
    if (source === undefined || source.groupId !== pending.groupId) return;
    const mention = parseMentions(text.trimStart());
    const resolved = mention?.names.map((name) => ({
      name, member: groups.findMemberByName(pending.groupId, name),
    })) ?? [];
    const targets = [...new Map(resolved.flatMap(({ member }) =>
      member?.type === "agent" ? [[member.memberId, member] as const] : []
    )).values()];
    const unknownNames = [...new Set(resolved.filter(({ member }) => member === undefined)
      .map(({ name }) => name))];
    const answerPayload: ChatMessagePayload = {
      groupId: pending.groupId,
      groupSeq: db().nextGroupSeq(pending.groupId),
      senderId: source.agent.memberId,
      senderName: source.agent.displayName,
      senderType: "agent",
      text,
      mentionIds: [...new Set(resolved.flatMap(({ member }) =>
        member === undefined ? [] : [member.memberId]
      ))],
      status: "sent",
      chainId: pending.proactiveId,
      round: 1,
    };
    const taskText = mention?.text?.trim() ?? "";
    const context: AgentChainContext = {
      initiatorSessionKey: sessionKeyForClient(source.user.clientId)!,
      initiatorName: source.user.displayName,
      participants: [source.agent.displayName, ...targets.map(({ displayName }) => displayName)],
      roundLimit: 10,
    };
    const requests: Array<{
      request: AgentRequestPayload; targetClientId: string;
      awaitingApproval: boolean; context: AgentChainContext;
    }> = [];
    const failed: Parameters<BrokerDatabase["insertAgentRequestBatch"]>[2] = [];
    const deliveries: NonNullable<ChatMessagePayload["deliveries"]> = [];
    for (const target of targets) {
      const nextRequestId = randomUUID();
      const targetMembership = groups.membershipForClient(target.clientId);
      const permission = permissions.get(target.clientId) ?? "auto";
      const failure = target.memberId === source.agent.memberId ? "target_self" as const :
        taskText === "" ? "empty_mention" as const :
        !target.online || clients.get(target.clientId) === undefined || targetMembership === undefined
          ? "target_offline" as const :
        permission === "blocked" ? "target_blocked" as const : undefined;
      if (failure !== undefined || targetMembership === undefined) {
        failed.push({
          initiatorSessionKey: context.initiatorSessionKey, requestId: nextRequestId,
          groupId: pending.groupId, messageId: "", senderId: source.agent.memberId,
          senderName: source.agent.displayName, targetAgentId: target.memberId,
          targetAgentName: target.displayName, text: taskText, chainId: pending.proactiveId,
          round: 2, failureReason: failure ?? "target_offline",
        });
        deliveries.push({ requestId: nextRequestId, targetAgentId: target.memberId,
          targetAgentName: target.displayName, status: "failed",
          failureReason: failure ?? "target_offline" });
        continue;
      }
      const awaitingApproval = permission === "approval";
      const request: AgentRequestPayload = {
        requestId: nextRequestId, groupId: pending.groupId, groupName: pending.groupName,
        senderId: source.agent.memberId, senderName: source.agent.displayName,
        senderType: "agent", senderOwnerUserName: source.user.displayName,
        targetAgentId: target.memberId, targetAgentName: target.displayName,
        ownerUserName: targetMembership.user.displayName,
        onlineMembers: groups.onlineMembers(pending.groupId)
          .filter((member) => member.memberId !== target.memberId)
          .map((member) => ({ displayName: member.displayName, type: member.type })),
        participants: participantDirectory(pending.groupId), coRecipients: [], text: taskText,
        chainId: pending.proactiveId, round: 2, createdAt: Date.now(),
      };
      requests.push({ request, targetClientId: target.clientId, awaitingApproval, context });
      deliveries.push({ requestId: nextRequestId, targetAgentId: target.memberId,
        targetAgentName: target.displayName,
        status: awaitingApproval ? "waiting_approval" : "queued" });
    }
    for (const name of unknownNames) {
      const nextRequestId = randomUUID();
      failed.push({
        initiatorSessionKey: context.initiatorSessionKey, requestId: nextRequestId,
        groupId: pending.groupId, messageId: "", senderId: source.agent.memberId,
        senderName: source.agent.displayName, targetAgentName: name, text: taskText,
        chainId: pending.proactiveId, round: 2, failureReason: "target_not_found",
      });
      deliveries.push({ requestId: nextRequestId, targetAgentName: name,
        status: "failed", failureReason: "target_not_found" });
    }
    const recipients = requests.map(({ request }) => ({
      agentId: request.targetAgentId, name: request.targetAgentName,
    }));
    for (const item of requests) item.request.coRecipients = recipients.filter(
      ({ agentId }) => agentId !== item.request.targetAgentId,
    );
    if (deliveries.length > 1) answerPayload.deliveries = deliveries;
    if (deliveries.length === 1) {
      const delivery = deliveries[0]!;
      answerPayload.routeRequestId = delivery.requestId;
      answerPayload.routeTargetName = delivery.targetAgentName;
      answerPayload.routeStatus = delivery.status === "failed" ? "failed" : delivery.status;
      answerPayload.routeFailureReason = delivery.failureReason;
      answerPayload.nextRound = 2;
    }
    const answer = createEnvelope("chat.message", answerPayload);
    const stored = historyMessage(answer.id, answer.timestamp, answer.payload, "sent");
    for (const item of failed) item.messageId = answer.id;
    if (requests.length === 0 && failed.length === 0) {
      db().insertMessage(stored);
    } else {
      db().insertAgentRequestBatch(
        stored, requests.map(({ request, awaitingApproval, context }) => ({
          request, awaitingApproval, context,
        })), failed,
      );
      for (const item of requests) pendingRequests.set(item.request.requestId, {
        targetClientId: item.targetClientId, targetAgentId: item.request.targetAgentId,
        targetName: item.request.targetAgentName, groupId: item.request.groupId,
        request: item.request, message: stored,
        state: item.awaitingApproval ? "awaiting_approval" : "delivering",
        deliveryAcknowledged: false, context,
      });
    }
    broadcastToGroup(pending.groupId, answer as BrokerEnvelope);
    for (const item of requests) {
      const targetSocket = clients.get(item.targetClientId);
      if (targetSocket !== undefined) {
        send(targetSocket, createEnvelope(
          item.awaitingApproval ? "request.pending" : "agent.deliver", item.request,
        ) as BrokerEnvelope);
      }
      if (item.awaitingApproval) updatePendingApprovalCount(item.targetClientId);
    }
  }

  function handleGroupCreate(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
    requestId: string,
    payload: GroupCreatePayload,
  ): void {
    if (!isLoopback(socket.remoteAddress)) {
      sendError(socket, {
        code: "owner_required",
        message: "只能在自己的设备上创建群组",
        requestId,
      });
      return;
    }
    let groupId: string | undefined;
    try {
      payload.agentDescription = normalizeAgentDescription(payload.agentDescription);
      const membership = groups.createGroup(
        clientId,
        payload.groupName,
        payload.userName,
        payload.agentName,
        undefined,
        sessionKey,
        payload.agentDescription,
      );
      groupId = membership.groupId;
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
      const visibility = payload.visibility ?? "local";
      const ownerCredential = createCredential();
      const membershipCredential = createCredential();
      const inviteCode = visibility === "nearby" && payload.inviteRequired === true
        ? generateInviteCode()
        : undefined;
      db().insertOwnedGroup(
        { groupId, groupName: payload.groupName },
        {
          ownerSessionKey: sessionKey,
          ownerCredentialHash: hashSecret(ownerCredential),
          visibility,
          ...(inviteCode === undefined
            ? {}
            : { inviteCodeHash: hashSecret(normalizeInviteCode(inviteCode)) }),
          userName: payload.userName,
          agentName: payload.agentName,
          agentDescription: payload.agentDescription,
          membershipCredentialHash: hashSecret(membershipCredential),
        },
      );
      send(socket, createEnvelope("membership.welcome", {
        groupId,
        membershipCredential,
        ownerCredential,
        ...(inviteCode === undefined ? {} : { inviteCode }),
      }) as BrokerEnvelope);
      sendSnapshot(clientId, socket);
      broadcastGroupsChanged();
      void refreshNetworkAccess();
    } catch (error) {
      if (groupId !== undefined) {
        groups.removeIfJoined(clientId);
        groups.removeGroup(groupId);
      }
      sendGroupError(socket, requestId, error);
    }
  }

  function handleGroupJoin(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
    requestId: string,
    payload: GroupJoinPayload,
  ): void {
    try {
      if (payload.agentDescription !== undefined) {
        payload.agentDescription = normalizeAgentDescription(payload.agentDescription);
      }
      const storedGroup = db().storedGroup(payload.groupId);
      if (storedGroup === undefined) {
        const deletedGroup = db().consumeGroupTombstone(
          payload.groupId,
          sessionKey,
        );
        if (deletedGroup !== undefined) {
          sendError(socket, {
            code: "group_deleted",
            message: `群组“${deletedGroup}”已解散`,
            requestId,
          });
          return;
        }
        throw new GroupStateError("group_not_found", "群组不存在");
      }
      let userName: string;
      let agentName: string;
      let agentDescription: string;
      let proactiveEnabled = true;
      let membershipCredential: string | undefined;
      let isOwner = false;
      if (payload.membershipCredential !== undefined) {
        if (
          storedGroup.visibility !== "nearby" &&
          !isLoopback(socket.remoteAddress)
        ) {
          sendError(socket, {
            code: "invite_invalid",
            message: "该群组目前仅这台电脑可以使用",
            requestId,
          });
          return;
        }
        const stored = db().membershipByCredential(
          payload.groupId,
          hashSecret(payload.membershipCredential),
        );
        if (stored === undefined || stored.sessionKey !== sessionKey) {
          sendError(socket, {
            code: "membership_invalid",
            message: "成员身份已失效，请重新加入群组",
            requestId,
          });
          return;
        }
        if (stored.status === "removed") {
          sendError(socket, {
            code: "member_removed",
            message: "你已被移出该群组",
            requestId,
          });
          return;
        }
        if (!stored.agentDescription) {
          sendError(socket, {
            code: "membership_invalid",
            message: "旧成员身份需要重新加入并填写 Agent Description",
            requestId,
          });
          return;
        }
        userName = stored.userName;
        agentName = stored.agentName;
        agentDescription = stored.agentDescription;
        proactiveEnabled = stored.proactiveEnabled;
        isOwner = storedGroup.ownerSessionKey === sessionKey;
        db().touchMembership(payload.groupId, sessionKey);
      } else {
        const normalizedInvite = payload.inviteCode === undefined
          ? undefined
          : normalizeInviteCode(payload.inviteCode);
        const localEnrollment = normalizedInvite === undefined &&
          isLoopback(socket.remoteAddress);
        const remoteEnrollment = !localEnrollment;
        if (remoteEnrollment && storedGroup.visibility !== "nearby") {
          rejectInvite(socket, requestId, normalizedInvite !== undefined);
          return;
        }
        if (
          remoteEnrollment &&
          storedGroup.inviteRequired &&
          (
            normalizedInvite === undefined ||
            storedGroup.inviteCodeHash === undefined ||
            hashSecret(normalizedInvite) !== storedGroup.inviteCodeHash
          )
        ) {
          rejectInvite(socket, requestId, normalizedInvite !== undefined);
          return;
        }
        inviteFailures.delete(socket.remoteAddress ?? "unknown");
        membershipCredential = createCredential();
        const legacy = db().membership(payload.groupId, sessionKey);
        if (legacy !== undefined && legacy.status === "active" && !legacy.agentDescription) {
          userName = legacy.userName;
          agentName = legacy.agentName;
          agentDescription = payload.agentDescription!;
          db().completeLegacyMembership(
            payload.groupId,
            sessionKey,
            agentDescription,
            hashSecret(membershipCredential),
          );
        } else {
          userName = payload.userName!;
          agentName = payload.agentName!;
          agentDescription = payload.agentDescription!;
          if (!db().isMemberNameAvailable(payload.groupId, userName, agentName)) {
            throw new GroupStateError("member_name_conflict", "群组内名称已被使用");
          }
          db().insertMembership({
            groupId: payload.groupId,
            sessionKey,
            userName,
            agentName,
            agentDescription,
            proactiveEnabled: true,
            credentialHash: hashSecret(membershipCredential),
          });
        }
      }
      const membership = groups.joinGroup(
        clientId,
        payload.groupId,
        userName,
        agentName,
        isOwner,
        sessionKey,
        agentDescription,
      );
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
      groups.setProactiveEnabled(clientId, proactiveEnabled);
      if (membershipCredential !== undefined) {
        send(socket, createEnvelope("membership.welcome", {
          groupId: payload.groupId,
          membershipCredential,
        }) as BrokerEnvelope);
      }
      sendSnapshot(clientId, socket);
      broadcastPresence([membership.user, membership.agent], clientId);
      broadcastGroupsChanged();
    } catch (error) {
      sendGroupError(socket, requestId, error);
    }
  }

  function handleGroupLeave(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
    requestId: string,
  ): void {
    try {
      const group = groups.groupForClient(clientId);
      if (group !== undefined && db().storedGroup(group.groupId)?.ownerSessionKey === sessionKey) {
        sendError(socket, {
          code: "owner_cannot_leave",
          message: "群主不能退出自己的群组，请在群组管理中解散",
          requestId,
        });
        return;
      }
      leaveClientGroup(clientId, true, sessionKey);
      sendSnapshot(clientId, socket);
    } catch (error) {
      sendGroupError(socket, requestId, error);
    }
  }

  function leaveClientGroup(
    clientId: string,
    required = false,
    deleteSessionKey?: SessionKey,
  ): void {
    const membership = groups.membershipForClient(clientId);
    if (membership === undefined) {
      if (required) {
        groups.leaveGroup(clientId);
      }
      return;
    }
    proactive?.cancelForClient(clientId);
    const offlineMembers = groups.setOnline(clientId, false);
    broadcastPresence(offlineMembers, clientId);
    const removed = groups.leaveGroup(clientId);
    if (deleteSessionKey !== undefined) {
      db().deleteMembership(removed.groupId, deleteSessionKey);
    }
    broadcastPresenceRemoved(removed.groupId, [
      removed.user.memberId,
      removed.agent.memberId,
    ]);
    failRequestsForTarget(clientId, "target_offline");
    broadcastGroupsChanged();
  }

  function handleChatSend(
    clientId: string,
    socket: Socket,
    requestId: string,
    text: string,
  ): void {
    const membership = groups.membershipForClient(clientId);
    const group = groups.groupForClient(clientId);
    if (membership === undefined || group === undefined) {
      sendError(socket, {
        code: "not_in_group",
        message: "请先创建或加入群组",
        requestId,
      });
      return;
    }
    if (db().hasMessage(requestId)) {
      return;
    }

    const mention = parseMentions(text);
    const resolved = mention?.names.map((name) => ({
      name,
      member: groups.findMemberByName(group.groupId, name),
    })) ?? [];
    const mentionIds = [...new Set(resolved.flatMap(({ member }) =>
      member === undefined ? [] : [member.memberId]
    ))];
    const basePayload = {
      groupId: group.groupId,
      groupSeq: db().nextGroupSeq(group.groupId),
      senderId: membership.user.memberId,
      senderName: membership.user.displayName,
      senderType: "user" as const,
      text,
      mentionIds,
      ...(mention === undefined ? {} : { requestId }),
    };

    if (mention === undefined) {
      const message = createEnvelope(
        "chat.message",
        { ...basePayload, status: "sent" as const },
        { id: requestId },
      );
      try {
        db().insertMessage(
          historyMessage(message.id, message.timestamp, message.payload, "sent"),
        );
      } catch (error) {
        sendGroupError(socket, requestId, error);
        return;
      }
      broadcastToGroup(group.groupId, message as BrokerEnvelope);
      proactive?.trigger(group.groupId, basePayload.groupSeq);
      return;
    }

    const uniqueAgents = [...new Map(resolved.flatMap(({ member }) =>
      member?.type === "agent" ? [[member.memberId, member] as const] : []
    )).values()];
    const unknownNames = [...new Set(resolved.filter(({ member }) => member === undefined)
      .map(({ name }) => name))];
    if (uniqueAgents.length === 0 && unknownNames.length === 0) {
      const message = createEnvelope(
        "chat.message",
        { ...basePayload, status: "sent" as const },
        { id: requestId },
      );
      try {
        db().insertMessage(
          historyMessage(message.id, message.timestamp, message.payload, "sent"),
        );
      } catch (error) {
        sendGroupError(socket, requestId, error);
        return;
      }
      broadcastToGroup(group.groupId, message as BrokerEnvelope);
      proactive?.trigger(group.groupId, basePayload.groupSeq);
      return;
    }
    const taskText = mention.text?.trim() ?? "";
    const createdAt = Date.now();
    const active: Array<{
      request: AgentRequestPayload;
      awaitingApproval: boolean;
      context: AgentChainContext;
      targetClientId: string;
    }> = [];
    const failed: Parameters<BrokerDatabase["insertAgentRequestBatch"]>[2] = [];
    const deliveryStates: NonNullable<ChatMessagePayload["deliveries"]> = [];
    const initiatorSessionKey = sessionKeyForClient(clientId) ?? createSessionKey(deviceId, clientId);
    const makeRequestId = (): string => uniqueAgents.length === 1 && unknownNames.length === 0
      ? requestId : randomUUID();
    for (const target of uniqueAgents) {
      const targetRequestId = makeRequestId();
      const targetSocket = clients.get(target.clientId);
      const targetMembership = groups.membershipForClient(target.clientId);
      const permission = permissions.get(target.clientId) ?? "auto";
      const failure = taskText === "" ? "delivery_failed" as const :
        !target.online || targetSocket === undefined || targetMembership === undefined
          ? "target_offline" as const :
        permission === "blocked" ? "target_blocked" as const : undefined;
      if (failure !== undefined || targetMembership === undefined) {
        const reason = failure ?? "target_offline";
        failed.push({
          initiatorSessionKey, requestId: targetRequestId, groupId: group.groupId,
          messageId: requestId, senderId: membership.user.memberId,
          senderName: membership.user.displayName, targetAgentId: target.memberId,
          targetAgentName: target.displayName, text: taskText, chainId: requestId,
          round: 1, failureReason: reason,
        });
        deliveryStates.push({ requestId: targetRequestId, targetAgentId: target.memberId,
          targetAgentName: target.displayName, status: "failed", failureReason: reason });
        continue;
      }
      const awaitingApproval = permission === "approval";
      const request: AgentRequestPayload = {
        requestId: targetRequestId, groupId: group.groupId, groupName: group.groupName,
        senderId: membership.user.memberId, senderName: membership.user.displayName,
        senderType: "user", targetAgentId: target.memberId,
        targetAgentName: target.displayName, ownerUserName: targetMembership.user.displayName,
        onlineMembers: groups.onlineMembers(group.groupId)
          .filter((member) => member.memberId !== target.memberId)
          .map((member) => ({ displayName: member.displayName, type: member.type })),
        participants: participantDirectory(group.groupId), coRecipients: [], text: taskText,
        chainId: requestId, round: 1, createdAt,
      };
      const context: AgentChainContext = {
        initiatorSessionKey, initiatorName: membership.user.displayName,
        participants: uniqueAgents.map((agent) => agent.displayName), roundLimit: 10,
      };
      active.push({ request, awaitingApproval, context, targetClientId: target.clientId });
      deliveryStates.push({ requestId: targetRequestId, targetAgentId: target.memberId,
        targetAgentName: target.displayName,
        status: awaitingApproval ? "waiting_approval" : "queued" });
    }
    for (const name of unknownNames) {
      const targetRequestId = uniqueAgents.length === 0 && unknownNames.length === 1
        ? requestId : randomUUID();
      failed.push({
        initiatorSessionKey, requestId: targetRequestId, groupId: group.groupId,
        messageId: requestId, senderId: membership.user.memberId,
        senderName: membership.user.displayName, targetAgentName: name,
        text: taskText, chainId: requestId, round: 1, failureReason: "target_not_found",
      });
      deliveryStates.push({ requestId: targetRequestId, targetAgentName: name,
        status: "failed", failureReason: "target_not_found" });
    }
    const recipients = active.map(({ request }) => ({
      agentId: request.targetAgentId, name: request.targetAgentName,
    }));
    for (const item of active) {
      item.request.coRecipients = recipients.filter(({ agentId }) =>
        agentId !== item.request.targetAgentId
      );
    }
    const context: AgentChainContext = {
      initiatorSessionKey,
      initiatorName: membership.user.displayName,
      participants: recipients.map(({ name }) => name),
      roundLimit: 10,
    };
    for (const item of active) item.context = context;
    const status = active.some(({ awaitingApproval }) => !awaitingApproval)
      ? "processing" as const
      : active.length > 0 ? "waiting_approval" as const : "failed" as const;
    const message = createEnvelope(
      "chat.message",
      {
        ...basePayload,
        status,
        deliveries: deliveryStates,
      },
      { id: requestId },
    );
    const storedMessage = historyMessage(
      message.id,
      message.timestamp,
      message.payload,
      message.payload.status,
    );
    try {
      db().insertAgentRequestBatch(
        storedMessage,
        active.map(({ request, awaitingApproval, context }) => ({ request, awaitingApproval, context })),
        failed,
      );
    } catch (error) {
      sendGroupError(socket, requestId, error);
      return;
    }
    for (const item of active) pendingRequests.set(item.request.requestId, {
      targetClientId: item.targetClientId, targetAgentId: item.request.targetAgentId,
      targetName: item.request.targetAgentName, groupId: group.groupId,
      request: item.request, message: storedMessage,
      state: item.awaitingApproval ? "awaiting_approval" : "delivering",
      deliveryAcknowledged: false, context,
    });
    for (const item of failed) closedRequestIds.add(item.requestId);
    broadcastToGroup(group.groupId, message as BrokerEnvelope);
    for (const item of active) {
      const targetSocket = clients.get(item.targetClientId);
      if (targetSocket === undefined) continue;
      send(targetSocket, createEnvelope(
        item.awaitingApproval ? "request.pending" : "agent.deliver", item.request,
      ) as BrokerEnvelope);
      if (item.awaitingApproval) updatePendingApprovalCount(item.targetClientId);
    }
    for (const item of failed) broadcastFailure({
      requestId: item.requestId, groupId: group.groupId,
      targetName: item.targetAgentName, ...(item.targetAgentId === undefined ? {} : {
        targetAgentId: item.targetAgentId,
      }), reason: item.failureReason as SendFailedPayload["reason"],
    });
  }

  function resendUnacknowledgedDeliveries(
    targetClientId: string,
    socket: Socket,
  ): void {
    for (const pending of pendingRequests.values()) {
      if (
        pending.targetClientId === targetClientId &&
        pending.state === "delivering" &&
        !pending.deliveryAcknowledged
      ) {
        send(
          socket,
          createEnvelope("agent.deliver", pending.request) as BrokerEnvelope,
        );
      }
    }
  }

  function resendPendingApprovals(targetClientId: string, socket: Socket): void {
    for (const pending of pendingRequests.values()) {
      if (
        pending.targetClientId === targetClientId &&
        pending.state === "awaiting_approval"
      ) {
        send(socket, createEnvelope("request.pending", pending.request) as BrokerEnvelope);
      }
    }
  }

  function handleRequestDecision(
    clientId: string,
    socket: Socket,
    requestId: string,
    approve: boolean,
  ): void {
    const pending = pendingRequests.get(requestId);
    if (pending?.targetClientId === clientId && pending.state === "delivering") {
      return;
    }
    if (pending === undefined) {
      if (resolvedApprovalRequests.get(requestId) === clientId) return;
      sendError(socket, {
        code: "request_invalid",
        message: "请求已失效或不存在",
        requestId,
      });
      return;
    }
    if (
      pending.targetClientId !== clientId ||
      pending.state !== "awaiting_approval"
    ) {
      sendError(socket, {
        code: "request_invalid",
        message: "不能处理其他 Agent 的请求",
        requestId,
      });
      return;
    }

    if (approve) {
      if (!db().approveRequest(requestId)) {
        sendError(socket, {
          code: "request_invalid",
          message: "请求已失效",
          requestId,
        });
        return;
      }
      pending.state = "delivering";
      updatePendingApprovalCount(clientId);
      broadcastRequestMessageStatus(pending);
      const targetSocket = clients.get(clientId);
      if (targetSocket !== undefined) {
        send(
          targetSocket,
          createEnvelope("agent.deliver", pending.request) as BrokerEnvelope,
        );
      }
      return;
    }

    if (!db().rejectRequest(requestId)) {
      sendError(socket, {
        code: "request_invalid",
        message: "请求已失效",
        requestId,
      });
      return;
    }
    pendingRequests.delete(requestId);
    resolvedApprovalRequests.set(requestId, clientId);
    closedRequestIds.add(requestId);
    updatePendingApprovalCount(clientId);
    if (pending.message.kind === "agent") {
      pending.message.routeStatus = "failed";
      pending.message.routeFailureReason = "request_rejected";
      broadcastToGroup(pending.groupId, messageEnvelope(pending.message));
    } else {
      broadcastFailure({
        requestId,
        groupId: pending.groupId,
        targetName: pending.targetName,
        targetAgentId: pending.targetAgentId,
        reason: "request_rejected",
      });
    }
  }

  function updatePendingApprovalCount(clientId: string): void {
    const count = [...pendingRequests.values()].filter(
      (pending) =>
        pending.targetClientId === clientId &&
        pending.state === "awaiting_approval",
    ).length;
    const agent = groups.setPendingApprovalCount(clientId, count);
    if (agent !== undefined) broadcastPresence([agent]);
  }

  function handleAgentResult(
    clientId: string,
    socket: Socket,
    result: AgentResultPayload,
  ): void {
    if (
      completedRequests.get(result.requestId) === clientId ||
      db().requestStatus(result.requestId) === "completed"
    ) {
      sendResultAck(socket, result.requestId, true);
      return;
    }
    const pending = pendingRequests.get(result.requestId);
    if (pending === undefined || pending.targetClientId !== clientId) {
      sendResultAck(socket, result.requestId, false);
      return;
    }

    if (result.ok) {
      const sourceMembership = groups.membershipForClient(clientId);
      const mention = parseMentions(result.text.trimStart());
      const resolved = mention?.names.map((name) => ({
        name,
        member: groups.findMemberByName(pending.groupId, name),
      })) ?? [];
      const targets = [...new Map(resolved.flatMap(({ member }) =>
        member?.type === "agent" ? [[member.memberId, member] as const] : []
      )).values()];
      const unknownNames = [...new Set(resolved.filter(({ member }) => member === undefined)
        .map(({ name }) => name))];
      const nextRound = pending.request.round + 1;
      const participants = [...new Set([
        ...pending.context.participants,
        ...targets.map(({ displayName }) => displayName),
      ])];
      const answerPayload: ChatMessagePayload = {
        groupId: pending.groupId,
        groupSeq: db().nextGroupSeq(pending.groupId),
        senderId: pending.request.targetAgentId,
        senderName: pending.request.targetAgentName,
        senderType: "agent",
        text: result.text,
        mentionIds: resolved.length === 0
          ? [pending.request.senderId]
          : [...new Set(resolved.flatMap(({ member }) => member === undefined ? [] : [member.memberId]))],
        requestId: result.requestId,
        kind: "agent",
        status: "sent",
        chainId: pending.request.chainId,
        round: pending.request.round,
      };
      let next:
        | {
            requests: Array<{
              request: AgentRequestPayload;
              awaitingApproval: boolean;
              context: AgentChainContext;
              targetClientId: string;
            }>;
            failed: Parameters<BrokerDatabase["insertAgentRequestBatch"]>[2];
          }
        | { paused: StoredPausedChain }
        | undefined;
      const taskText = mention?.text?.trim() ?? "";
      if (targets.length > 0 || unknownNames.length > 0) {
        answerPayload.nextRound = nextRound;
        if (nextRound > pending.context.roundLimit && targets.length > 0) {
          const target = targets[0]!;
          answerPayload.routeStatus = "paused";
          answerPayload.routeTargetName = targets.map(({ displayName }) => displayName).join("、");
          next = { paused: {
            chainId: pending.request.chainId, groupId: pending.groupId,
            messageId: "", initiatorSessionKey: pending.context.initiatorSessionKey,
            initiatorName: pending.context.initiatorName,
            sourceAgentName: pending.request.targetAgentName,
            sourceOwnerUserName: sourceMembership?.user.displayName ?? "",
            targetAgentId: target.memberId, targetAgentName: target.displayName,
            text: taskText, nextRound, roundLimit: pending.context.roundLimit,
            participants, pausedAt: 0,
          } };
        } else {
          const requests: Extract<typeof next, { requests: unknown }>["requests"] = [];
          const failed: Parameters<BrokerDatabase["insertAgentRequestBatch"]>[2] = [];
          const deliveries: NonNullable<ChatMessagePayload["deliveries"]> = [];
          for (const target of targets) {
            const nextRequestId = randomUUID();
            const targetSocket = clients.get(target.clientId);
            const targetMembership = groups.membershipForClient(target.clientId);
            const permission = permissions.get(target.clientId) ?? "auto";
            const failure = target.memberId === pending.request.targetAgentId
              ? "target_self" as const
              : taskText === "" ? "empty_mention" as const
              : !target.online || targetSocket === undefined || targetMembership === undefined
                ? "target_offline" as const
                : permission === "blocked" ? "target_blocked" as const : undefined;
            if (failure !== undefined || targetMembership === undefined) {
              failed.push({
                initiatorSessionKey: pending.context.initiatorSessionKey,
                requestId: nextRequestId, groupId: pending.groupId, messageId: "",
                senderId: pending.request.targetAgentId,
                senderName: pending.request.targetAgentName, targetAgentId: target.memberId,
                targetAgentName: target.displayName, text: taskText,
                chainId: pending.request.chainId, round: nextRound, failureReason: failure ?? "target_offline",
              });
              deliveries.push({ requestId: nextRequestId, targetAgentId: target.memberId,
                targetAgentName: target.displayName, status: "failed",
                failureReason: failure ?? "target_offline" });
              continue;
            }
            const awaitingApproval = permission === "approval";
            const request: AgentRequestPayload = {
              requestId: nextRequestId, groupId: pending.groupId,
              groupName: pending.request.groupName, senderId: pending.request.targetAgentId,
              senderName: pending.request.targetAgentName, senderType: "agent",
              ...(sourceMembership === undefined ? {} : {
                senderOwnerUserName: sourceMembership.user.displayName,
              }),
              targetAgentId: target.memberId, targetAgentName: target.displayName,
              ownerUserName: targetMembership.user.displayName,
              onlineMembers: groups.onlineMembers(pending.groupId)
                .filter((member) => member.memberId !== target.memberId)
                .map((member) => ({ displayName: member.displayName, type: member.type })),
              participants: participantDirectory(pending.groupId), coRecipients: [],
              text: taskText, chainId: pending.request.chainId, round: nextRound,
              createdAt: Date.now(),
            };
            requests.push({ request, awaitingApproval,
              context: { ...pending.context, participants }, targetClientId: target.clientId });
            deliveries.push({ requestId: nextRequestId, targetAgentId: target.memberId,
              targetAgentName: target.displayName,
              status: awaitingApproval ? "waiting_approval" : "queued" });
          }
          for (const name of unknownNames) {
            const nextRequestId = randomUUID();
            failed.push({
              initiatorSessionKey: pending.context.initiatorSessionKey,
              requestId: nextRequestId, groupId: pending.groupId, messageId: "",
              senderId: pending.request.targetAgentId, senderName: pending.request.targetAgentName,
              targetAgentName: name, text: taskText, chainId: pending.request.chainId,
              round: nextRound, failureReason: "target_not_found",
            });
            deliveries.push({ requestId: nextRequestId, targetAgentName: name,
              status: "failed", failureReason: "target_not_found" });
          }
          const recipients = requests.map(({ request }) => ({
            agentId: request.targetAgentId, name: request.targetAgentName,
          }));
          for (const item of requests) item.request.coRecipients = recipients.filter(
            ({ agentId }) => agentId !== item.request.targetAgentId,
          );
          if (deliveries.length > 1) answerPayload.deliveries = deliveries;
          if (deliveries.length === 1) {
            const delivery = deliveries[0]!;
            answerPayload.routeRequestId = delivery.requestId;
            answerPayload.routeTargetName = delivery.targetAgentName;
            answerPayload.routeStatus = delivery.status === "failed" ? "failed" : delivery.status;
            answerPayload.routeFailureReason = delivery.failureReason;
          }
          next = { requests, failed };
        }
      }

      const answer = createEnvelope("chat.message", answerPayload);
      const storedAnswer = historyMessage(answer.id, answer.timestamp, answer.payload, "sent");
      if (next !== undefined && "paused" in next) {
        next.paused.messageId = answer.id;
        next.paused.pausedAt = answer.timestamp;
      } else if (next !== undefined) {
        for (const failed of next.failed) failed.messageId = answer.id;
      }
      try {
        db().completeAndRoute(result.requestId, storedAnswer, next);
      } catch {
        sendResultAck(socket, result.requestId, false);
        return;
      }
      pendingRequests.delete(result.requestId);
      completedRequests.set(result.requestId, clientId);
      broadcastRequestMessageStatus(pending);
      broadcastToGroup(pending.groupId, answer as BrokerEnvelope);

      if (next !== undefined && "requests" in next) {
        for (const item of next.requests) {
          pendingRequests.set(item.request.requestId, {
            targetClientId: item.targetClientId, targetAgentId: item.request.targetAgentId,
            targetName: item.request.targetAgentName, groupId: item.request.groupId,
            request: item.request, message: storedAnswer,
            state: item.awaitingApproval ? "awaiting_approval" : "delivering",
            deliveryAcknowledged: false, context: item.context,
          });
          const targetSocket = clients.get(item.targetClientId);
          if (targetSocket !== undefined) send(targetSocket, createEnvelope(
            item.awaitingApproval ? "request.pending" : "agent.deliver", item.request,
          ) as BrokerEnvelope);
          if (item.awaitingApproval) updatePendingApprovalCount(item.targetClientId);
        }
      } else if (next !== undefined && "paused" in next) {
        sendPausedChain(next.paused);
      }
    } else {
      try {
        if (!db().failRequest(result.requestId, result.reason)) {
          sendResultAck(socket, result.requestId, false);
          return;
        }
      } catch {
        sendResultAck(socket, result.requestId, false);
        return;
      }
      pendingRequests.delete(result.requestId);
      completedRequests.set(result.requestId, clientId);
      if (pending.message.kind === "agent") {
        pending.message.routeStatus = "failed";
        pending.message.routeFailureReason = result.reason;
        broadcastToGroup(pending.groupId, messageEnvelope(pending.message));
      } else {
        broadcastFailure({
          requestId: result.requestId,
          groupId: pending.groupId,
          targetName: pending.targetName,
          targetAgentId: pending.targetAgentId,
          reason: result.reason,
        });
      }
    }
    sendResultAck(socket, result.requestId, true);
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

  function broadcastRequestMessageStatus(pending: PendingRequest): void {
    const refreshed = db().message(pending.message.messageId);
    if (refreshed === undefined) return;
    for (const current of pendingRequests.values()) {
      if (current.message.messageId === refreshed.messageId) current.message = refreshed;
    }
    broadcastToGroup(pending.groupId, messageEnvelope(refreshed));
  }

  function failRequestsForTarget(
    targetClientId: string,
    reason: "target_offline" | "target_disconnected",
  ): void {
    for (const [requestId, pending] of pendingRequests) {
      if (pending.targetClientId !== targetClientId) {
        continue;
      }
      pendingRequests.delete(requestId);
      closedRequestIds.add(requestId);
      const failureReason =
        pending.state === "awaiting_approval" ? "request_invalid" : reason;
      if (!db().failRequest(requestId, failureReason)) {
        continue;
      }
      if (pending.message.kind === "agent") {
        pending.message.routeStatus = "failed";
        pending.message.routeFailureReason = failureReason;
        broadcastToGroup(pending.groupId, messageEnvelope(pending.message));
      } else {
        broadcastFailure({
          requestId,
          groupId: pending.groupId,
          targetName: pending.targetName,
          targetAgentId: pending.targetAgentId,
          reason: failureReason,
        });
      }
    }
    updatePendingApprovalCount(targetClientId);
  }

  function handleChainDecision(
    clientId: string,
    socket: Socket,
    chainId: string,
    resume: boolean,
  ): void {
    const paused = db().pausedChain(chainId);
    const sessionKey = sessionKeyForClient(clientId);
    const group = groups.groupForClient(clientId);
    if (
      paused === undefined ||
      sessionKey === undefined ||
      paused.initiatorSessionKey !== sessionKey ||
      group?.groupId !== paused.groupId
    ) {
      sendError(socket, {
        code: "request_invalid",
        message: "不能处理其他 Session 或群组的自动对话",
        requestId: chainId,
      });
      return;
    }
    const message = db().message(paused.messageId);
    if (message === undefined) {
      sendError(socket, { code: "request_invalid", message: "通信链消息不存在", requestId: chainId });
      return;
    }

    if (!resume) {
      const ended = { ...message, routeStatus: "ended" as const };
      if (!db().resolvePausedChain(chainId, ended)) return;
      broadcastToGroup(paused.groupId, messageEnvelope(ended));
      broadcastChainResolved(paused, "ended");
      return;
    }

    const parsed = parseMentions(message.text.trimStart());
    const names = parsed?.names ?? [paused.targetAgentName];
    const taskText = parsed?.text?.trim() || paused.text;
    const resolved = names.map((name) => ({
      name,
      member: groups.findMemberByName(paused.groupId, name),
    }));
    const targets = [...new Map(resolved.flatMap(({ member }) =>
      member?.type === "agent" ? [[member.memberId, member] as const] : []
    )).values()];
    const unknownNames = [...new Set(resolved.filter(({ member }) => member === undefined)
      .map(({ name }) => name))];
    const roundLimit = paused.roundLimit + 10;
    const context: AgentChainContext = {
      initiatorSessionKey: paused.initiatorSessionKey,
      initiatorName: paused.initiatorName,
      participants: paused.participants,
      roundLimit,
    };
    const requests: Array<{
      request: AgentRequestPayload; awaitingApproval: boolean;
      context: AgentChainContext; targetClientId: string;
    }> = [];
    const failed: Parameters<BrokerDatabase["insertAgentRequestBatch"]>[2] = [];
    const deliveries: NonNullable<ChatMessagePayload["deliveries"]> = [];
    for (const target of targets) {
      const requestId = randomUUID();
      const targetMembership = groups.membershipForClient(target.clientId);
      const permission = permissions.get(target.clientId) ?? "auto";
      const failure = target.memberId === message.senderId ? "target_self" as const :
        !target.online || clients.get(target.clientId) === undefined || targetMembership === undefined
          ? "target_offline" as const :
        permission === "blocked" ? "target_blocked" as const : undefined;
      if (failure !== undefined || targetMembership === undefined) {
        failed.push({
          initiatorSessionKey: paused.initiatorSessionKey, requestId,
          groupId: paused.groupId, messageId: paused.messageId,
          senderId: message.senderId, senderName: paused.sourceAgentName,
          targetAgentId: target.memberId, targetAgentName: target.displayName,
          text: taskText, chainId, round: paused.nextRound,
          failureReason: failure ?? "target_offline",
        });
        deliveries.push({ requestId, targetAgentId: target.memberId,
          targetAgentName: target.displayName, status: "failed",
          failureReason: failure ?? "target_offline" });
        continue;
      }
      const awaitingApproval = permission === "approval";
      const request: AgentRequestPayload = {
        requestId, groupId: paused.groupId, groupName: group.groupName,
        senderId: message.senderId, senderName: paused.sourceAgentName,
        senderType: "agent", senderOwnerUserName: paused.sourceOwnerUserName,
        targetAgentId: target.memberId, targetAgentName: target.displayName,
        ownerUserName: targetMembership.user.displayName,
        onlineMembers: groups.onlineMembers(paused.groupId)
          .filter((member) => member.memberId !== target.memberId)
          .map((member) => ({ displayName: member.displayName, type: member.type })),
        participants: participantDirectory(paused.groupId), coRecipients: [],
        text: taskText, chainId, round: paused.nextRound, createdAt: Date.now(),
      };
      requests.push({ request, awaitingApproval, context, targetClientId: target.clientId });
      deliveries.push({ requestId, targetAgentId: target.memberId,
        targetAgentName: target.displayName,
        status: awaitingApproval ? "waiting_approval" : "queued" });
    }
    for (const name of unknownNames) {
      const requestId = randomUUID();
      failed.push({
        initiatorSessionKey: paused.initiatorSessionKey, requestId,
        groupId: paused.groupId, messageId: paused.messageId,
        senderId: message.senderId, senderName: paused.sourceAgentName,
        targetAgentName: name, text: taskText, chainId, round: paused.nextRound,
        failureReason: "target_not_found",
      });
      deliveries.push({ requestId, targetAgentName: name, status: "failed",
        failureReason: "target_not_found" });
    }
    const recipients = requests.map(({ request }) => ({
      agentId: request.targetAgentId, name: request.targetAgentName,
    }));
    for (const item of requests) item.request.coRecipients = recipients.filter(
      ({ agentId }) => agentId !== item.request.targetAgentId,
    );
    const updated: HistoryMessage = { ...message, routeFailureReason: undefined };
    if (deliveries.length > 1) {
      updated.deliveries = deliveries;
      updated.routeRequestId = undefined;
      updated.routeTargetName = undefined;
      updated.routeStatus = undefined;
    } else {
      const delivery = deliveries[0];
      updated.routeRequestId = delivery?.requestId;
      updated.routeTargetName = delivery?.targetAgentName;
      updated.routeStatus = delivery === undefined ? "failed" :
        delivery.status === "failed" ? "failed" : delivery.status;
      updated.routeFailureReason = delivery?.failureReason ??
        (delivery === undefined ? "target_not_found" : undefined);
    }
    try {
      db().resumePausedChain(
        paused,
        requests.map(({ request, awaitingApproval, context }) => ({
          request, awaitingApproval, context,
        })),
        failed,
        updated,
      );
    } catch (error) {
      sendGroupError(socket, chainId, error);
      return;
    }
    for (const item of requests) pendingRequests.set(item.request.requestId, {
      targetClientId: item.targetClientId, targetAgentId: item.request.targetAgentId,
      targetName: item.request.targetAgentName, groupId: paused.groupId,
      request: item.request, message: updated,
      state: item.awaitingApproval ? "awaiting_approval" : "delivering",
      deliveryAcknowledged: false, context,
    });
    broadcastToGroup(paused.groupId, messageEnvelope(updated));
    broadcastChainResolved({ ...paused, roundLimit }, requests.length > 0 ? "continued" : "failed");
    for (const item of requests) {
      const targetSocket = clients.get(item.targetClientId);
      if (targetSocket !== undefined) send(targetSocket, createEnvelope(
        item.awaitingApproval ? "request.pending" : "agent.deliver", item.request,
      ) as BrokerEnvelope);
      if (item.awaitingApproval) updatePendingApprovalCount(item.targetClientId);
    }
  }

  function broadcastChainResolved(
    paused: StoredPausedChain,
    action: "continued" | "ended" | "failed",
  ): void {
    broadcastToGroup(paused.groupId, createEnvelope("chain.resolved", {
      chainId: paused.chainId,
      action,
      initiatorName: paused.initiatorName,
      roundLimit: paused.roundLimit,
    }) as BrokerEnvelope);
  }

  function sendPausedChain(paused: StoredPausedChain): void {
    const ownerSocket = sessions.get(paused.initiatorSessionKey)?.socket;
    if (ownerSocket === undefined) return;
    const { messageId: _messageId, initiatorSessionKey: _sessionKey,
      targetAgentId: _targetAgentId, ...payload } = paused;
    send(ownerSocket, createEnvelope("chain.paused", payload) as BrokerEnvelope);
  }

  function sessionKeyForClient(clientId: string): SessionKey | undefined {
    for (const [sessionKey, session] of sessions) {
      if (session.clientId === clientId) return sessionKey;
    }
    return undefined;
  }

  function messageEnvelope(message: HistoryMessage): BrokerEnvelope {
    return {
      id: message.messageId,
      type: "chat.message",
      timestamp: message.timestamp,
      payload: message,
    } as BrokerEnvelope;
  }

  function sendSnapshot(clientId: string, socket: Socket): void {
    const group = groups.groupForClient(clientId);
    const sessionKey = sessionKeyForClient(clientId);
    const storedGroup = group === undefined ? undefined : db().storedGroup(group.groupId);
    send(
      socket,
      createEnvelope("snapshot", {
        brokerInstanceId: instanceId,
        clientId,
        proactiveStatus: currentProactiveStatus(),
        ...(groups.membershipForClient(clientId)?.agent.proactiveEnabled === undefined
          ? {}
          : {
              ownProactiveEnabled:
                groups.membershipForClient(clientId)!.agent.proactiveEnabled,
            }),
        groups: isLoopback(socket.remoteAddress)
          ? groups.summaries()
          : nearbyGroupSummaries(),
        ...(group === undefined ? {} : { group }),
        ...(storedGroup === undefined
          ? {}
          : {
              groupSettings: {
                groupId: storedGroup.groupId,
                groupName: storedGroup.groupName,
                visibility: storedGroup.visibility,
                inviteRequired: storedGroup.inviteRequired,
                keepAvailableWhenEmpty: storedGroup.keepAvailableWhenEmpty,
                openAtLogin: storedGroup.openAtLogin,
              },
              isOwner: storedGroup.ownerSessionKey === sessionKey,
              ownerRecoveryAvailable:
                isLoopback(socket.remoteAddress) &&
                storedGroup.ownerSessionKey !== sessionKey,
            }),
        members: group === undefined ? [] : snapshotMembers(group.groupId),
        messages:
          group === undefined ? [] : db().recentMessages(group.groupId),
        pausedChains:
          group === undefined || sessionKey === undefined
            ? []
            : db().pausedChains(sessionKey, group.groupId).map((paused) => {
                const { messageId: _messageId, initiatorSessionKey: _owner,
                  targetAgentId: _target, ...payload } = paused;
                return payload;
              }),
      }) as BrokerEnvelope,
    );
  }

  function nearbyGroupSummaries() {
    const nearby = new Map(
      db().storedGroups()
        .filter((group) => group.visibility === "nearby")
        .map((group) => [group.groupId, group] as const),
    );
    return groups.summaries()
      .filter((group) => nearby.has(group.groupId))
      .map((group) => ({
        ...group,
        inviteRequired: nearby.get(group.groupId)!.inviteRequired,
      }));
  }

  function snapshotMembers(groupId: string): Member[] {
    const online = groups.members(groupId);
    const result: Member[] = [];
    for (const stored of db().memberships(groupId)) {
      const currentUser = online.find(
        (member) =>
          member.type === "user" &&
          member.displayName.toLocaleLowerCase("en-US") ===
            stored.userName.toLocaleLowerCase("en-US"),
      );
      const currentAgent = currentUser === undefined
        ? undefined
        : online.find(
            (member) =>
              member.type === "agent" &&
              member.clientId === currentUser.clientId,
          );
      result.push(
        {
          ...(currentUser === undefined ? {
            memberId: `user:${stored.sessionKey}`,
            clientId: stored.sessionKey,
            type: "user" as const,
            displayName: stored.userName,
            groupId,
            online: false,
          } : publicMember(currentUser)),
          stableSessionKey: stored.sessionKey,
          lastActiveAt: stored.lastActiveAt,
          isOwner: db().storedGroup(groupId)?.ownerSessionKey === stored.sessionKey,
          ...(stored.status === "removed" ? { removed: true, online: false } : {}),
        },
        {
          ...(currentAgent === undefined ? {
            memberId: `agent:${stored.sessionKey}`,
            clientId: stored.sessionKey,
            type: "agent" as const,
            displayName: stored.agentName,
            groupId,
            online: false,
            agentStatus: "idle" as const,
            agentPermission: "auto" as const,
            pendingApprovalCount: 0,
            agentDescription: stored.agentDescription,
          } : publicMember(currentAgent)),
          agentDescription: stored.agentDescription,
          stableSessionKey: stored.sessionKey,
          lastActiveAt: stored.lastActiveAt,
          ...(stored.status === "removed" ? { removed: true, online: false } : {}),
        },
      );
    }
    return result;
  }

  function participantDirectory(groupId: string) {
    return participantContext(snapshotMembers(groupId));
  }

  function requireOwner(
    sessionKey: SessionKey,
    socket: Socket,
    requestId: string,
    payload: { groupId: string; ownerCredential: string },
  ): boolean {
    const group = db().storedGroup(payload.groupId);
    if (
      group === undefined ||
      group.ownerSessionKey !== sessionKey ||
      group.ownerCredentialHash !== hashSecret(payload.ownerCredential)
    ) {
      sendError(socket, {
        code: "owner_required",
        message: "只有群主可以执行此操作",
        requestId,
      });
      return false;
    }
    return true;
  }

  function sendSnapshotsForGroup(groupId: string): void {
    for (const targetClientId of groups.onlineClientIds(groupId)) {
      const targetSocket = clients.get(targetClientId);
      if (targetSocket !== undefined) sendSnapshot(targetClientId, targetSocket);
    }
  }

  function disconnectRemoteGroupMembers(groupId: string): void {
    for (const targetClientId of groups.onlineClientIds(groupId)) {
      const targetSocket = clients.get(targetClientId);
      if (targetSocket === undefined || isLoopback(targetSocket.remoteAddress)) continue;
      const removed = groups.removeIfJoined(targetClientId);
      if (removed === undefined) continue;
      sendError(targetSocket, {
        code: "invite_invalid",
        message: "群主已停止向附近设备开放这个群组",
      });
      sendSnapshot(targetClientId, targetSocket);
    }
    broadcastGroupsChanged();
    scheduleIdleShutdown();
  }

  function broadcastPresence(members: Member[], excludeClientId?: string): void {
    for (const member of members) {
      broadcastToGroup(
        member.groupId,
        createEnvelope("presence.changed", publicMember(member)) as BrokerEnvelope,
        excludeClientId,
      );
    }
  }

  function publicMember(member: Member): Member {
    const { proactiveEnabled: _proactiveEnabled, ...visible } = member;
    return visible;
  }

  function broadcastGroupsChanged(): void {
    for (const socket of clients.values()) {
      send(socket, createEnvelope("groups.changed", {
        groups: isLoopback(socket.remoteAddress)
          ? groups.summaries()
          : nearbyGroupSummaries(),
      }) as BrokerEnvelope);
    }
  }

  function broadcastPresenceRemoved(
    groupId: string,
    memberIds: string[],
  ): void {
    broadcastToGroup(
      groupId,
      createEnvelope("presence.removed", { groupId, memberIds }) as BrokerEnvelope,
    );
  }

  function broadcastFailure(payload: SendFailedPayload): void {
    broadcastToGroup(
      payload.groupId,
      createEnvelope("send.failed", payload) as BrokerEnvelope,
    );
  }

  function broadcastToGroup(
    groupId: string,
    envelope: BrokerEnvelope,
    excludeClientId?: string,
  ): void {
    for (const clientId of groups.onlineClientIds(groupId)) {
      if (clientId !== excludeClientId) {
        const socket = clients.get(clientId);
        if (socket !== undefined) {
          send(socket, envelope);
        }
      }
    }
  }

  function sendGroupError(
    socket: Socket,
    requestId: string,
    error: unknown,
  ): void {
    if (error instanceof GroupStateError) {
      sendError(socket, {
        code: error.code,
        message: error.message,
        requestId,
      });
      return;
    }
    sendError(socket, {
      code: "database_error",
      message: error instanceof Error ? error.message : "数据库操作失败",
      requestId,
    });
  }

  function sendError(socket: Socket, payload: ErrorPayload): void {
    send(socket, createEnvelope("error", payload) as BrokerEnvelope);
  }

  async function start(): Promise<void> {
    if (started) {
      return;
    }
    if (dbPath === DEFAULT_DATABASE_PATH) await assertNoLiveLegacyBroker();
    processLock = await acquireBrokerProcessLock(dbPath);
    try {
      database = new BrokerDatabase(dbPath, deviceId);
      stableBrokerId = database.brokerId();
      groups = new GroupState(database.groups());
      const configSnapshot = proactiveConfig.load();
      proactive = createProactiveCoordinator();
      if (
        configSnapshot.proactiveStatus === "unverified" &&
        configSnapshot.apiKey !== undefined
      ) {
        void proactiveScheduler.schedule("validation", (signal) =>
          proactiveProvider.validate(configSnapshot.apiKey!, signal)
        ).then(() => {
          if (proactiveConfig.snapshot().configVersion !== configSnapshot.configVersion) return;
          proactiveConfig.saveVerified(configSnapshot.apiKey!);
          broadcastConfigStatus();
        }).catch((error: unknown) => {
          if (
            error instanceof ProactiveProviderError &&
            error.kind === "invalid_key" &&
            proactiveConfig.snapshot().configVersion === configSnapshot.configVersion
          ) {
            proactiveConfig.markInvalid();
            broadcastConfigStatus();
          }
        });
      }
      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          rejectStart(error.code === "EADDRINUSE"
            ? new Error(`Broker 端口已被占用：${formatEndpoint(listen)}`)
            : error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo;
          endpoint = { host: listen.host, port: address.port };
          resolveStart();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ ...listen, exclusive: true });
      });
      await writeBrokerRuntimeMetadata(dbPath, {
        brokerId: stableBrokerId,
        brokerInstanceId: instanceId,
        pid: process.pid,
        host: endpoint.host,
        port: endpoint.port,
        mode,
        appVersion: PI_COMMS_VERSION,
        buildChannel: PI_COMMS_BUILD_CHANNEL,
        startedAt: Date.now(),
      });
      await refreshNetworkAccess();
      if (mode === "lan-host") {
        networkRefreshTimer = setInterval(() => {
          const networkKey = primaryOrdinaryNetwork()?.networkKey;
          if (networkKey === observedNetworkKey) return;
          void refreshNetworkAccess().catch(() => undefined);
        }, 2_000);
        networkRefreshTimer.unref?.();
      }
      if (
        mode === "lan-host" &&
        database.storedGroups().some((group) => group.keepAvailableWhenEmpty)
      ) {
        await syncBackgroundSupervisor();
      }
      started = true;
      closing = false;
      scheduleIdleShutdown();
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
      database?.close();
      database = undefined;
      await mdnsPublisher?.stop();
      mdnsPublisher = undefined;
      await processLock.release();
      processLock = undefined;
      throw error;
    }
  }

  async function refreshNetworkAccess(): Promise<{
    allowed: boolean;
    address?: string;
  }> {
    await mdnsPublisher?.stop();
    mdnsPublisher = undefined;
    if (mode !== "lan-host") {
      networkAccessAllowed = true;
      networkAccessAddress = undefined;
      return { allowed: true };
    }
    const network = primaryOrdinaryNetwork();
    observedNetworkKey = network?.networkKey;
    networkAccessAllowed =
      !networkAccessRequired ||
      (
        network !== undefined &&
        await networkAccessStore.isConfirmed(network)
      );
    networkAccessAddress = networkAccessAllowed ? network?.address : undefined;
    const hasNearbyGroups = database?.storedGroups()
      .some((group) => group.visibility === "nearby") === true;
    if (networkAccessAllowed && publishMdns && hasNearbyGroups) {
      mdnsPublisher = mdnsPublisherFactory({
        brokerId: stableBrokerId,
        port: endpoint.port,
        interfaceAddress: network!.address,
      });
    }
    return {
      allowed: networkAccessAllowed,
      ...(network === undefined ? {} : { address: network.address }),
    };
  }

  async function syncBackgroundSupervisor(): Promise<void> {
    const storedGroups = db().storedGroups();
    await updateAutostart(
      storedGroups.some((group) => group.keepAvailableWhenEmpty),
      storedGroups.some((group) => group.openAtLogin),
      dbPath,
    );
  }

  async function close(): Promise<void> {
    if (!started || closing) {
      return;
    }
    closing = true;
    clearIdleShutdown();
    if (networkRefreshTimer !== undefined) {
      clearInterval(networkRefreshTimer);
      networkRefreshTimer = undefined;
    }
    for (const session of sessions.values()) {
      if (session.disconnectTimer !== undefined) {
        clearTimeout(session.disconnectTimer);
      }
      if (session.heartbeatTimer !== undefined) {
        clearTimeout(session.heartbeatTimer);
      }
      session.socket?.destroy();
    }
    clients.clear();
    sessions.clear();
    pendingRequests.clear();
    proactive?.clear();
    proactiveScheduler.abortAll();
    proactive = undefined;
    proactiveCursors.clear();
    await mdnsPublisher?.stop();
    mdnsPublisher = undefined;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    started = false;
    database?.close();
    database = undefined;
    await removeBrokerRuntimeMetadata(dbPath, instanceId);
    await processLock?.release();
    processLock = undefined;
  }

  function db(): BrokerDatabase {
    if (database === undefined) {
      throw new Error("Broker 数据库尚未启动");
    }
    return database;
  }

  function clearIdleShutdown(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function scheduleIdleShutdown(): void {
    clearIdleShutdown();
    if (
      closing ||
      clients.size > 0 ||
      db().storedGroups().some((group) => group.keepAvailableWhenEmpty)
    ) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (
        clients.size === 0 &&
        !db().storedGroups().some((group) => group.keepAvailableWhenEmpty)
      ) {
        void close();
      }
    }, idleShutdownMs);
    idleTimer.unref?.();
  }

  return {
    get endpoint() { return endpoint; },
    dbPath,
    instanceId,
    get brokerId() { return stableBrokerId; },
    mode,
    start,
    close,
  };
}

export function parseMentions(
  text: string,
): { names: string[]; text?: string } | undefined {
  if (!text.startsWith("@")) return undefined;
  const names: string[] = [];
  let rest = text;
  while (rest.startsWith("@")) {
    const match = rest.match(/^@([^\s]+)(?:[ \t]+|$)/u);
    if (match === null) break;
    names.push(match[1]!);
    rest = rest.slice(match[0].length);
  }
  return names.length === 0
    ? undefined
    : { names, ...(rest === "" ? {} : { text: rest }) };
}

function parseMention(text: string): { name: string; text?: string } | undefined {
  const parsed = parseMentions(text);
  return parsed === undefined
    ? undefined
    : { name: parsed.names[0]!, ...(parsed.text === undefined ? {} : { text: parsed.text }) };
}

function send(socket: Socket, envelope: Envelope): void {
  if (!socket.destroyed) {
    socket.write(encodeEnvelope(envelope));
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === undefined ||
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.");
}

export function isAddressOnOrdinaryNetwork(
  remoteAddress: string | undefined,
  ordinaryAddress: string | undefined,
): boolean {
  if (remoteAddress === undefined || ordinaryAddress === undefined) return false;
  const remote = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  const remoteParts = remote.split(".");
  const ordinaryParts = ordinaryAddress.split(".");
  return remoteParts.length === 4 &&
    ordinaryParts.length === 4 &&
    remoteParts.slice(0, 3).join(".") === ordinaryParts.slice(0, 3).join(".");
}

function createCredential(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
