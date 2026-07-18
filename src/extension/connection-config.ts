import {
  validateConnectEndpoint,
  type TcpConnectEndpoint,
} from "../transport/tcp-endpoint.js";
import { formatInviteCode, normalizeInviteCode } from "../broker/invite-code.js";
import { ordinaryNetworks } from "../discovery/network.js";

export const CONNECTION_CONFIG_ENTRY = "pi-comms-connection";

export type ConnectionConfig =
  | { mode: "local" }
  | { mode: "lan-host"; brokerId?: string }
  | {
      mode: "lan-client";
      endpoint: TcpConnectEndpoint;
      groupId: string;
      inviteCode?: string;
      brokerId?: string;
    };

export function parseInvitation(value: string): {
  endpoint: TcpConnectEndpoint;
  groupId: string;
  inviteCode: string;
} {
  const match = value.trim().match(
    /^([^\s:]+):(\d+)\s+([^\s]+)\s+([A-Za-z2-9-]+)$/,
  );
  if (match === null) {
    throw new Error(
      "请粘贴完整群组邀请，例如 192.168.1.23:43127 群组ID ABCDE-FGHIJ",
    );
  }
  const inviteCode = normalizeInviteCode(match[4]);
  if (inviteCode.length !== 10) throw new Error("邀请码应为 10 位");
  return {
    endpoint: validateConnectEndpoint({ host: match[1], port: Number(match[2]) }),
    groupId: match[3],
    inviteCode,
  };
}

export function formatInvitation(
  endpoint: TcpConnectEndpoint,
  groupId: string,
  inviteCode: string,
): string {
  return `${endpoint.host}:${endpoint.port} ${groupId} ${formatInviteCode(inviteCode)}`;
}

export function restoreConnectionConfig(entries: unknown[]): ConnectionConfig | undefined {
  let config: ConnectionConfig | undefined;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== CONNECTION_CONFIG_ENTRY ||
      !("data" in entry)
    ) continue;
    const parsed = parseConnectionConfig(entry.data);
    if (parsed !== undefined) config = parsed;
  }
  return config;
}

export function hasLegacyRemoteConnection(entries: unknown[]): boolean {
  return entries.some((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== CONNECTION_CONFIG_ENTRY ||
      !("data" in entry) ||
      typeof entry.data !== "object" ||
      entry.data === null
    ) return false;
    return "mode" in entry.data &&
      entry.data.mode === "lan-client" &&
      (!("groupId" in entry.data) || typeof entry.data.groupId !== "string");
  });
}

export function getLanIPv4Addresses(): string[] {
  return ordinaryNetworks().map((network) => network.address);
}

function parseConnectionConfig(value: unknown): ConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || !("mode" in value)) return undefined;
  if (value.mode === "local") return { mode: "local" };
  const brokerId = "brokerId" in value && typeof value.brokerId === "string"
    ? value.brokerId
    : undefined;
  if (value.mode === "lan-host") {
    return { mode: "lan-host", ...(brokerId === undefined ? {} : { brokerId }) };
  }
  if (
    value.mode !== "lan-client" ||
    !("endpoint" in value) ||
    !("groupId" in value) ||
    typeof value.groupId !== "string" ||
    ("inviteCode" in value && typeof value.inviteCode !== "string")
  ) return undefined;
  try {
    const inviteCode = "inviteCode" in value &&
        typeof value.inviteCode === "string"
      ? normalizeInviteCode(value.inviteCode)
      : undefined;
    return {
      mode: "lan-client",
      endpoint: validateConnectEndpoint(value.endpoint as TcpConnectEndpoint),
      groupId: value.groupId,
      ...(inviteCode === undefined ? {} : { inviteCode }),
      ...(brokerId === undefined ? {} : { brokerId }),
    };
  } catch {
    return undefined;
  }
}
