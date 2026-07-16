import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { createEnvelope, encodeEnvelope, JsonlDecoder, type BrokerEnvelope } from "../src/protocol.js";
import { probeBroker } from "../src/transport/broker-probe.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  validateConnectEndpoint,
  validateListenEndpoint,
} from "../src/transport/tcp-endpoint.js";

describe("TCP 端点", () => {
  it("集中定义正式本机端点并校验监听与连接地址", () => {
    expect(DEFAULT_BROKER_ENDPOINT).toEqual({ host: "127.0.0.1", port: 43_127 });
    expect(validateListenEndpoint({ host: "0.0.0.0", port: 0 })).toEqual({
      host: "0.0.0.0",
      port: 0,
    });
    expect(() => validateConnectEndpoint({ host: "0.0.0.0", port: 43_127 }))
      .toThrow("只能作为监听地址");
    expect(() => validateConnectEndpoint({ host: "::1", port: 43_127 }))
      .toThrow("必须是 IPv4");
  });
});

describe("TCP Broker 握手", () => {
  let directory: string | undefined;
  let broker: BrokerServer | undefined;
  let unrelated: Server | undefined;
  const unrelatedSockets = new Set<Socket>();

  afterEach(async () => {
    await broker?.close();
    for (const socket of unrelatedSockets) socket.destroy();
    unrelatedSockets.clear();
    await new Promise<void>((resolveClose) => {
      if (unrelated === undefined || !unrelated.listening) return resolveClose();
      unrelated.close(() => resolveClose());
    });
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("通过 probe/ready 确认兼容 Broker", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
    });
    await broker.start();

    await expect(probeBroker(broker.endpoint)).resolves.toEqual({
      status: "compatible",
      brokerInstanceId: broker.instanceId,
    });
  });

  it("拒绝未先完成 probe 的 client.hello", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
    });
    await broker.start();
    const socket = createConnection(broker.endpoint);
    const decoder = new JsonlDecoder();
    const error = new Promise<BrokerEnvelope>((resolveError, rejectError) => {
      const timeout = setTimeout(() => rejectError(new Error("等待握手错误超时")), 1_000);
      socket.on("data", (chunk) => {
        for (const result of decoder.push(chunk)) {
          if (result.ok) {
            clearTimeout(timeout);
            resolveError(result.value as BrokerEnvelope);
          }
        }
      });
    });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    socket.write(encodeEnvelope(createEnvelope("client.hello", {
      sessionId: "without-probe",
      permission: "auto",
    })));
    expect(await error).toMatchObject({
      type: "error",
      payload: { code: "invalid_payload" },
    });
    socket.destroy();
  });

  it("不会把无关 TCP 服务误认为 Broker", async () => {
    unrelated = createServer((socket) => {
      unrelatedSockets.add(socket);
      socket.once("close", () => unrelatedSockets.delete(socket));
      socket.end("not-json\n");
    });
    await listen(unrelated);
    const address = unrelated.address();
    if (address === null || typeof address === "string") throw new Error("未获得 TCP 地址");
    await expect(probeBroker({ host: "127.0.0.1", port: address.port })).resolves.toMatchObject({
      status: "incompatible",
    });
  });

  it("固定端口被占用时返回清晰错误", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    unrelated = createServer();
    await listen(unrelated);
    const address = unrelated.address();
    if (address === null || typeof address === "string") throw new Error("未获得 TCP 地址");
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: address.port },
      dbPath: join(directory, "comms.db"),
    });
    await expect(broker.start()).rejects.toThrow("Broker 端口已被占用");
  });

  it("切换端点时关闭旧连接并连接新 Broker", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    const first = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "first.db"),
    });
    const second = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "second.db"),
    });
    await Promise.all([first.start(), second.start()]);
    const snapshots: string[] = [];
    const client = new BrokerClient({
      endpoint: first.endpoint,
      reconnectIntervalMs: 20,
      onMessage(message) {
        if (message.type === "snapshot") snapshots.push(message.payload.brokerInstanceId);
      },
      onDisconnected() {},
    });
    try {
      await expect(client.start("switch-session")).resolves.toBe(true);
      await expect(client.setEndpoint(second.endpoint)).resolves.toBe(true);
      expect(snapshots).toEqual([first.instanceId, second.instanceId]);
    } finally {
      await client.stop();
      await Promise.all([first.close(), second.close()]);
      broker = undefined;
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
}
