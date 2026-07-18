import { createConnection } from "node:net";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";
import type { GroupSummary } from "../types.js";
import type { TcpConnectEndpoint } from "../transport/tcp-endpoint.js";
import type { DiscoveredBroker } from "./mdns.js";

export interface NearbyGroup extends GroupSummary {
  brokerId: string;
  endpoint: TcpConnectEndpoint;
  connectionState: "available" | "unreachable" | "update_required";
}

export async function collectNearbyGroups(
  brokers: DiscoveredBroker[],
  fetcher: typeof fetchGroupCatalog = fetchGroupCatalog,
): Promise<NearbyGroup[]> {
  const results = await Promise.all(brokers.map(async (broker) => {
    if (broker.protocolVersion !== BROKER_PROTOCOL_VERSION) return [];
    const address = preferredAddress(broker.addresses) ?? broker.host;
    try {
      const groups = await fetcher(
        { host: address, port: broker.port },
        broker.brokerId,
      );
      return groups.map((group): NearbyGroup => ({
        ...group,
        brokerId: broker.brokerId,
        endpoint: { host: address, port: broker.port },
        connectionState: "available",
      }));
    } catch {
      return [];
    }
  }));
  return [...new Map(
    results.flat().map((group) => [`${group.brokerId}:${group.groupId}`, group]),
  ).values()].sort((a, b) =>
    a.groupName.localeCompare(b.groupName, "zh-CN") ||
    a.brokerId.localeCompare(b.brokerId)
  );
}

export async function fetchGroupCatalog(
  endpoint: TcpConnectEndpoint,
  brokerId: string,
  timeoutMs = 2_000,
): Promise<GroupSummary[]> {
  return new Promise<GroupSummary[]>((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new JsonlDecoder();
    const probe = createEnvelope("broker.probe", {
      service: BROKER_SERVICE,
      protocolVersion: BROKER_PROTOCOL_VERSION,
    });
    let catalogRequestId: string | undefined;
    const timer = setTimeout(() => finish(new Error("附近群组查询超时")), timeoutMs);
    const finish = (error?: Error, groups?: GroupSummary[]) => {
      clearTimeout(timer);
      socket.destroy();
      error === undefined ? resolve(groups ?? []) : reject(error);
    };
    socket.once("connect", () => socket.write(encodeEnvelope(probe)));
    socket.on("data", (chunk) => {
      for (const decoded of decoder.push(chunk)) {
        if (!decoded.ok) return finish(new Error(decoded.error));
        const message = decoded.value as BrokerEnvelope;
        if (message.type === "error") return finish(new Error(message.payload.message));
        if (
          message.type === "broker.ready" &&
          message.payload.requestId === probe.id
        ) {
          if (
            message.payload.brokerId !== brokerId ||
            message.payload.protocolVersion !== BROKER_PROTOCOL_VERSION
          ) {
            return finish(new Error("附近设备信息已变化，请刷新后重试"));
          }
          const request = createEnvelope("group.catalog", { brokerId });
          catalogRequestId = request.id;
          socket.write(encodeEnvelope(request));
          continue;
        }
        if (
          message.type === "group.catalog.result" &&
          catalogRequestId !== undefined
        ) {
          return finish(undefined, message.payload.groups);
        }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (catalogRequestId === undefined) finish(new Error("附近群组连接已关闭"));
    });
  });
}

function preferredAddress(addresses: string[]): string | undefined {
  return addresses.find(isPrivateIPv4) ??
    addresses.find((address) => address.includes(".") && address !== "0.0.0.0") ??
    addresses.find((address) => address !== "::" && address !== "::1");
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}
