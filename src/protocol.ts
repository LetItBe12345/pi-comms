import { randomUUID } from "node:crypto";
import type {
  Group,
  GroupSummary,
  Member,
  MemberType,
  OnlineMember,
  AgentActivityStatus,
  AgentPermission,
  GroupSettings,
  GroupVisibility,
} from "./types.js";

export interface Envelope<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  payload: T;
}

export const BROKER_SERVICE = "pi-comms";
export const PI_COMMS_VERSION = "0.1.0";
export const BROKER_PROTOCOL_VERSION = 4;
export const MAX_JSONL_FRAME_BYTES = 8 * 1024 * 1024;

export interface BrokerProbePayload {
  service: string;
  protocolVersion: number;
}

export interface BrokerReadyPayload {
  service: string;
  protocolVersion: number;
  brokerId: string;
  brokerInstanceId: string;
  brokerMode: "local" | "lan-host";
  requestId: string;
}

export interface SnapshotPayload {
  brokerInstanceId: string;
  clientId: string;
  groups: GroupSummary[];
  group?: Group;
  members: Member[];
  messages: HistoryMessage[];
  pausedChains?: PausedChainPayload[];
  groupSettings?: GroupSettings;
  isOwner?: boolean;
  ownerRecoveryAvailable?: boolean;
}

export interface ClientHelloPayload {
  protocolVersion: number;
  deviceId: string;
  sessionId: string;
  clientId?: string;
  resumeToken?: string;
  permission: AgentPermission;
}

export interface ClientWelcomePayload {
  brokerInstanceId: string;
  clientId: string;
  resumeToken: string;
}

export type ClientGoodbyePayload = Record<string, never>;

export interface PongPayload {
  requestId: string;
}

export interface GroupCreatePayload {
  groupName: string;
  userName: string;
  agentName: string;
  visibility?: GroupVisibility;
}

export interface GroupJoinPayload {
  groupId: string;
  userName?: string;
  agentName?: string;
  inviteCode?: string;
  membershipCredential?: string;
}

export interface GroupCatalogPayload {
  brokerId: string;
}

export interface MembershipWelcomePayload {
  groupId: string;
  membershipCredential: string;
  ownerCredential?: string;
  inviteCode?: string;
}

export interface GroupInviteUpdatedPayload {
  groupId: string;
  inviteCode?: string;
  visibility: GroupVisibility;
}

export interface GroupRenamePayload {
  groupId: string;
  groupName: string;
  ownerCredential: string;
}

export interface GroupVisibilityUpdatePayload {
  groupId: string;
  visibility: GroupVisibility;
  ownerCredential: string;
}

export interface GroupAvailabilityUpdatePayload {
  groupId: string;
  keepAvailableWhenEmpty: boolean;
  openAtLogin: boolean;
  ownerCredential: string;
}

export interface GroupOwnerActionPayload {
  groupId: string;
  ownerCredential: string;
}

export interface GroupOwnerRecoverPayload {
  groupId: string;
  membershipCredential: string;
}

export interface GroupMemberActionPayload extends GroupOwnerActionPayload {
  sessionKey: string;
}

export interface PresenceChangedPayload extends Member {}

export interface PresenceRemovedPayload {
  groupId: string;
  memberIds: string[];
}

export interface AgentStatusPayload {
  status: AgentActivityStatus;
}

export interface PermissionUpdatePayload {
  permission: AgentPermission;
}

export interface RequestDecisionPayload {
  requestId: string;
}

export interface ChainDecisionPayload {
  chainId: string;
}

export interface GroupsChangedPayload {
  groups: GroupSummary[];
}

export interface ChatSendPayload {
  text: string;
}

export interface ChatMessagePayload {
  groupId: string;
  senderId: string;
  senderName: string;
  senderType: MemberType;
  text: string;
  mentionIds: string[];
  requestId?: string;
  kind?: "agent";
  status: MessageStatus;
  failureReason?: MessageFailureReason;
  chainId?: string;
  round?: number;
  routeRequestId?: string;
  routeStatus?: AgentRouteStatus;
  routeFailureReason?: MessageFailureReason;
  routeTargetName?: string;
  nextRound?: number;
}

export type AgentRouteStatus =
  | "waiting_approval"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "paused"
  | "ended";

export type MessageStatus =
  | "sent"
  | "waiting_approval"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "interrupted";

