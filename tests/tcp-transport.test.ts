import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import {
  readBrokerRuntimeMetadata,
  writeBrokerRuntimeMetadata,
} from "../src/broker/runtime-metadata.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import {
  BROKER_PROTOCOL_VERSION,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../src/protocol.js";
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
  const noMdns = () => ({ async stop() {} });

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
      brokerId: broker.brokerId,
      brokerInstanceId: broker.instanceId,
      brokerMode: "local",
      appVersion: "0.1.0",
      buildChannel: "release",
    });
  });

  it("连接握手不再使用设备级共享邀请码", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-invite-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      mode: "lan-host",
      mdnsPublisherFactory: noMdns,
    });
    await broker.start();
    const received: BrokerEnvelope[] = [];
    const missing = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000010",
      onMessage: (message) => received.push(message),
      onDisconnected() {},
    });
    await expect(missing.start("missing-invite")).resolves.toBe(true);
    await missing.stop();

    const wrong = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000011",
      onMessage: (message) => received.push(message),
      onDisconnected() {},
    });
    await expect(wrong.start("wrong-invite")).resolves.toBe(true);
    expect(received.some((message) => message.type === "snapshot")).toBe(true);
    await wrong.stop();

    const correct = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000012",
      onMessage() {},
      onDisconnected() {},
    });
    await expect(correct.start("correct-invite")).resolves.toBe(true);
    await correct.stop();
  });

  it("主机本机连接免邀请码", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-loopback-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      mode: "lan-host",
      mdnsPublisherFactory: noMdns,
    });
    await broker.start();
    const local = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000013",
      onMessage() {},
      onDisconnected() {},
    });
    await expect(local.start("host-local")).resolves.toBe(true);
    await local.stop();
  });

  it("旧设备邀请码不会影响连接结果", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-rate-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      mode: "lan-host",
      mdnsPublisherFactory: noMdns,
    });
    await broker.start();
    const client = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000020",
      onMessage() {},
      onDisconnected() {},
    });
    await expect(client.start("old-device-invite")).resolves.toBe(true);
    expect(client.lastError).toBeUndefined();
    await client.stop();
  });

  it("保存的 brokerId 不匹配时拒绝连接", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-identity-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
    });
    await broker.start();
    const client = new BrokerClient({
      endpoint: broker.endpoint,
      expectedBrokerId: "00000000-0000-4000-8000-000000000099",
      deviceId: "00000000-0000-4000-8000-000000000014",
      onMessage() {},
      onDisconnected() {},
    });
    await expect(client.start("wrong-space")).resolves.toBe(false);
    expect(client.lastError).toBe("附近设备信息已变化，请重新查找");
    await client.stop();
  });

  it("brokerId 跨重启稳定，并安全覆盖和清理运行元数据", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-runtime-"));
    const dbPath = join(directory, "comms.db");
    await writeBrokerRuntimeMetadata(dbPath, {
      brokerId: "stale",
      brokerInstanceId: "stale",
      pid: 999_999,
      host: "127.0.0.1",
      port: 1,
      mode: "local",
      startedAt: 1,
    });
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath,
    });
    await broker.start();
    const brokerId = broker.brokerId;
    await expect(readBrokerRuntimeMetadata(dbPath)).resolves.toMatchObject({
      brokerId,
      brokerInstanceId: broker.instanceId,
      pid: process.pid,
      host: "127.0.0.1",
      port: broker.endpoint.port,
      mode: "local",
    });
    await broker.close();
    broker = undefined;
    await expect(readBrokerRuntimeMetadata(dbPath)).resolves.toBeUndefined();

    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath,
    });
    await broker.start();
    expect(broker.brokerId).toBe(brokerId);
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
      protocolVersion: BROKER_PROTOCOL_VERSION,
      deviceId: "00000000-0000-4000-8000-000000000001",
      sessionId: "without-probe",
      permission: "auto",
    })));
    expect(await error).toMatchObject({
      type: "error",
      payload: { code: "invalid_payload" },
    });
    socket.destroy();
  });

  it("协议版本不一致时返回明确错误并关闭连接", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
    });
    await broker.start();
    const socket = createConnection(broker.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write(encodeEnvelope(createEnvelope("broker.probe", {
      service: "pi-comms",
      protocolVersion: 1,
    })));
    expect(await waitSocketMessage(socket)).toMatchObject({
      type: "error",
      payload: { code: "protocol_mismatch" },
    });
    await closed;
  });

  it("未发送 client.hello 的连接会超时关闭", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      helloTimeoutMs: 40,
    });
    await broker.start();
    const socket = createConnection(broker.endpoint);
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    expect(await waitSocketMessage(socket)).toMatchObject({
      type: "error",
      payload: { code: "hello_timeout" },
    });
    await closed;
  });

  it("客户端停止心跳后 Broker 判定失联", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      heartbeatTimeoutMs: 60,
      disconnectGraceMs: 20,
    });
    await broker.start();
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    const errors: BrokerEnvelope[] = [];
    const client = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000001",
      heartbeatIntervalMs: 1_000,
      reconnectIntervalMs: 1_000,
      onMessage(message) {
        if (message.type === "error") errors.push(message);
      },
      onDisconnected() { resolveDisconnected(); },
    });
    try {
      await expect(client.start("heartbeat-session")).resolves.toBe(true);
      await Promise.race([
        disconnected,
        new Promise((_, reject) => setTimeout(() => reject(new Error("等待心跳超时")), 500)),
      ]);
      expect(errors).toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({ code: "heartbeat_timeout" }),
      }));
    } finally {
      await client.stop();
    }
  });

  it("正常心跳让连接持续在线", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      heartbeatTimeoutMs: 70,
    });
    await broker.start();
    const client = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000001",
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60,
      onMessage() {},
      onDisconnected() {},
    });
    try {
      await expect(client.start("healthy-heartbeat")).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(client.connected).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("超大 JSONL 帧返回 frame_too_large 并关闭连接", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-tcp-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      maxFrameBytes: 64,
    });
    await broker.start();
    const socket = createConnection(broker.endpoint);
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    const message = waitSocketMessage(socket);
    socket.write("x".repeat(65));
    expect(await message).toMatchObject({
      type: "error",
      payload: { code: "frame_too_large" },
    });
    await closed;
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
      deviceId: "00000000-0000-4000-8000-000000000001",
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

function waitSocketMessage(socket: Socket): Promise<BrokerEnvelope> {
  const decoder = new JsonlDecoder();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("等待 Broker 消息超时")), 1_000);
    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) continue;
        clearTimeout(timeout);
        resolve(result.value as BrokerEnvelope);
      }
    });
  });
}
