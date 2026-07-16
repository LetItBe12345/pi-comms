export type SessionKey = string & { readonly __brand: "SessionKey" };

export function createSessionKey(deviceId: string, sessionId: string): SessionKey {
  if (!deviceId.trim() || !sessionId.trim()) {
    throw new Error("deviceId 和 sessionId 不能为空");
  }
  return JSON.stringify([deviceId, sessionId]) as SessionKey;
}

export function parseSessionKey(value: string): {
  deviceId: string;
  sessionId: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SessionKey 格式无效");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    !parsed[0].trim() ||
    typeof parsed[1] !== "string" ||
    !parsed[1].trim()
  ) {
    throw new Error("SessionKey 格式无效");
  }
  return { deviceId: parsed[0], sessionId: parsed[1] };
}
