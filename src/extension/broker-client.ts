import { createConnection, type Socket } from "node:net";
import { loadOrCreateDeviceId } from "../device-identity.js";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
} from "../transport/broker-probe.js";
import {
  sameEndpoint,
  validateConnectEndpoint,
  type TcpConnectEndpoint,
} from "../transport/tcp-endpoint.js";
import type { AgentPermission } from "../types.js";

const DEFAULT_RECONNECT_INTERVAL_MS = 1_000;
const DEFAULT_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

export interface BrokerClientOptions {
  endpoint: TcpConnectEndpoint;
  reconnectIntervalMs?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  keepAliveInitialDelayMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  deviceId?: string;
  onMessage(message: BrokerEnvelope): void;
  onDisconnected(wasConnected: boolean): void;
}

export class BrokerClient {
  #endpoint: TcpConnectEndpoint;
  readonly #reconnectIntervalMs: number;
  readonly #connectTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #keepAliveInitialDelayMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #onMessage: (message: BrokerEnvelope) => void;
  readonly #onDisconnected: (wasConnected: boolean) => void;
  #sessionId: string | undefined;
  #deviceId: string | undefined;
  #clientId: string | undefined;
  #resumeToken: string | undefined;
  #brokerInstanceId: string | undefined;
  #socket: Socket | undefined;
  #connectTask: Promise<boolean> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastPongAt = 0;
  #connected = false;
  #stopping = false;
  #switching = false;
  #permission: AgentPermission = "auto";
  #lastError: string | undefined;
  #permanentError = false;