export type MessageFailureReason =
  | "target_not_found"
  | "target_offline"
  | "target_disconnected"
  | "target_blocked"
  | "request_rejected"
  | "request_invalid"
  | "agent_busy"
  | "delivery_failed"
  | "no_text"
  | "broker_restarted"
  | "target_self"
  | "empty_mention";

export interface HistoryMessage extends ChatMessagePayload {
  messageId: string;
  timestamp: number;
  chainId?: string;
  round?: number;
}

export interface AgentRequestPayload {
  requestId: string;
  groupId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  senderType?: MemberType;
  senderOwnerUserName?: string;
  targetAgentId: string;
  targetAgentName: string;
  ownerUserName: string;
  onlineMembers: OnlineMember[];
  text: string;
  chainId: string;
  round: number;
  createdAt?: number;
}

export interface PausedChainPayload {
  chainId: string;
  groupId: string;
  initiatorName: string;
  sourceAgentName: string;
  sourceOwnerUserName: string;
  targetAgentName: string;
  text: string;
  nextRound: number;
  roundLimit: number;
  participants: string[];
  pausedAt: number;
}

export interface ChainResolvedPayload {
  chainId: string;
  action: "continued" | "ended" | "failed";
  initiatorName: string;
  roundLimit: number;
}

export interface AgentDeliverAckPayload {
  requestId: string;
}

export type AgentFailureReason =
  | "agent_busy"
  | "delivery_failed"
  | "no_text";

export type AgentResultPayload =
  | { requestId: string; ok: true; text: string }
  | { requestId: string; ok: false; reason: AgentFailureReason };

export interface AgentResultAckPayload {
  requestId: string;
  accepted: boolean;
  reason?: "unknown_request";
}

export interface SendFailedPayload {
  requestId: string;
  groupId: string;
  targetName: string;
  targetAgentId?: string;
  reason: Exclude<MessageFailureReason, "broker_restarted">;
}

export type ProtocolErrorCode =
  | "invalid_json"
  | "invalid_envelope"
  | "invalid_payload"
  | "unsupported_type"
  | "group_not_found"
  | "group_name_conflict"
  | "member_name_conflict"
  | "invalid_name"
  | "already_in_group"
  | "not_in_group"
  | "request_invalid"
  | "database_error"
  | "protocol_mismatch"
  | "hello_timeout"
  | "frame_too_large"
  | "resume_rejected"
  | "session_in_use"
  | "heartbeat_timeout"
  | "invite_required"
  | "invite_invalid"
  | "invite_rate_limited"
  | "membership_invalid"
  | "owner_required"
  | "owner_cannot_leave"
  | "member_removed"
  | "broker_changed";

export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  requestId?: string;
}

export type ClientHelloEnvelope = Envelope<ClientHelloPayload> & {
  type: "client.hello";
};
export type BrokerProbeEnvelope = Envelope<BrokerProbePayload> & {
  type: "broker.probe";
};
export type BrokerShutdownEnvelope = Envelope<Record<string, never>> & {
  type: "broker.shutdown";
};
export type ClientGoodbyeEnvelope = Envelope<ClientGoodbyePayload> & {
  type: "client.goodbye";
};
export type PingEnvelope = Envelope<Record<string, never>> & {
  type: "ping";
};
export type GroupCreateEnvelope = Envelope<GroupCreatePayload> & {
  type: "group.create";
};
export type GroupCatalogEnvelope = Envelope<GroupCatalogPayload> & {
  type: "group.catalog";
};
export type GroupJoinEnvelope = Envelope<GroupJoinPayload> & {
  type: "group.join";
};
export type GroupLeaveEnvelope = Envelope<Record<string, never>> & {
  type: "group.leave";
};
export type GroupRenameEnvelope = Envelope<GroupRenamePayload> & {
  type: "group.rename";
};
export type GroupVisibilityUpdateEnvelope =
  Envelope<GroupVisibilityUpdatePayload> & {
    type: "group.visibility.update";
  };
export type GroupAvailabilityUpdateEnvelope =
  Envelope<GroupAvailabilityUpdatePayload> & {
    type: "group.availability.update";
  };
