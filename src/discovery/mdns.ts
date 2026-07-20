import { Bonjour, type Browser, type Service } from "bonjour-service";
import { hostname } from "node:os";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  PI_COMMS_VERSION,
} from "../protocol.js";

export interface DiscoveredBroker {
  brokerId: string;
  host: string;
  addresses: string[];
  port: number;
  protocolVersion: number;
  appVersion: string;
}

export interface MdnsPublisher {
  stop(): Promise<void>;
}

export function publishBrokerMdns(options: {
  brokerId: string;
  port: number;
  interfaceAddress?: string;
  onError?: (error: Error) => void;
}): MdnsPublisher {
  const bonjour = createBonjour(options.interfaceAddress, options.onError);
  const service = bonjour.publish({
    name: `Pi Comms ${options.brokerId.slice(0, 8)}`,
    type: BROKER_SERVICE,
    port: options.port,
    host: hostname(),
    txt: {
      txtvers: "1",
      protocol: String(BROKER_PROTOCOL_VERSION),
      brokerId: options.brokerId,
      appVersion: PI_COMMS_VERSION,
    },
    disableIPv6: true,
  });
  return {
    stop: () => new Promise<void>((resolve) => {
      service.stop?.(() => bonjour.destroy(() => resolve()));
      if (service.stop === undefined) {
        bonjour.destroy(() => resolve());
      }
    }),
  };
}

export interface BrokerDiscoverySource {
  readonly brokers: DiscoveredBroker[];
  refresh(): void;
  stop(): void;
  subscribe(listener: (brokers: DiscoveredBroker[]) => void): () => void;
}

export class FakeBrokerDiscovery implements BrokerDiscoverySource {
  #brokers: DiscoveredBroker[] = [];
  readonly #listeners = new Set<(brokers: DiscoveredBroker[]) => void>();
  readonly #lastSeen = new Map<string, number>();

  constructor(onChanged: (brokers: DiscoveredBroker[]) => void = () => {}) {
    this.#listeners.add(onChanged);
  }

  get brokers(): DiscoveredBroker[] {
    return this.#brokers.map((broker) => ({
      ...broker,
      addresses: [...broker.addresses],
    }));
  }

  setBrokers(brokers: DiscoveredBroker[]): void {
    this.#brokers = [...new Map(
      brokers.map((broker) => [broker.brokerId, {
        ...broker,
        addresses: [...broker.addresses],
      }]),
    ).values()];
    const now = Date.now();
    for (const broker of brokers) this.#lastSeen.set(broker.brokerId, now);
    this.#emit();
  }

  remove(brokerId: string): void {
    this.#brokers = this.#brokers.filter((broker) => broker.brokerId !== brokerId);
    this.#lastSeen.delete(brokerId);
    this.#emit();
  }

  refresh(): void {}

  stop(): void {
    this.#brokers = [];
    this.#lastSeen.clear();
    this.#emit();
  }

  subscribe(listener: (brokers: DiscoveredBroker[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.brokers);
    return () => this.#listeners.delete(listener);
  }

  expireOlderThan(maxAgeMs: number, now = Date.now()): void {
    const expired = [...this.#lastSeen.entries()]
      .filter(([, lastSeen]) => now - lastSeen >= maxAgeMs)
      .map(([brokerId]) => brokerId);
    for (const brokerId of expired) {
      this.#lastSeen.delete(brokerId);
      this.#brokers = this.#brokers.filter((broker) => broker.brokerId !== brokerId);
    }
    if (expired.length > 0) this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.brokers);
  }
}

export class BrokerDiscovery implements BrokerDiscoverySource {
  readonly #bonjour: Bonjour;
  readonly #browser: Browser;
  readonly #brokers = new Map<string, DiscoveredBroker>();
  readonly #lastSeen = new Map<string, number>();
  readonly #listeners = new Set<(brokers: DiscoveredBroker[]) => void>();
  readonly #expiryTimer: ReturnType<typeof setInterval>;

  constructor(options: {
    interfaceAddress?: string;
    onChanged: (brokers: DiscoveredBroker[]) => void;
    onError?: (error: Error) => void;
  }) {
    this.#listeners.add(options.onChanged);
    this.#bonjour = createBonjour(options.interfaceAddress, options.onError);
    this.#browser = this.#bonjour.find({ type: BROKER_SERVICE });
    this.#browser.on("up", (service: Service) => this.#upsert(service));
    this.#browser.on("txt-update", (service: Service) => this.#upsert(service));
    this.#browser.on("down", (service: Service) => {
      const brokerId = txtString(service.txt?.brokerId);
      if (brokerId !== undefined) {
        this.#brokers.delete(brokerId);
        this.#lastSeen.delete(brokerId);
        this.#emit();
      }
    });
    this.#expiryTimer = setInterval(() => this.#expire(), 5_000);
    this.#expiryTimer.unref?.();
  }

  get brokers(): DiscoveredBroker[] {
    return [...this.#brokers.values()].map((broker) => ({
      ...broker,
      addresses: [...broker.addresses],
    }));
  }

  refresh(): void {
    this.#browser.update();
  }

  stop(): void {
    clearInterval(this.#expiryTimer);
    this.#browser.stop();
    this.#bonjour.destroy();
    this.#brokers.clear();
    this.#lastSeen.clear();
    this.#emit();
  }

  subscribe(listener: (brokers: DiscoveredBroker[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.brokers);
    return () => this.#listeners.delete(listener);
  }

  #upsert(service: Service): void {
    const brokerId = txtString(service.txt?.brokerId);
    const protocolVersion = Number(txtString(service.txt?.protocol));
    const appVersion = txtString(service.txt?.appVersion);
    if (
      brokerId === undefined ||
      !Number.isInteger(protocolVersion) ||
      appVersion === undefined
    ) return;
    this.#brokers.set(brokerId, {
      brokerId,
      host: service.host,
      addresses: (service.addresses ?? []).filter(isUsableAddress),
      port: service.port,
      protocolVersion,
      appVersion,
    });
    this.#lastSeen.set(brokerId, Date.now());
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.brokers);
  }

  #expire(now = Date.now()): void {
    let changed = false;
    for (const [brokerId, lastSeen] of this.#lastSeen) {
      if (now - lastSeen < 120_000) continue;
      this.#lastSeen.delete(brokerId);
      this.#brokers.delete(brokerId);
      changed = true;
    }
    if (changed) this.#emit();
  }
}

function createBonjour(
  interfaceAddress?: string,
  onError?: (error: Error) => void,
): Bonjour {
  const reportError = (error: unknown) => onError?.(
    error instanceof Error ? error : new Error(String(error)),
  );
  const bonjour = new Bonjour(
    mdnsSocketOptions(interfaceAddress) as never,
    reportError,
  );
  const internals = bonjour as unknown as {
    server: {
      mdns: {
        on(event: "error", listener: (error: unknown) => void): void;
      };
    };
  };
  internals.server.mdns.on("error", reportError);
  return bonjour;
}

export function mdnsSocketOptions(interfaceAddress?: string): {
  interface?: string;
  bind?: string;
  reuseAddr?: boolean;
} {
  if (interfaceAddress === undefined) return {};
  return {
    interface: interfaceAddress,
    bind: "0.0.0.0",
    reuseAddr: true,
  };
}

function txtString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function isUsableAddress(address: string): boolean {
  return !address.startsWith("127.") && address !== "::1";
}
