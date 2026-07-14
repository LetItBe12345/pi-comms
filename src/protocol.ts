import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export interface Envelope<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  payload: T;
}

export interface SnapshotPayload {
  clientId: string;
  clients: string[];
}

export interface PresenceChangedPayload {
  clientId: string;
  online: boolean;
}

export interface ChatSendPayload {
  text: string;
  targetClientId?: string;
}

export interface ChatMessagePayload extends ChatSendPayload {
  senderClientId: string;
}

export interface SendFailedPayload {
  requestId: string;
  targetClientId: string;
  reason: "target_offline";
}

export type ProtocolErrorCode =
  | "invalid_json"
  | "invalid_envelope"
  | "invalid_payload"
  | "unsupported_type";

export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  requestId?: string;
}

export type ChatSendEnvelope = Envelope<ChatSendPayload> & {
  type: "chat.send";
};

export type BrokerEnvelope =
  | (Envelope<SnapshotPayload> & { type: "snapshot" })
  | (Envelope<PresenceChangedPayload> & { type: "presence.changed" })
  | (Envelope<ChatMessagePayload> & { type: "chat.message" })
  | (Envelope<SendFailedPayload> & { type: "send.failed" })
  | (Envelope<ErrorPayload> & { type: "error" });

export type JsonlDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type ParseClientEnvelopeResult =
  | { ok: true; envelope: ChatSendEnvelope }
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
    value.type.length === 0 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    !("payload" in value)
  ) {
    return invalid("invalid_envelope", "消息信封字段无效", requestId);
  }

  if (value.type !== "chat.send") {
    return invalid(
      "unsupported_type",
      `不支持的消息类型：${value.type}`,
      requestId,
    );
  }

  if (!isRecord(value.payload)) {
    return invalid("invalid_payload", "chat.send payload 必须是对象", requestId);
  }

  const { text, targetClientId } = value.payload;

  if (typeof text !== "string" || text.trim().length === 0) {
    return invalid("invalid_payload", "chat.send text 不能为空", requestId);
  }

  if (
    targetClientId !== undefined &&
    (typeof targetClientId !== "string" || targetClientId.length === 0)
  ) {
    return invalid(
      "invalid_payload",
      "targetClientId 必须是非空字符串",
      requestId,
    );
  }

  return {
    ok: true,
    envelope: value as unknown as ChatSendEnvelope,
  };
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