export type GroupOwnerActionEnvelope = Envelope<GroupOwnerActionPayload> & {
  type: "group.invite.rotate" | "group.delete";
};
export type GroupOwnerRecoverEnvelope = Envelope<GroupOwnerRecoverPayload> & {
  type: "group.owner.recover";
};
export type GroupMemberActionEnvelope = Envelope<GroupMemberActionPayload> & {
  type: "group.member.remove" | "group.member.allow";
};
export type ChatSendEnvelope = Envelope<ChatSendPayload> & {
  type: "chat.send";
};
export type AgentStatusEnvelope = Envelope<AgentStatusPayload> & {
  type: "agent.status";
};
export type PermissionUpdateEnvelope = Envelope<PermissionUpdatePayload> & {
  type: "permission.update";
};
export type RequestApproveEnvelope = Envelope<RequestDecisionPayload> & {
  type: "request.approve";
};
export type RequestRejectEnvelope = Envelope<RequestDecisionPayload> & {
  type: "request.reject";
};
export type ChainContinueEnvelope = Envelope<ChainDecisionPayload> & {
  type: "chain.continue";
};
export type ChainEndEnvelope = Envelope<ChainDecisionPayload> & {
  type: "chain.end";
};
export type AgentDeliverAckEnvelope = Envelope<AgentDeliverAckPayload> & {
  type: "agent.deliver.ack";
};
export type AgentResultEnvelope = Envelope<AgentResultPayload> & {
  type: "agent.result";
};

export type ClientEnvelope =
  | BrokerProbeEnvelope
  | BrokerShutdownEnvelope
  | GroupCatalogEnvelope
  | ClientHelloEnvelope
  | ClientGoodbyeEnvelope
  | PingEnvelope
  | GroupCreateEnvelope
  | GroupJoinEnvelope
  | GroupLeaveEnvelope
  | GroupRenameEnvelope
  | GroupVisibilityUpdateEnvelope
  | GroupAvailabilityUpdateEnvelope
  | GroupOwnerActionEnvelope
  | GroupOwnerRecoverEnvelope
  | GroupMemberActionEnvelope
  | ChatSendEnvelope
  | AgentStatusEnvelope
  | PermissionUpdateEnvelope
  | RequestApproveEnvelope
  | RequestRejectEnvelope
  | ChainContinueEnvelope
  | ChainEndEnvelope
  | AgentDeliverAckEnvelope
  | AgentResultEnvelope;

export type BrokerEnvelope =
  | (Envelope<BrokerReadyPayload> & { type: "broker.ready" })
  | (Envelope<{ requestId: string }> & { type: "broker.stopping" })
  | (Envelope<ClientWelcomePayload> & { type: "client.welcome" })
  | (Envelope<PongPayload> & { type: "pong" })
  | (Envelope<GroupsChangedPayload> & { type: "group.catalog.result" })
  | (Envelope<MembershipWelcomePayload> & { type: "membership.welcome" })
  | (Envelope<GroupInviteUpdatedPayload> & { type: "group.invite.updated" })
  | (Envelope<{ groupId: string; ownerCredential: string }> & {
      type: "group.owner.welcome";
    })
  | (Envelope<SnapshotPayload> & { type: "snapshot" })
  | (Envelope<GroupsChangedPayload> & { type: "groups.changed" })
  | (Envelope<PresenceChangedPayload> & { type: "presence.changed" })
  | (Envelope<PresenceRemovedPayload> & { type: "presence.removed" })
  | (Envelope<ChatMessagePayload> & { type: "chat.message" })
  | (Envelope<AgentRequestPayload> & { type: "agent.deliver" })
  | (Envelope<AgentRequestPayload> & { type: "request.pending" })
  | (Envelope<PausedChainPayload> & { type: "chain.paused" })
  | (Envelope<ChainResolvedPayload> & { type: "chain.resolved" })
  | (Envelope<AgentResultAckPayload> & { type: "agent.result.ack" })
  | (Envelope<SendFailedPayload> & { type: "send.failed" })
  | (Envelope<ErrorPayload> & { type: "error" });

export type JsonlDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "invalid_json" | "frame_too_large"; error: string };

export type ParseClientEnvelopeResult =
  | { ok: true; envelope: ClientEnvelope }
  | {
      ok: false;
      code: Exclude<ProtocolErrorCode, "invalid_json">;
      message: string;
      requestId?: string;
    };

export function createEnvelope<T>(
  type: string,
  payload: T,
  options: { id?: string; timestamp?: number } = {},
): Envelope<T> {
  return {
    id: options.id ?? randomUUID(),
    type,
    timestamp: options.timestamp ?? Date.now(),
    payload,
  };
}

