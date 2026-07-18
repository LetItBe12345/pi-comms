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
}

export class FakeBrokerDiscovery implements BrokerDiscoverySource {
  #brokers: DiscoveredBroker[] = [];
  readonly #onChanged: (brokers: DiscoveredBroker[]) => void;

  constructor(onChanged: (brokers: DiscoveredBroker[]) => void = () => {}) {
    this.#onChanged = onChanged;
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
    this.#onChanged(this.brokers);
  }

  remove(brokerId: string): void {
    this.#brokers = this.#brokers.filter((broker) => broker.brokerId !== brokerId);
    this.#onChanged(this.brokers);
  }

  refresh(): void {}

  stop(): void {
    this.#brokers = [];
  }
}

export class BrokerDiscovery implements BrokerDiscoverySource {
  readonly #bonjour: Bonjour;
  readonly #browser: Browser;
  readonly #brokers = new Map<string, DiscoveredBroker>();
  readonly #onChanged: (brokers: DiscoveredBroker[]) => void;

  constructor(options: {
    interfaceAddress?: string;
    onChanged: (brokers: DiscoveredBroker[]) => void;
    onError?: (error: Error) => void;
  }) {
    this.#onChanged = options.onChanged;
    this.#bonjour = createBonjour(options.interfaceAddress, options.onError);
    this.#browser = this.#bonjour.find({ type: BROKER_SERVICE });
    this.#browser.on("up", (service: Service) => this.#upsert(service));
    this.#browser.on("txt-update", (service: Service) => this.#upsert(service));
    this.#browser.on("down", (service: Service) => {
      const brokerId = txtString(service.txt?.brokerId);
      if (brokerId !== undefined) {
        this.#brokers.delete(brokerId);
        this.#emit();
      }
    });
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
    this.#browser.stop();
    this.#bonjour.destroy();
    this.#brokers.clear();
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
    this.#emit();
  }

  #emit(): void {
    this.#onChanged(this.brokers);
  }
}

function createBonjour(
  interfaceAddress?: string,
  onError?: (error: Error) => void,
): Bonjour {
  const options = interfaceAddress === undefined
    ? {}
    : { interface: interfaceAddress };
  return new Bonjour(
    options as never,
    (error: unknown) => onError?.(
      error instanceof Error ? error : new Error(String(error)),
    ),
  );
}

function txtString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function isUsableAddress(address: string): boolean {
  return !address.startsWith("127.") && address !== "::1";
}
