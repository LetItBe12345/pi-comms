import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDeviceId } from "../device-identity.js";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
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
  type GroupJoinPayload,
  type HistoryMessage,
  type PausedChainPayload,
  type SendFailedPayload,
} from "../protocol.js";
import { createSessionKey, type SessionKey } from "../session-key.js";
import {
  publishBrokerMdns,
  type MdnsPublisher,
} from "../discovery/mdns.js";
import { primaryOrdinaryNetwork } from "../discovery/network.js";
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
  const clients = new Map<string, Socket>();
  const sessions = new Map<SessionKey, ClientSession>();
  let groups = new GroupState();
  let database: BrokerDatabase | undefined;
  const pendingRequests = new Map<string, PendingRequest>();
  const permissions = new Map<string, AgentPermission>();
  const resolvedApprovalRequests = new Map<string, string>();
  const completedRequests = new Map<string, string>();
  const closedRequestIds = new Set<string>();
  const inviteFailures = new Map<string, InviteFailureState>();
  const server = createServer(handleConnection);
  let started = false;
  let closing = false;
  let processLock: BrokerProcessLock | undefined;
  let stableBrokerId = "";
  let mdnsPublisher: MdnsPublisher | undefined;
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
          acceptedProbe = true;
          send(socket, createEnvelope("broker.ready", {
            service: BROKER_SERVICE,
            protocolVersion: BROKER_PROTOCOL_VERSION,
            brokerId: stableBrokerId,
            brokerInstanceId: instanceId,
            brokerMode: mode,
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
    if (envelope.type === "agent.deliver.ack") {
      const pending = pendingRequests.get(envelope.payload.requestId);
      if (pending?.targetClientId === clientId) {
        db().markDelivered(envelope.payload.requestId);
        pending.deliveryAcknowledged = true;
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
      const inviteCode = envelope.payload.visibility === "nearby"
        ? generateInviteCode()
        : undefined;
      db().updateGroupInvite(
        envelope.payload.groupId,
        envelope.payload.visibility,
        inviteCode === undefined ? undefined : hashSecret(inviteCode),
      );
      if (envelope.payload.visibility === "local") {
        disconnectRemoteGroupMembers(envelope.payload.groupId);
      }
      send(socket, createEnvelope("group.invite.updated", {
        groupId: envelope.payload.groupId,
        visibility: envelope.payload.visibility,
        ...(inviteCode === undefined ? {} : { inviteCode }),
      }) as BrokerEnvelope);
      sendSnapshotsForGroup(envelope.payload.groupId);
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
      const shouldAutostart = db().storedGroups().some(
        (stored) => stored.openAtLogin,
      );
      void configureBrokerAutostart(shouldAutostart, dbPath).catch((error) => {
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
      const inviteCode = generateInviteCode();
      db().updateGroupInvite(group.groupId, "nearby", hashSecret(inviteCode));
      send(socket, createEnvelope("group.invite.updated", {
        groupId: group.groupId,
        visibility: "nearby",
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

  function handleGroupCreate(
    sessionKey: SessionKey,
    clientId: string,
    socket: Socket,
    requestId: string,
    payload: {
      groupName: string;
      userName: string;
      agentName: string;
      visibility?: "local" | "nearby";
    },
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
      const membership = groups.createGroup(
        clientId,
        payload.groupName,
        payload.userName,
        payload.agentName,
        undefined,
        sessionKey,
      );
      groupId = membership.groupId;
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
      const visibility = payload.visibility ?? "local";
      const ownerCredential = createCredential();
      const membershipCredential = createCredential();
      const inviteCode = visibility === "nearby" ? generateInviteCode() : undefined;
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
      const storedGroup = db().storedGroup(payload.groupId);
      if (storedGroup === undefined) {
        throw new GroupStateError("group_not_found", "群组不存在");
      }
      let userName: string;
      let agentName: string;
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
        userName = stored.userName;
        agentName = stored.agentName;
        isOwner = storedGroup.ownerSessionKey === sessionKey;
        db().touchMembership(payload.groupId, sessionKey);
      } else {
        const normalizedInvite = payload.inviteCode === undefined
          ? undefined
          : normalizeInviteCode(payload.inviteCode);
        const localEnrollment = normalizedInvite === undefined &&
          isLoopback(socket.remoteAddress);
        if (!localEnrollment && (
          storedGroup.visibility !== "nearby" ||
          storedGroup.inviteCodeHash === undefined ||
          normalizedInvite === undefined ||
          hashSecret(normalizedInvite) !== storedGroup.inviteCodeHash
        )) {
          rejectInvite(socket, requestId, normalizedInvite !== undefined);
          return;
        }
        inviteFailures.delete(socket.remoteAddress ?? "unknown");
        userName = payload.userName!;
        agentName = payload.agentName!;
        if (!db().isMemberNameAvailable(payload.groupId, userName, agentName)) {
          throw new GroupStateError("member_name_conflict", "群组内名称已被使用");
        }
        membershipCredential = createCredential();
        db().insertMembership({
          groupId: payload.groupId,
          sessionKey,
          userName,
          agentName,
          credentialHash: hashSecret(membershipCredential),
        });
      }
      const membership = groups.joinGroup(
        clientId,
        payload.groupId,
        userName,
        agentName,
        isOwner,
        sessionKey,
      );
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
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

    const mention = parseMention(text);
    const target =
      mention === undefined
        ? undefined
        : groups.findMemberByName(group.groupId, mention.name);
    const basePayload = {
      groupId: group.groupId,
      senderId: membership.user.memberId,
      senderName: membership.user.displayName,
      senderType: "user" as const,
      text,
      mentionIds: target === undefined ? [] : [target.memberId],
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
      return;
    }

    const failMention = (
      reason:
        | "target_not_found"
        | "target_offline"
        | "target_blocked"
        | "delivery_failed",
    ): void => {
      const messagePayload: ChatMessagePayload = {
        ...basePayload,
        status: "failed",
        failureReason: reason,
      };
      const message = createEnvelope("chat.message", messagePayload, {
        id: requestId,
      });
      try {
        db().insertFailedAgentRequest(
          historyMessage(
            message.id,
            message.timestamp,
            message.payload,
            "failed",
            reason,
          ),
          {
            initiatorSessionKey: sessionKeyForClient(clientId)!,
            requestId,
            groupId: group.groupId,
            messageId: message.id,
            senderId: membership.user.memberId,
            senderName: membership.user.displayName,
            ...(target?.type === "agent"
              ? { targetAgentId: target.memberId }
              : {}),
            targetAgentName: target?.displayName ?? mention.name,
            ...(target?.type === "agent"
              ? {
                  ownerUserName: groups.membershipForClient(target.clientId)?.user
                    .displayName,
                }
              : {}),
            text: mention.text ?? "",
            chainId: requestId,
            round: 1,
            failureReason: reason,
          },
        );
      } catch (error) {
        sendGroupError(socket, requestId, error);
        return;
      }
      closedRequestIds.add(requestId);
      broadcastToGroup(group.groupId, message as BrokerEnvelope);
      broadcastFailure({
        requestId,
        groupId: group.groupId,
        targetName: target?.displayName ?? mention.name,
        ...(target?.type === "agent" ? { targetAgentId: target.memberId } : {}),
        reason,
      });
    };

    if (target === undefined) {
      failMention("target_not_found");
      return;
    }
    if (!target.online) {
      failMention("target_offline");
      return;
    }
    if (target.type === "user") {
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
      return;
    }
    if (mention.text === undefined || !mention.text.trim()) {
      failMention("delivery_failed");
      return;
    }

    const targetSocket = clients.get(target.clientId);
    const targetMembership = groups.membershipForClient(target.clientId);
    if (targetSocket === undefined || targetMembership === undefined) {
      failMention("target_offline");
      return;
    }
    const permission = permissions.get(target.clientId) ?? "auto";
    if (permission === "blocked") {
      failMention("target_blocked");
      return;
    }
    const request: AgentRequestPayload = {
      requestId,
      groupId: group.groupId,
      groupName: group.groupName,
      senderId: membership.user.memberId,
      senderName: membership.user.displayName,
      senderType: "user",
      targetAgentId: target.memberId,
      targetAgentName: target.displayName,
      ownerUserName: targetMembership.user.displayName,
      onlineMembers: groups
        .onlineMembers(group.groupId)
        .filter((member) => member.memberId !== target.memberId)
        .map((member) => ({
          displayName: member.displayName,
          type: member.type,
        })),
      text: mention.text,
      chainId: requestId,
      round: 1,
      createdAt: Date.now(),
    };
    const context: AgentChainContext = {
      initiatorSessionKey: sessionKeyForClient(clientId) ?? createSessionKey(deviceId, clientId),
      initiatorName: membership.user.displayName,
      participants: [target.displayName],
      roundLimit: 10,
    };
    const awaitingApproval = permission === "approval";
    const message = createEnvelope(
      "chat.message",
      {
        ...basePayload,
        status: awaitingApproval
          ? "waiting_approval" as const
          : "processing" as const,
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
      db().insertAgentRequest(storedMessage, request, awaitingApproval, context);
    } catch (error) {
      sendGroupError(socket, requestId, error);
      return;
    }
    pendingRequests.set(requestId, {
      targetClientId: target.clientId,
      targetAgentId: target.memberId,
      targetName: target.displayName,
      groupId: group.groupId,
      request,
      message: storedMessage,
      state: awaitingApproval ? "awaiting_approval" : "delivering",
      deliveryAcknowledged: false,
      context,
    });
    broadcastToGroup(group.groupId, message as BrokerEnvelope);
    if (awaitingApproval) {
      updatePendingApprovalCount(target.clientId);
      send(targetSocket, createEnvelope("request.pending", request) as BrokerEnvelope);
    } else {
      send(targetSocket, createEnvelope("agent.deliver", request) as BrokerEnvelope);
    }
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
      if (pending.message.kind === "agent") pending.message.routeStatus = "queued";
      else pending.message.status = "queued";
      updatePendingApprovalCount(clientId);
      broadcastToGroup(pending.groupId, {
        id: pending.message.messageId,
        type: "chat.message",
        timestamp: pending.message.timestamp,
        payload: pending.message,
      });
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
      const mention = parseMention(result.text.trimStart());
      const target = mention === undefined
        ? undefined
        : groups.findMemberByName(pending.groupId, mention.name);
      const nextRound = pending.request.round + 1;
      const nextRequestId = randomUUID();
      const participants = target?.type === "agent"
        ? [...new Set([...pending.context.participants, target.displayName])]
        : pending.context.participants;
      const answerPayload: ChatMessagePayload = {
        groupId: pending.groupId,
        senderId: pending.request.targetAgentId,
        senderName: pending.request.targetAgentName,
        senderType: "agent",
        text: result.text,
        mentionIds: target === undefined ? [pending.request.senderId] : [target.memberId],
        requestId: result.requestId,
        kind: "agent",
        status: "sent",
        chainId: pending.request.chainId,
        round: pending.request.round,
      };
      let next:
        | { request: AgentRequestPayload; awaitingApproval: boolean; context: AgentChainContext }
        | { paused: StoredPausedChain }
        | undefined;
      let nextTargetClientId: string | undefined;

      const failRoute = (reason: ChatMessagePayload["routeFailureReason"], name: string): void => {
        answerPayload.routeStatus = "failed";
        answerPayload.routeFailureReason = reason;
        answerPayload.routeTargetName = name;
        answerPayload.nextRound = nextRound;
      };

      if (mention !== undefined) {
        if (target === undefined) {
          failRoute("target_not_found", mention.name);
        } else if (target.type === "agent" && target.memberId === pending.request.targetAgentId) {
          failRoute("target_self", target.displayName);
        } else if (target.type === "agent" && (mention.text === undefined || !mention.text.trim())) {
          failRoute("empty_mention", target.displayName);
        } else if (target.type === "agent") {
          answerPayload.routeTargetName = target.displayName;
          answerPayload.nextRound = nextRound;
          if (nextRound > pending.context.roundLimit) {
            answerPayload.routeStatus = "paused";
          } else if (!target.online) {
            failRoute("target_offline", target.displayName);
          } else {
            const targetSocket = clients.get(target.clientId);
            const targetMembership = groups.membershipForClient(target.clientId);
            const permission = permissions.get(target.clientId) ?? "auto";
            if (targetSocket === undefined || targetMembership === undefined) {
              failRoute("target_offline", target.displayName);
            } else if (permission === "blocked") {
              failRoute("target_blocked", target.displayName);
            } else {
              const awaitingApproval = permission === "approval";
              answerPayload.routeRequestId = nextRequestId;
              answerPayload.routeStatus = awaitingApproval ? "waiting_approval" : "queued";
              const request: AgentRequestPayload = {
                requestId: nextRequestId,
                groupId: pending.groupId,
                groupName: pending.request.groupName,
                senderId: pending.request.targetAgentId,
                senderName: pending.request.targetAgentName,
                senderType: "agent",
                ...(sourceMembership === undefined ? {} : {
                  senderOwnerUserName: sourceMembership.user.displayName,
                }),
                targetAgentId: target.memberId,
                targetAgentName: target.displayName,
                ownerUserName: targetMembership.user.displayName,
                onlineMembers: groups.onlineMembers(pending.groupId)
                  .filter((member) => member.memberId !== target.memberId)
                  .map((member) => ({ displayName: member.displayName, type: member.type })),
                text: mention.text!,
                chainId: pending.request.chainId,
                round: nextRound,
                createdAt: Date.now(),
              };
              next = {
                request,
                awaitingApproval,
                context: { ...pending.context, participants },
              };
              nextTargetClientId = target.clientId;
            }
          }
        }
      }

      const answer = createEnvelope("chat.message", answerPayload);
      const storedAnswer = historyMessage(answer.id, answer.timestamp, answer.payload, "sent");
      if (answerPayload.routeStatus === "paused" && target?.type === "agent") {
        next = { paused: {
          chainId: pending.request.chainId,
          groupId: pending.groupId,
          messageId: answer.id,
          initiatorSessionKey: pending.context.initiatorSessionKey,
          initiatorName: pending.context.initiatorName,
          sourceAgentName: pending.request.targetAgentName,
          sourceOwnerUserName: sourceMembership?.user.displayName ?? "",
          targetAgentId: target.memberId,
          targetAgentName: target.displayName,
          text: mention!.text!,
          nextRound,
          roundLimit: pending.context.roundLimit,
          participants,
          pausedAt: answer.timestamp,
        } };
      }
      try {
        db().completeAndRoute(result.requestId, storedAnswer, next);
      } catch {
        sendResultAck(socket, result.requestId, false);
        return;
      }
      pendingRequests.delete(result.requestId);
      completedRequests.set(result.requestId, clientId);
      broadcastToGroup(pending.groupId, answer as BrokerEnvelope);

      if (next !== undefined && "request" in next && nextTargetClientId !== undefined) {
        const nextPending: PendingRequest = {
          targetClientId: nextTargetClientId,
          targetAgentId: next.request.targetAgentId,
          targetName: next.request.targetAgentName,
          groupId: next.request.groupId,
          request: next.request,
          message: storedAnswer,
          state: next.awaitingApproval ? "awaiting_approval" : "delivering",
          deliveryAcknowledged: false,
          context: next.context,
        };
        pendingRequests.set(next.request.requestId, nextPending);
        const targetSocket = clients.get(nextTargetClientId);
        if (targetSocket !== undefined) {
          send(targetSocket, createEnvelope(
            next.awaitingApproval ? "request.pending" : "agent.deliver",
            next.request,
          ) as BrokerEnvelope);
        }
        if (next.awaitingApproval) updatePendingApprovalCount(nextTargetClientId);
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

    const target = groups.findMemberByName(paused.groupId, paused.targetAgentName);
    const targetMembership = target?.type === "agent"
      ? groups.membershipForClient(target.clientId)
      : undefined;
    const permission = target?.type === "agent"
      ? permissions.get(target.clientId) ?? "auto"
      : "blocked";
    const failure =
      target === undefined || target.type !== "agent" ? "target_not_found" as const :
      !target.online || clients.get(target.clientId) === undefined || targetMembership === undefined
        ? "target_offline" as const :
      permission === "blocked" ? "target_blocked" as const : undefined;
    if (failure !== undefined) {
      const failed = { ...message, routeStatus: "failed" as const, routeFailureReason: failure };
      if (!db().resolvePausedChain(chainId, failed)) return;
      broadcastToGroup(paused.groupId, messageEnvelope(failed));
      broadcastChainResolved(paused, "failed");
      return;
    }
    if (target === undefined || target.type !== "agent" || targetMembership === undefined) {
      return;
    }

    const requestId = randomUUID();
    const request: AgentRequestPayload = {
      requestId,
      groupId: paused.groupId,
      groupName: group.groupName,
      senderId: message.senderId,
      senderName: paused.sourceAgentName,
      senderType: "agent",
      senderOwnerUserName: paused.sourceOwnerUserName,
      targetAgentId: target.memberId,
      targetAgentName: target.displayName,
      ownerUserName: targetMembership.user.displayName,
      onlineMembers: groups.onlineMembers(paused.groupId)
        .filter((member) => member.memberId !== target.memberId)
        .map((member) => ({ displayName: member.displayName, type: member.type })),
      text: paused.text,
      chainId,
      round: paused.nextRound,
      createdAt: Date.now(),
    };
    const awaitingApproval = permission === "approval";
    const roundLimit = paused.roundLimit + 10;
    const context: AgentChainContext = {
      initiatorSessionKey: paused.initiatorSessionKey,
      initiatorName: paused.initiatorName,
      participants: paused.participants,
      roundLimit,
    };
    const updated: HistoryMessage = {
      ...message,
      routeRequestId: requestId,
      routeStatus: awaitingApproval ? "waiting_approval" : "queued",
      routeFailureReason: undefined,
    };
    try {
      db().resumePausedChain(paused, request, awaitingApproval, context, updated);
    } catch (error) {
      sendGroupError(socket, chainId, error);
      return;
    }
    pendingRequests.set(requestId, {
      targetClientId: target.clientId,
      targetAgentId: target.memberId,
      targetName: target.displayName,
      groupId: paused.groupId,
      request,
      message: updated,
      state: awaitingApproval ? "awaiting_approval" : "delivering",
      deliveryAcknowledged: false,
      context,
    });
    broadcastToGroup(paused.groupId, messageEnvelope(updated));
    broadcastChainResolved({ ...paused, roundLimit }, "continued");
    const targetSocket = clients.get(target.clientId);
    if (targetSocket !== undefined) {
      send(targetSocket, createEnvelope(
        awaitingApproval ? "request.pending" : "agent.deliver",
        request,
      ) as BrokerEnvelope);
    }
    if (awaitingApproval) updatePendingApprovalCount(target.clientId);
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
    const nearbyIds = new Set(
      db().storedGroups()
        .filter((group) => group.visibility === "nearby")
        .map((group) => group.groupId),
    );
    return groups.summaries().filter((group) => nearbyIds.has(group.groupId));
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
          ...(currentUser ?? {
            memberId: `user:${stored.sessionKey}`,
            clientId: stored.sessionKey,
            type: "user" as const,
            displayName: stored.userName,
            groupId,
            online: false,
          }),
          stableSessionKey: stored.sessionKey,
          isOwner: db().storedGroup(groupId)?.ownerSessionKey === stored.sessionKey,
          ...(stored.status === "removed" ? { removed: true, online: false } : {}),
        },
        {
          ...(currentAgent ?? {
            memberId: `agent:${stored.sessionKey}`,
            clientId: stored.sessionKey,
            type: "agent" as const,
            displayName: stored.agentName,
            groupId,
            online: false,
            agentStatus: "idle" as const,
            agentPermission: "auto" as const,
            pendingApprovalCount: 0,
          }),
          stableSessionKey: stored.sessionKey,
          ...(stored.status === "removed" ? { removed: true, online: false } : {}),
        },
      );
    }
    return result;
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
        createEnvelope("presence.changed", { ...member }) as BrokerEnvelope,
        excludeClientId,
      );
    }
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
        startedAt: Date.now(),
      });
      if (mode === "lan-host") {
        mdnsPublisher = publishBrokerMdns({
          brokerId: stableBrokerId,
          port: endpoint.port,
          interfaceAddress: primaryOrdinaryNetwork()?.address,
        });
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

  async function close(): Promise<void> {
    if (!started || closing) {
      return;
    }
    closing = true;
    clearIdleShutdown();
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

function parseMention(
  text: string,
): { name: string; text?: string } | undefined {
  if (!text.startsWith("@")) {
    return undefined;
  }
  const match = text.match(/^@([^\s]+)(?:[ \t]+([\s\S]*))?$/);
  return match === null
    ? { name: text.slice(1) }
    : { name: match[1], ...(match[2] === undefined ? {} : { text: match[2] }) };
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

function createCredential(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
