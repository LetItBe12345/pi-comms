import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  Group,
  GroupSummary,
  Member,
  MemberType,
  OnlineMember,
} from "./types.js";

export interface Envelope<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  payload: T;
}

export interface SnapshotPayload {
  brokerInstanceId: string;
  clientId: string;
  groups: GroupSummary[];
  group?: Group;
  members: Member[];
  messages: HistoryMessage[];
}

export interface ClientHelloPayload {
  sessionId: string;
  clientId?: string;
}

export interface ClientGoodbyePayload {
  sessionId: string;
}

export interface GroupCreatePayload {
  groupName: string;
  userName: string;
  agentName: string;
}

export interface GroupJoinPayload {
  groupId: string;
  userName: string;
  agentName: string;
}

export interface PresenceChangedPayload extends Member {}

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
}

export type MessageStatus =
  | "sent"
  | "processing"
  | "completed"
  | "failed"
  | "interrupted";

export type MessageFailureReason =
  | "target_not_found"
  | "target_offline"
  | "target_disconnected"
  | "agent_busy"
  | "delivery_failed"
  | "no_text"
  | "broker_restarted";

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
  targetAgentId: string;
  targetAgentName: string;
  ownerUserName: string;
  onlineMembers: OnlineMember[];
  text: string;
  chainId: string;
  round: number;
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
  | "database_error";

export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  requestId?: string;
}

export type ClientHelloEnvelope = Envelope<ClientHelloPayload> & {
  type: "client.hello";
};
export type ClientGoodbyeEnvelope = Envelope<ClientGoodbyePayload> & {
  type: "client.goodbye";
};
export type GroupCreateEnvelope = Envelope<GroupCreatePayload> & {
  type: "group.create";
};
export type GroupJoinEnvelope = Envelope<GroupJoinPayload> & {
  type: "group.join";
};
export type GroupLeaveEnvelope = Envelope<Record<string, never>> & {
  type: "group.leave";
};
export type ChatSendEnvelope = Envelope<ChatSendPayload> & {
  type: "chat.send";
};
export type AgentDeliverAckEnvelope = Envelope<AgentDeliverAckPayload> & {
  type: "agent.deliver.ack";
};
export type AgentResultEnvelope = Envelope<AgentResultPayload> & {
  type: "agent.result";
};

export type ClientEnvelope =
  | ClientHelloEnvelope
  | ClientGoodbyeEnvelope
  | GroupCreateEnvelope
  | GroupJoinEnvelope
  | GroupLeaveEnvelope
  | ChatSendEnvelope
  | AgentDeliverAckEnvelope
  | AgentResultEnvelope;

export type BrokerEnvelope =
  | (Envelope<SnapshotPayload> & { type: "snapshot" })
  | (Envelope<GroupsChangedPayload> & { type: "groups.changed" })
  | (Envelope<PresenceChangedPayload> & { type: "presence.changed" })
  | (Envelope<ChatMessagePayload> & { type: "chat.message" })
  | (Envelope<AgentRequestPayload> & { type: "agent.deliver" })
  | (Envelope<AgentResultAckPayload> & { type: "agent.result.ack" })
  | (Envelope<SendFailedPayload> & { type: "send.failed" })
  | (Envelope<ErrorPayload> & { type: "error" });

export type JsonlDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

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
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: string | Uint8Array): JsonlDecodeResult[] {
    this.#buffer +=
      typeof chunk === "string"
        ? chunk
        : this.#decoder.write(Buffer.from(chunk));
    const results: JsonlDecodeResult[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        try {
          results.push({ ok: true, value: JSON.parse(line) });
        } catch {
          results.push({ ok: false, error: "消息不是合法的 JSON" });
        }
      }
      newlineIndex = this.#buffer.indexOf("\n");
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
    case "client.hello": {
      const result = requireStrings(value, requestId, ["sessionId"]);
      const clientId = value.payload.clientId;
      return result.ok && clientId !== undefined &&
        (typeof clientId !== "string" || !clientId.trim())
        ? invalid("invalid_payload", "client.hello clientId 无效", requestId)
        : result;
    }
    case "client.goodbye":
      return requireStrings(value, requestId, ["sessionId"]);
    case "group.create":
      return requireStrings(value, requestId, [
        "groupName",
        "userName",
        "agentName",
      ]);
    case "group.join":
      return requireStrings(value, requestId, [
        "groupId",
        "userName",
        "agentName",
      ]);
    case "group.leave":
      return { ok: true, envelope: value as unknown as GroupLeaveEnvelope };
    case "chat.send":
      return requireStrings(value, requestId, ["text"]);
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
