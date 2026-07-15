import { createConnection, type Socket } from "node:net";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";
import type { AgentPermission } from "../types.js";

const DEFAULT_RECONNECT_INTERVAL_MS = 1_000;

export interface BrokerClientOptions {
  socketPath: string;
  reconnectIntervalMs?: number;
  onMessage(message: BrokerEnvelope): void;
  onDisconnected(wasConnected: boolean): void;
}

export class BrokerClient {
  readonly #socketPath: string;
  readonly #reconnectIntervalMs: number;
  readonly #onMessage: (message: BrokerEnvelope) => void;
  readonly #onDisconnected: (wasConnected: boolean) => void;
  #sessionId: string | undefined;
  #clientId: string | undefined;
  #socket: Socket | undefined;
  #connectTask: Promise<boolean> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #connected = false;
  #stopping = false;
  #permission: AgentPermission = "auto";

  constructor(options: BrokerClientOptions) {
    this.#socketPath = options.socketPath;
    this.#reconnectIntervalMs =
      options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.#onMessage = options.onMessage;
    this.#onDisconnected = options.onDisconnected;
  }

  get connected(): boolean {
    return this.#connected;
  }

  async start(sessionId: string, permission: AgentPermission = "auto"): Promise<boolean> {
    this.#sessionId = sessionId;
    this.#permission = permission;
    this.#stopping = false;
    return this.connect();
  }

  setPermission(permission: AgentPermission): void {
    this.#permission = permission;
  }

  async connect(): Promise<boolean> {
    if (this.#connected && this.#socket !== undefined) {
      return true;
    }
    if (this.#connectTask !== undefined) {
      return this.#connectTask;
    }
    this.#connectTask = this.#openConnection();
    try {
      return await this.#connectTask;
    } finally {
      this.#connectTask = undefined;
    }
  }

  send(type: string, payload: unknown): string | undefined {
    if (!this.#connected || this.#socket === undefined || this.#socket.destroyed) {
      return undefined;
    }
    const envelope = createEnvelope(type, payload);
    this.#socket.write(encodeEnvelope(envelope));
    return envelope.id;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connected = false;
    if (socket === undefined || socket.destroyed) {
      return;
    }

    await new Promise<void>((resolveClose) => {
      socket.once("close", resolveClose);
      socket.end(
        encodeEnvelope(
          createEnvelope("client.goodbye", { sessionId: this.#sessionId }),
        ),
      );
    });
  }

  #openConnection(): Promise<boolean> {
    return new Promise<boolean>((resolveConnection) => {
      const sessionId = this.#sessionId;
      if (sessionId === undefined || this.#stopping) {
        resolveConnection(false);
        return;
      }

      const socket = createConnection(this.#socketPath);
      const decoder = new JsonlDecoder();
      let settled = false;
      let reachedSnapshot = false;
      this.#socket = socket;

      const settle = (connected: boolean) => {
        if (!settled) {
          settled = true;
          resolveConnection(connected);
        }
      };

      socket.once("connect", () => {
        socket.write(
          encodeEnvelope(
            createEnvelope("client.hello", {
              sessionId,
              permission: this.#permission,
              ...(this.#clientId === undefined
                ? {}
                : { clientId: this.#clientId }),
            }),
          ),
        );
      });
      socket.on("data", (chunk) => {
        for (const result of decoder.push(chunk)) {
          if (!result.ok) {
            continue;
          }
          const message = result.value as BrokerEnvelope;
          if (message.type === "snapshot") {
            this.#clientId = message.payload.clientId;
            reachedSnapshot = true;
            this.#connected = true;
            settle(true);
          }
          this.#onMessage(message);
        }
      });
      socket.on("error", () => {
        settle(false);
      });
      socket.once("close", () => {
        if (this.#socket !== socket) {
          settle(false);
          return;
        }
        this.#socket = undefined;
        this.#connected = false;
        settle(false);
        if (!this.#stopping) {
          this.#onDisconnected(reachedSnapshot);
          this.#scheduleReconnect();
        }
      });
    });
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined || this.#stopping) {
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().then((connected) => {
        if (!connected) {
          this.#scheduleReconnect();
        }
      });
    }, this.#reconnectIntervalMs);
  }
}