export function encodeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export class JsonlDecoder {
  #buffer = Buffer.alloc(0);

  constructor(readonly maxFrameBytes = MAX_JSONL_FRAME_BYTES) {}

  push(chunk: string | Uint8Array): JsonlDecodeResult[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    const results: JsonlDecodeResult[] = [];
    let newlineIndex = this.#buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      if (newlineIndex > this.maxFrameBytes) {
        this.#buffer = Buffer.alloc(0);
        return [{ ok: false, code: "frame_too_large", error: "消息帧超过上限" }];
      }
      const line = this.#buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        try {
          results.push({ ok: true, value: JSON.parse(line) });
        } catch {
          results.push({ ok: false, code: "invalid_json", error: "消息不是合法的 JSON" });
        }
      }
      newlineIndex = this.#buffer.indexOf(0x0a);
    }
    if (this.#buffer.length > this.maxFrameBytes) {
      this.#buffer = Buffer.alloc(0);
      results.push({ ok: false, code: "frame_too_large", error: "消息帧超过上限" });
    }
    return results;
  }
}

export function parseClientEnvelope(value: unknown): ParseClientEnvelopeResult {
  if (!isRecord(value)) {
    return invalid("invalid_envelope", "消息信封必须是对象");
  }
  const requestId = typeof value.id === "string" ? value.id : undefined;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.type !== "string" ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    !("payload" in value)
  ) {
    return invalid("invalid_envelope", "消息信封字段无效", requestId);
  }
  if (!isRecord(value.payload)) {
    return invalid("invalid_payload", `${value.type} payload 必须是对象`, requestId);
  }

  switch (value.type) {
    case "broker.probe":
      return typeof value.payload.service === "string" &&
        value.payload.service.length > 0 &&
        Number.isInteger(value.payload.protocolVersion)
        ? { ok: true, envelope: value as unknown as BrokerProbeEnvelope }
        : invalid("invalid_payload", "broker.probe payload 无效", requestId);
    case "client.hello": {
      const result = requireStrings(value, requestId, ["deviceId", "sessionId"]);
      const clientId = value.payload.clientId;
      const resumeToken = value.payload.resumeToken;
      if (!result.ok) return result;
      if (value.payload.protocolVersion !== BROKER_PROTOCOL_VERSION) {
        return invalid("protocol_mismatch", "Pi Comms 协议版本不兼容", requestId);
      }
      if (clientId !== undefined && (typeof clientId !== "string" || !clientId.trim())) {
        return invalid("invalid_payload", "client.hello clientId 无效", requestId);
      }
      if (resumeToken !== undefined && (typeof resumeToken !== "string" || !resumeToken.trim())) {
        return invalid("invalid_payload", "client.hello resumeToken 无效", requestId);
      }
      if ((clientId === undefined) !== (resumeToken === undefined)) {
        return invalid("invalid_payload", "clientId 和 resumeToken 必须同时提供", requestId);
      }
      return isAgentPermission(value.payload.permission)
        ? result
        : invalid("invalid_payload", "client.hello permission 无效", requestId);
    }
    case "broker.shutdown":
    case "client.goodbye":
    case "ping":
      return { ok: true, envelope: value as unknown as ClientEnvelope };
    case "group.catalog":
      return requireStrings(value, requestId, ["brokerId"]);
    case "group.create":
      {
        const result = requireStrings(value, requestId, [
        "groupName",
        "userName",
        "agentName",
        ]);
        if (!result.ok) return result;
        return value.payload.visibility === undefined ||
          value.payload.visibility === "local" ||
          value.payload.visibility === "nearby"
          ? result
          : invalid("invalid_payload", "group.create visibility 无效", requestId);
      }
    case "group.join": {
      const payload = value.payload;
      if (typeof payload.groupId !== "string" || !payload.groupId.trim()) {
        return invalid("invalid_payload", "group.join groupId 无效", requestId);
      }
      const hasInvite = typeof payload.inviteCode === "string" &&
        payload.inviteCode.trim().length > 0;
      const hasCredential = typeof payload.membershipCredential === "string" &&
        payload.membershipCredential.trim().length > 0;
      const hasNames = typeof payload.userName === "string" &&
        payload.userName.trim().length > 0 &&
        typeof payload.agentName === "string" &&
        payload.agentName.trim().length > 0;
      if (hasInvite && hasCredential) {
        return invalid(
          "invalid_payload",
          "group.join 不能同时提供邀请码和长期成员凭证",
          requestId,
        );
      }
      if (hasInvite || !hasCredential) {
        if (!hasNames) {
          return invalid(
            "invalid_payload",
            "group.join 首次加入时必须提供用户和 Agent 名称",
            requestId,
          );
        }
        return requireStrings(value, requestId, ["groupId", "userName", "agentName"]);
      }
      return { ok: true, envelope: value as unknown as GroupJoinEnvelope };
    }
    case "group.leave":
      return { ok: true, envelope: value as unknown as GroupLeaveEnvelope };
    case "group.rename":
      return requireStrings(value, requestId, ["groupId", "groupName", "ownerCredential"]);
    case "group.visibility.update": {
      const result = requireStrings(value, requestId, ["groupId", "ownerCredential"]);
      if (!result.ok) return result;
      return value.payload.visibility === "local" ||
        value.payload.visibility === "nearby"
        ? result
        : invalid("invalid_payload", "group.visibility.update visibility 无效", requestId);
    }
    case "group.availability.update": {
      const result = requireStrings(value, requestId, ["groupId", "ownerCredential"]);
      if (!result.ok) return result;
      return typeof value.payload.keepAvailableWhenEmpty === "boolean" &&
        typeof value.payload.openAtLogin === "boolean"
        ? result
        : invalid("invalid_payload", "group.availability.update 开关无效", requestId);
    }
    case "group.invite.rotate":
    case "group.delete":
      return requireStrings(value, requestId, ["groupId", "ownerCredential"]);
    case "group.owner.recover":
      return requireStrings(value, requestId, ["groupId", "membershipCredential"]);
    case "group.member.remove":
    case "group.member.allow":
      return requireStrings(value, requestId, [
        "groupId",
        "sessionKey",
        "ownerCredential",
      ]);
    case "chat.send":
      return requireStrings(value, requestId, ["text"]);
    case "agent.status":
      return value.payload.status === "idle" || value.payload.status === "busy"
        ? { ok: true, envelope: value as unknown as AgentStatusEnvelope }
        : invalid("invalid_payload", "agent.status status 无效", requestId);
    case "permission.update":
      return isAgentPermission(value.payload.permission)
        ? { ok: true, envelope: value as unknown as PermissionUpdateEnvelope }
        : invalid("invalid_payload", "permission.update permission 无效", requestId);
    case "request.approve":
    case "request.reject":
      return requireStrings(value, requestId, ["requestId"]);
    case "chain.continue":
    case "chain.end":
      return requireStrings(value, requestId, ["chainId"]);
    case "agent.deliver.ack":
      return requireStrings(value, requestId, ["requestId"]);
    case "agent.result":
      return parseAgentResult(value, requestId);
    default:
      return invalid(
        "unsupported_type",
        `不支持的消息类型：${value.type}`,
        requestId,
      );
  }
}