  constructor(options: BrokerClientOptions) {
    this.#endpoint = validateConnectEndpoint(options.endpoint);
    this.#reconnectIntervalMs =
      options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#keepAliveInitialDelayMs =
      options.keepAliveInitialDelayMs ?? DEFAULT_KEEPALIVE_INITIAL_DELAY_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#deviceId = options.deviceId;
    this.#onMessage = options.onMessage;
    this.#onDisconnected = options.onDisconnected;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get endpoint(): TcpConnectEndpoint {
    return { ...this.#endpoint };
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  async start(sessionId: string, permission: AgentPermission = "auto"): Promise<boolean> {
    this.#sessionId = sessionId;
    this.#permission = permission;
    this.#stopping = false;
    this.#permanentError = false;
    try {
      this.#deviceId ??= loadOrCreateDeviceId();
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
    return this.connect();
  }

  async setEndpoint(endpoint: TcpConnectEndpoint): Promise<boolean> {
    const next = validateConnectEndpoint(endpoint);
    if (sameEndpoint(this.#endpoint, next)) return this.#connected;

    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#switching = true;
    const socket = this.#socket;
    const closed = socket === undefined || socket.destroyed
      ? Promise.resolve()
      : new Promise<void>((resolveClose) => socket.once("close", resolveClose));
    socket?.destroy();
    await Promise.all([this.#connectTask, closed]);
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#endpoint = next;
    this.#connected = false;
    this.#lastError = undefined;
    this.#permanentError = false;
    this.#switching = false;
    return this.#sessionId === undefined || this.#stopping ? false : this.connect();
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
    const task = this.#openConnection();
    this.#connectTask = task;
    try {
      return await task;
    } finally {
      if (this.#connectTask === task) this.#connectTask = undefined;
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
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connected = false;
    this.#lastError = undefined;
    if (socket === undefined || socket.destroyed) {
      return;
    }

    await new Promise<void>((resolveClose) => {
      socket.once("close", resolveClose);
      socket.end(
        encodeEnvelope(
          createEnvelope("client.goodbye", {}),
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

      const socket = createConnection(this.#endpoint);
      const decoder = new JsonlDecoder();
      let settled = false;
      let reachedSnapshot = false;
      let reachedWelcome = false;
      let acceptedProbe = false;
      const probe = createEnvelope("broker.probe", {
        service: BROKER_SERVICE,
        protocolVersion: BROKER_PROTOCOL_VERSION,
      });
      let timer = setTimeout(() => {
        this.#lastError = "连接 Broker 超时";
        socket.destroy();
        settle(false);
      }, this.#connectTimeoutMs);
      this.#socket = socket;

      const settle = (connected: boolean) => {
        if (!settled) {
          settled = true;
          resolveConnection(connected);
        }
      };

      socket.on("data", (chunk) => {
        for (const result of decoder.push(chunk)) {
          if (!result.ok) {
            this.#lastError = result.error;
            if (result.code === "frame_too_large") this.#permanentError = true;
            socket.destroy();
            settle(false);
            return;
          }
          const message = result.value as BrokerEnvelope;
          if (message.type === "error" && !reachedSnapshot) {
            this.#lastError = message.payload.message;
            if (message.payload.code === "protocol_mismatch") {
              this.#permanentError = true;
            }
            if (message.payload.code === "resume_rejected") {
              this.#clientId = undefined;
              this.#resumeToken = undefined;
            }
            socket.destroy();
            settle(false);
            return;
          }
          if (message.type === "broker.ready") {
            if (message.payload.requestId !== probe.id) continue;
            if (
              message.payload.service !== BROKER_SERVICE ||
              message.payload.protocolVersion !== BROKER_PROTOCOL_VERSION
            ) {
              this.#lastError = "Pi Comms 协议版本不兼容";
              this.#permanentError = true;
              socket.destroy();
              settle(false);
              return;
            }
            if (
              this.#brokerInstanceId !== undefined &&
              this.#brokerInstanceId !== message.payload.brokerInstanceId
            ) {
              this.#clientId = undefined;
              this.#resumeToken = undefined;
            }
            this.#brokerInstanceId = message.payload.brokerInstanceId;
            acceptedProbe = true;
            clearTimeout(timer);
            timer = setTimeout(() => {
              this.#lastError = "client.hello 握手超时";
              socket.destroy();
              settle(false);
            }, this.#handshakeTimeoutMs);
            socket.write(encodeEnvelope(createEnvelope("client.hello", {
              protocolVersion: BROKER_PROTOCOL_VERSION,
              deviceId: this.#deviceId!,
              sessionId,
              permission: this.#permission,
              ...(this.#clientId === undefined || this.#resumeToken === undefined
                ? {}
                : { clientId: this.#clientId, resumeToken: this.#resumeToken }),
            })));
            continue;
          }
          if (message.type === "client.welcome" && acceptedProbe) {
            this.#brokerInstanceId = message.payload.brokerInstanceId;
            this.#clientId = message.payload.clientId;
            this.#resumeToken = message.payload.resumeToken;
            reachedWelcome = true;
            continue;
          }
          if (message.type === "pong") {
            this.#lastPongAt = Date.now();
            continue;
          }
          if (message.type === "snapshot" && reachedWelcome) {
            clearTimeout(timer);
            reachedSnapshot = true;
            this.#connected = true;
            this.#lastError = undefined;
            this.#startHeartbeat(socket);
            settle(true);
          }
          this.#onMessage(message);
        }
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setKeepAlive(true, this.#keepAliveInitialDelayMs);
        timer = setTimeout(() => {
          this.#lastError = "端口上的服务不是兼容的 Pi Comms Broker（握手超时）";
          socket.destroy();
          settle(false);
        }, this.#handshakeTimeoutMs);
        socket.write(encodeEnvelope(probe));
      });
      socket.on("error", (error) => {
        this.#lastError ??= error.message;
        settle(false);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        if (this.#socket !== socket) {
          settle(false);
          return;
        }
        this.#socket = undefined;
        this.#connected = false;
        this.#stopHeartbeat();
        settle(false);
        if (!this.#stopping && !this.#switching && !this.#permanentError) {
          this.#onDisconnected(reachedSnapshot);
          this.#scheduleReconnect();
        }
      });
    });
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined || this.#stopping || this.#permanentError) {
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

  #startHeartbeat(socket: Socket): void {
    this.#stopHeartbeat();
    this.#lastPongAt = Date.now();
    this.#heartbeatTimer = setInterval(() => {
      if (Date.now() - this.#lastPongAt >= this.#heartbeatTimeoutMs) {
        this.#lastError = "Broker 心跳超时";
        socket.destroy();
        return;
      }
      if (!socket.destroyed) {
        socket.write(encodeEnvelope(createEnvelope("ping", {})));
      }
    }, this.#heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }
}
