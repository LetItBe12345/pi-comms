import { BROKER_PROTOCOL_VERSION, parseClientEnvelope, type ParseClientEnvelopeResult } from "../protocol.js";

// Keep the browser protocol smaller than the Pi protocol. Never forward raw types.
export function parseWebEnvelope(value: unknown): ParseClientEnvelopeResult {
  if (!value || typeof value !== "object") return { ok: false, code: "invalid_envelope", message: "消息无效" };
  const input = value as Record<string, unknown>;
  const payload = input.payload as Record<string, unknown> | undefined;
  const requestId = typeof input.id === "string" ? input.id : undefined;
  const invalid = (message: string): ParseClientEnvelopeResult => ({ ok: false, code: "invalid_payload", message, requestId });
  if (input.type === "web.hello") {
    return parseClientEnvelope({ ...input, type: "client.hello", payload: {
      deviceId: payload?.deviceId, sessionId: payload?.sessionId,
      protocolVersion: BROKER_PROTOCOL_VERSION, permission: "blocked",
    } });
  }
  if (input.type === "group.join") {
    if (!payload || typeof payload.groupId !== "string" || !payload.groupId.trim()) return invalid("请选择群组");
    const credential = payload.membershipCredential;
    if (credential !== undefined && (typeof credential !== "string" || !credential.trim())) return invalid("成员凭证无效");
    if (credential === undefined && (typeof payload.userName !== "string" || !payload.userName.trim())) return invalid("请输入用户名");
    if (payload.inviteCode !== undefined && (typeof payload.inviteCode !== "string" || credential !== undefined)) return invalid("邀请码无效");
    // Validate the envelope with a credential placeholder, then replace only allowed fields.
    const parsed = parseClientEnvelope({ ...input, payload: { groupId: payload.groupId, membershipCredential: "validate" } });
    if (!parsed.ok) return parsed;
    return { ok: true, envelope: { ...parsed.envelope, type: "group.join", payload: {
      groupId: payload.groupId,
      ...(credential === undefined ? { userName: payload.userName as string } : { membershipCredential: credential as string }),
      ...(payload.inviteCode === undefined ? {} : { inviteCode: payload.inviteCode as string }),
    } } };
  }
  if (!["chat.send", "group.leave", "chain.continue", "chain.end", "ping"].includes(String(input.type))) {
    return { ok: false, code: "unsupported_type", message: "手机端不支持此操作", requestId };
  }
  return parseClientEnvelope(value);
}
