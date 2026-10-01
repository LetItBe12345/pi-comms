import type { BrokerEnvelope, SnapshotPayload } from "../../src/protocol.js";
import { BrokerClient } from "../../src/extension/broker-client.js";
import type { TcpConnectEndpoint } from "../../src/transport/tcp-endpoint.js";

export async function waitUntil(predicate: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Broker state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function brokerSession(endpoint: TcpConnectEndpoint, name: string) {
  const messages: BrokerEnvelope[] = [];
  let snapshot: SnapshotPayload | undefined;
  const client = new BrokerClient({
    endpoint,
    deviceId: "00000000-0000-4000-8000-000000000025",
    onMessage: (message) => {
      messages.push(message);
      if (message.type === "snapshot") snapshot = message.payload;
    },
    onDisconnected() {},
  });
  await client.start(name);
  await waitUntil(() => snapshot !== undefined);
  return { client, messages, get snapshot() { return snapshot!; } };
}
