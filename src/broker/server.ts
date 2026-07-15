import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  type ChatMessagePayload,
  type ClientEnvelope,
  type ClientHelloEnvelope,
  type Envelope,
  type ErrorPayload,
  type HistoryMessage,
  type SendFailedPayload,
} from "../protocol.js";
import type { AgentPermission, Member } from "../types.js";
import { BrokerDatabase, historyMessage } from "./database.js";
import { GroupState, GroupStateError } from "./group-state.js";

export const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "broker.sock",
);
export const DEFAULT_DATABASE_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "comms.db",
);

const DEFAULT_DISCONNECT_GRACE_MS = 3_000;

export interface BrokerServerOptions {
  socketPath?: string;
  dbPath?: string;
  disconnectGraceMs?: number;
}

export interface BrokerServer {
  readonly socketPath: string;
  readonly dbPath: string;
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
  targetAgentId: string;
  targetName: string;
  groupId: string;
  request: AgentRequestPayload;
  message: HistoryMessage;
  state: "awaiting_approval" | "delivering";
  deliveryAcknowledged: boolean;
}

export function createBrokerServer(
  options: BrokerServerOptions = {},
): BrokerServer {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const dbPath = options.dbPath ?? DEFAULT_DATABASE_PATH;
  const disconnectGraceMs =
    options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  const instanceId = randomUUID();
  const lockPath = `${socketPath}.lock`;
  const clients = new Map<string, Socket>();
  const sessions = new Map<string, ClientSession>();
  let groups = new GroupState();
  let database: BrokerDatabase | undefined;
  const pendingRequests = new Map<string, PendingRequest>();
  const permissions = new Map<string, AgentPermission>();
  const resolvedApprovalRequests = new Map<string, string>();
  const completedRequests = new Map<string, string>();
  const closedRequestIds = new Set<string>();
  const server = createServer(handleConnection);
  let started = false;
  let closing = false;
  let ownsLock = false;

  function handleConnection(socket: Socket): void {
    const decoder = new JsonlDecoder();
    let sessionId: string | undefined;
    let clientId: string | undefined;

    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) {
          sendError(socket, { code: "invalid_json", message: result.error });
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

    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (clientId !== undefined && sessionId !== undefined) {
        handleUnexpectedDisconnect(sessionId, clientId, socket);
      }
    });
  }

  function registerClient(
    socket: Socket,
    hello: ClientHelloEnvelope,
  ): { sessionId: string; clientId: string } {
    const sessionId = hello.payload.sessionId;
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = { clientId: hello.payload.clientId ?? randomUUID() };
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
    permissions.set(clientId, hello.payload.permission);
    session.socket = socket;
    clients.set(clientId, socket);
    groups.setAgentPermission(clientId, hello.payload.permission);
    const reconnectedMembers = groups.setOnline(clientId, true);
    sendSnapshot(clientId, socket);
    if (reconnectedMembers.length > 0) {
      broadcastPresence(reconnectedMembers, clientId);
      broadcastGroupsChanged();
    }
    resendUnacknowledgedDeliveries(clientId, socket);
    resendPendingApprovals(clientId, socket);
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
    if (session?.socket === socket) {
      session.socket = undefined;
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
    permissions.delete(clientId);
    if (clients.get(clientId) !== socket) {
      return;
    }
    leaveClientGroup(clientId);
    clients.delete(clientId);
  }

  function handleClientMessage(
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
    if (envelope.type === "group.create") {
      handleGroupCreate(clientId, socket, envelope.id, envelope.payload);
      return;
    }
    if (envelope.type === "group.join") {
      handleGroupJoin(clientId, socket, envelope.id, envelope.payload);
      return;
    }
    if (envelope.type === "group.leave") {
      handleGroupLeave(clientId, socket, envelope.id);
      return;
    }
    if (envelope.type === "chat.send") {
      handleChatSend(clientId, socket, envelope.id, envelope.payload.text);
    }
  }

  function handleGroupCreate(
    clientId: string,
    socket: Socket,
    requestId: string,
    payload: { groupName: string; userName: string; agentName: string },
  ): void {
    let groupId: string | undefined;
    try {
      const membership = groups.createGroup(
        clientId,
        payload.groupName,
        payload.userName,
        payload.agentName,
      );
      groupId = membership.groupId;
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
      db().insertGroup({ groupId, groupName: payload.groupName });
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
    clientId: string,
    socket: Socket,
    requestId: string,
    payload: { groupId: string; userName: string; agentName: string },
  ): void {
    try {
      const membership = groups.joinGroup(
        clientId,
        payload.groupId,
        payload.userName,
        payload.agentName,
      );
      groups.setAgentPermission(clientId, permissions.get(clientId) ?? "auto");
      sendSnapshot(clientId, socket);
      broadcastPresence([membership.user, membership.agent], clientId);
      broadcastGroupsChanged();
    } catch (error) {
      sendGroupError(socket, requestId, error);
    }
  }

  function handleGroupLeave(
    clientId: string,
    socket: Socket,
    requestId: string,
  ): void {
    try {
      leaveClientGroup(clientId, true);
      sendSnapshot(clientId, socket);
    } catch (error) {
      sendGroupError(socket, requestId, error);
    }
  }

  function leaveClientGroup(clientId: string, required = false): void {
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
      db().insertAgentRequest(storedMessage, request, awaitingApproval);
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
      pending.message.status = "queued";
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
    broadcastFailure({
      requestId,
      groupId: pending.groupId,
      targetName: pending.targetName,
      targetAgentId: pending.targetAgentId,
      reason: "request_rejected",
    });
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
      const answer = createEnvelope("chat.message", {
        groupId: pending.groupId,
        senderId: pending.request.targetAgentId,
        senderName: pending.request.targetAgentName,
        senderType: "agent" as const,
        text: result.text,
        mentionIds: [pending.request.senderId],
        requestId: result.requestId,
        kind: "agent" as const,
        status: "sent" as const,
      });
      try {
        db().completeRequest(result.requestId, {
          ...historyMessage(
            answer.id,
            answer.timestamp,
            answer.payload,
            "sent",
          ),
          chainId: pending.request.chainId,
          round: pending.request.round,
        });
      } catch {
        sendResultAck(socket, result.requestId, false);
        return;
      }
      pendingRequests.delete(result.requestId);
      completedRequests.set(result.requestId, clientId);
      broadcastToGroup(pending.groupId, answer as BrokerEnvelope);
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
      broadcastFailure({
        requestId: result.requestId,
        groupId: pending.groupId,
        targetName: pending.targetName,
        targetAgentId: pending.targetAgentId,
        reason: result.reason,
      });
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
      broadcastFailure({
        requestId,
        groupId: pending.groupId,
        targetName: pending.targetName,
        targetAgentId: pending.targetAgentId,
        reason: failureReason,
      });
    }
    updatePendingApprovalCount(targetClientId);
  }

  function sendSnapshot(clientId: string, socket: Socket): void {
    const group = groups.groupForClient(clientId);
    send(
      socket,
      createEnvelope("snapshot", {
        brokerInstanceId: instanceId,
        clientId,
        groups: groups.summaries(),
        ...(group === undefined ? {} : { group }),
        members: group === undefined ? [] : groups.members(group.groupId),
        messages:
          group === undefined ? [] : db().recentMessages(group.groupId),
      }) as BrokerEnvelope,
    );
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
    const envelope = createEnvelope("groups.changed", {
      groups: groups.summaries(),
    }) as BrokerEnvelope;
    for (const socket of clients.values()) {
      send(socket, envelope);
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
    await mkdir(dirname(socketPath), { recursive: true });
    await acquireBrokerLock(lockPath);
    ownsLock = true;
    try {
      if (await canConnect(socketPath)) {
        throw new Error(`Broker 已经在运行：${socketPath}`);
      }
      database = new BrokerDatabase(dbPath);
      groups = new GroupState(database.groups());
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
    } catch (error) {
      database?.close();
      database = undefined;
      await releaseBrokerLock(lockPath);
      ownsLock = false;
      throw error;
    }
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
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    started = false;
    database?.close();
    database = undefined;
    if (ownsLock) {
      await releaseBrokerLock(lockPath);
      ownsLock = false;
    }
  }

  function db(): BrokerDatabase {
    if (database === undefined) {
      throw new Error("Broker 数据库尚未启动");
    }
    return database;
  }

  return { socketPath, dbPath, instanceId, start, close };
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

async function acquireBrokerLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(candidatePath, String(process.pid), { flag: "wx" });
      await link(candidatePath, lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      if (Number.isInteger(ownerPid) && processExists(ownerPid)) {
        throw new Error(`Broker 已经在运行：${lockPath}`);
      }
      await releaseBrokerLock(lockPath);
    } finally {
      await releaseBrokerLock(candidatePath);
    }
  }
  throw new Error(`无法获取 Broker 锁：${lockPath}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseBrokerLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function runBroker(): Promise<void> {
  const broker = createBrokerServer();
  await broker.start();
  console.log(`Pi Comms Broker 正在监听 ${broker.socketPath}`);
  const shutdown = async () => broker.close();
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
