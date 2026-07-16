import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  type HistoryMessage,
  type PausedChainPayload,
  type SendFailedPayload,
} from "../protocol.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  formatEndpoint,
  validateConnectEndpoint,
  validateListenEndpoint,
  type TcpListenEndpoint,
} from "../transport/tcp-endpoint.js";
import { probeBroker } from "../transport/broker-probe.js";
import type { AgentPermission, Member } from "../types.js";
import {
  BrokerDatabase,
  historyMessage,
  type AgentChainContext,
  type StoredPausedChain,
} from "./database.js";
import { GroupState, GroupStateError } from "./group-state.js";
import { assertNoLiveLegacyBroker } from "./legacy-migration.js";
import {
  acquireBrokerProcessLock,
  BrokerLockBusyError,
  type BrokerProcessLock,
} from "./process-lock.js";

export const DEFAULT_DATABASE_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "comms.db",
);

const DEFAULT_DISCONNECT_GRACE_MS = 3_000;

export interface BrokerServerOptions {
  listen?: TcpListenEndpoint;
  dbPath?: string;
  disconnectGraceMs?: number;
}

export interface BrokerServer {
  readonly endpoint: TcpListenEndpoint;
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
  context: AgentChainContext;
}

export function createBrokerServer(
  options: BrokerServerOptions = {},
): BrokerServer {
  const listen = validateListenEndpoint(options.listen ?? DEFAULT_BROKER_ENDPOINT);
  let endpoint = listen;
  const dbPath = options.dbPath ?? DEFAULT_DATABASE_PATH;
  const disconnectGraceMs =
    options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  const instanceId = randomUUID();
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
  let processLock: BrokerProcessLock | undefined;

  function handleConnection(socket: Socket): void {
    const decoder = new JsonlDecoder();
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let acceptedProbe = false;

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

        if (parsed.envelope.type === "broker.probe") {
          acceptedProbe = parsed.envelope.payload.service === BROKER_SERVICE &&
            parsed.envelope.payload.protocolVersion === BROKER_PROTOCOL_VERSION;
          send(socket, createEnvelope("broker.ready", {
            service: BROKER_SERVICE,
            protocolVersion: BROKER_PROTOCOL_VERSION,
            brokerInstanceId: instanceId,
            requestId: parsed.envelope.id,
          }) as BrokerEnvelope);
          continue;
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
    if (envelope.type === "chain.continue") {
      handleChainDecision(clientId, socket, envelope.payload.chainId, true);
      return;
    }
    if (envelope.type === "chain.end") {
      handleChainDecision(clientId, socket, envelope.payload.chainId, false);
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
      initiatorSessionId: sessionIdForClient(clientId) ?? clientId,
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
          initiatorSessionId: pending.context.initiatorSessionId,
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
    const sessionId = sessionIdForClient(clientId);
    const group = groups.groupForClient(clientId);
    if (
      paused === undefined ||
      sessionId === undefined ||
      paused.initiatorSessionId !== sessionId ||
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
      initiatorSessionId: paused.initiatorSessionId,
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
    const ownerSocket = sessions.get(paused.initiatorSessionId)?.socket;
    if (ownerSocket === undefined) return;
    const { messageId: _messageId, initiatorSessionId: _sessionId,
      targetAgentId: _targetAgentId, ...payload } = paused;
    send(ownerSocket, createEnvelope("chain.paused", payload) as BrokerEnvelope);
  }

  function sessionIdForClient(clientId: string): string | undefined {
    for (const [sessionId, session] of sessions) {
      if (session.clientId === clientId) return sessionId;
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
    const sessionId = sessionIdForClient(clientId);
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
        pausedChains:
          group === undefined || sessionId === undefined
            ? []
            : db().pausedChains(sessionId, group.groupId).map((paused) => {
                const { messageId: _messageId, initiatorSessionId: _owner,
                  targetAgentId: _target, ...payload } = paused;
                return payload;
              }),
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
    if (dbPath === DEFAULT_DATABASE_PATH) await assertNoLiveLegacyBroker();
    processLock = await acquireBrokerProcessLock(dbPath);
    try {
      database = new BrokerDatabase(dbPath);
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
      started = true;
      closing = false;
    } catch (error) {
      database?.close();
      database = undefined;
      await processLock.release();
      processLock = undefined;
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
    await processLock?.release();
    processLock = undefined;
  }

  function db(): BrokerDatabase {
    if (database === undefined) {
      throw new Error("Broker 数据库尚未启动");
    }
    return database;
  }

  return {
    get endpoint() { return endpoint; },
    dbPath,
    instanceId,
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

async function runBroker(): Promise<void> {
  const { listen, dbPath } = parseBrokerArgs(process.argv.slice(2));
  if (listen.host !== "127.0.0.1") {
    console.warn("警告：当前局域网监听尚未启用准入控制，仅供开发测试");
  }
  const broker = createBrokerServer({ listen, dbPath });
  try {
    await broker.start();
  } catch (error) {
    if (listen.port === 0) throw error;
    const target = validateConnectEndpoint({
      host: listen.host === "0.0.0.0" ? "127.0.0.1" : listen.host,
      port: listen.port,
    });
    const result = await waitForCompatibleBroker(target, 8_000);
    if (result === "compatible") {
      console.log(`复用现有 Pi Comms Broker：${formatEndpoint(target)}`);
      return;
    }
    if (result === "incompatible") {
      throw new Error(`端口上的服务不是兼容的 Pi Comms Broker：${formatEndpoint(target)}`);
    }
    if (error instanceof BrokerLockBusyError) {
      throw new Error(`等待现有 Broker 就绪超时：${formatEndpoint(target)}`);
    }
    throw error;
  }
  console.log(`Pi Comms Broker 正在监听 ${formatEndpoint(broker.endpoint)}`);
  const shutdown = async () => broker.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parseBrokerArgs(args: string[]): {
  listen: TcpListenEndpoint;
  dbPath: string;
} {
  let host = DEFAULT_BROKER_ENDPOINT.host;
  let port = DEFAULT_BROKER_ENDPOINT.port;
  let dbPath = DEFAULT_DATABASE_PATH;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`缺少参数值：${name}`);
    if (name === "--host") host = value;
    else if (name === "--port") port = Number(value);
    else if (name === "--db") dbPath = resolve(value);
    else throw new Error(`未知参数：${name}`);
  }
  return { listen: validateListenEndpoint({ host, port }), dbPath };
}

async function waitForCompatibleBroker(
  endpoint: TcpListenEndpoint,
  timeoutMs: number,
): Promise<"compatible" | "incompatible" | "unreachable"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeBroker(endpoint);
    if (result.status === "compatible") return "compatible";
    if (result.status === "incompatible") return "incompatible";
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return "unreachable";
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
