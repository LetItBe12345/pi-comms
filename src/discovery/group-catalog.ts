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
import type {
  BrokerDiscoverySource,
  DiscoveredBroker,
} from "./mdns.js";

export interface NearbyGroup extends GroupSummary {
  brokerId: string;
  endpoint: TcpConnectEndpoint;
  connectionState: "available" | "unreachable" | "update_required";
}

export interface NearbyCatalog {
  groups: NearbyGroup[];
  updateRequiredCount: number;
}

export async function collectNearbyGroups(
  brokers: DiscoveredBroker[],
  fetcher: typeof fetchGroupCatalog = fetchGroupCatalog,
): Promise<NearbyGroup[]> {
  return (await collectNearbyCatalog(brokers, fetcher)).groups;
}

export async function collectNearbyCatalog(
  brokers: DiscoveredBroker[],
  fetcher: typeof fetchGroupCatalog = fetchGroupCatalog,
): Promise<NearbyCatalog> {
  let updateRequiredCount = 0;
  const results = await Promise.all(brokers.map(async (broker) => {
    if (broker.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      updateRequiredCount += 1;
      return [];
    }
    for (const address of candidateAddresses(broker)) {
      try {
        const groups = await fetcher(
          { host: address, port: broker.port },
          broker.brokerId,
          800,
        );
        return groups.map((group): NearbyGroup => ({
          ...group,
          brokerId: broker.brokerId,
          endpoint: { host: address, port: broker.port },
          connectionState: "available",
        }));
      } catch {
        continue;
      }
    }
    return [];
  }));
  const groups = [...new Map(
    results.flat().map((group) => [`${group.brokerId}:${group.groupId}`, group]),
  ).values()].sort((a, b) =>
    a.groupName.localeCompare(b.groupName, "zh-CN") ||
    a.brokerId.localeCompare(b.brokerId)
  );
  return { groups, updateRequiredCount };
}

export class NearbyGroupsWatcher {
  readonly #discovery: BrokerDiscoverySource;
  readonly #onChanged: (catalog: NearbyCatalog) => void;
  readonly #intervalMs: number;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #generation = 0;
  #running = false;

  constructor(options: {
    discovery: BrokerDiscoverySource;
    onChanged: (catalog: NearbyCatalog) => void;
    intervalMs?: number;
  }) {
    this.#discovery = options.discovery;
    this.#onChanged = options.onChanged;
    this.#intervalMs = options.intervalMs ?? 2_000;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = this.#discovery.subscribe(() => void this.refresh());
    this.#timer = setInterval(() => {
      this.#discovery.refresh();
      void this.refresh();
    }, this.#intervalMs);
    this.#timer.unref?.();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const catalog = await collectNearbyCatalog(this.#discovery.brokers);
    if (!this.#running || generation !== this.#generation) return;
    this.#onChanged(catalog);
  }

  stop(): void {
    this.#running = false;
    this.#generation += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#discovery.stop();
  }
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

function candidateAddresses(broker: DiscoveredBroker): string[] {
  const usable = broker.addresses.filter((address) =>
    address !== "0.0.0.0" &&
    address !== "::" &&
    address !== "::1" &&
    !address.startsWith("127.")
  );
  return [...new Set([
    ...usable.filter(isPrivateIPv4),
    ...usable.filter((address) => address.includes(".") && !isPrivateIPv4(address)),
    ...usable.filter((address) => address.includes(":")),
    broker.host,
  ])];
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}