function isAgentPermission(value: unknown): value is AgentPermission {
  return value === "auto" || value === "approval" || value === "blocked";
}

function requireStrings(
  value: Record<string, unknown>,
  requestId: string | undefined,
  fields: string[],
): ParseClientEnvelopeResult {
  const payload = value.payload as Record<string, unknown>;
  for (const field of fields) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      return invalid(
        "invalid_payload",
        `${value.type} ${field} 无效`,
        requestId,
      );
    }
  }
  return { ok: true, envelope: value as unknown as ClientEnvelope };
}

function parseAgentResult(
  value: Record<string, unknown>,
  envelopeId?: string,
): ParseClientEnvelopeResult {
  const payload = value.payload as Record<string, unknown>;
  if (typeof payload.requestId !== "string" || !payload.requestId) {
    return invalid("invalid_payload", "agent.result requestId 无效", envelopeId);
  }
  if (payload.ok === true && typeof payload.text === "string" && payload.text.trim()) {
    return { ok: true, envelope: value as unknown as AgentResultEnvelope };
  }
  if (
    payload.ok === false &&
    (payload.reason === "agent_busy" ||
      payload.reason === "delivery_failed" ||
      payload.reason === "no_text")
  ) {
    return { ok: true, envelope: value as unknown as AgentResultEnvelope };
  }
  return invalid("invalid_payload", "agent.result payload 无效", envelopeId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  code: Exclude<ProtocolErrorCode, "invalid_json">,
  message: string,
  requestId?: string,
): ParseClientEnvelopeResult {
  return { ok: false, code, message, requestId };
}
