import { createConnection } from "node:net";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";
import { validateConnectEndpoint, type TcpConnectEndpoint } from "./tcp-endpoint.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_500;

export type BrokerProbeResult =
  | { status: "compatible"; brokerInstanceId: string }
  | { status: "unreachable" }
  | { status: "incompatible"; reason: string };

export function probeBroker(
  target: TcpConnectEndpoint,
  options: { connectTimeoutMs?: number; handshakeTimeoutMs?: number } = {},
): Promise<BrokerProbeResult> {
  const endpoint = validateConnectEndpoint(target);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  return new Promise((resolveProbe) => {
    const socket = createConnection(endpoint);
    const decoder = new JsonlDecoder();
    const probe = createEnvelope("broker.probe", {
      service: BROKER_SERVICE,
      protocolVersion: BROKER_PROTOCOL_VERSION,
    });
    let settled = false;
    let connected = false;
    let timer = setTimeout(() => finish({ status: "unreachable" }), connectTimeoutMs);

    const finish = (result: BrokerProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };

    socket.once("connect", () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => finish({ status: "incompatible", reason: "Broker 握手超时" }),
        handshakeTimeoutMs,
      );
      socket.write(encodeEnvelope(probe));
    });
    socket.on("data", (chunk) => {
      for (const decoded of decoder.push(chunk)) {
        if (!decoded.ok) {
          finish({ status: "incompatible", reason: decoded.error });
          return;
        }
        const message = decoded.value as BrokerEnvelope;
        if (message.type !== "broker.ready" || message.payload.requestId !== probe.id) {
          continue;
        }
        if (
          message.payload.service !== BROKER_SERVICE ||
          message.payload.protocolVersion !== BROKER_PROTOCOL_VERSION
        ) {
          finish({ status: "incompatible", reason: "Pi Comms 协议版本不兼容" });
          return;
        }
        finish({ status: "compatible", brokerInstanceId: message.payload.brokerInstanceId });
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(connected
        ? { status: "incompatible", reason: error.message }
        : { status: "unreachable" });
    });
    socket.once("close", () => {
      finish(connected
        ? { status: "incompatible", reason: "连接在握手前关闭" }
        : { status: "unreachable" });
    });
  });
}
