import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { getLanIPv4Addresses } from "../src/extension/connection-config.js";
import type { BrokerEnvelope } from "../src/protocol.js";

const lanAddress = getLanIPv4Addresses()[0];

class LanSession {
  readonly messages: BrokerEnvelope[] = [];
  readonly client: BrokerClient;

  constructor(
    endpoint: { host: string; port: number },
    deviceId: string,
  ) {
    this.client = new BrokerClient({
      endpoint,
      deviceId,
      reconnectIntervalMs: 20,
      onMessage: (message) => this.messages.push(message),
      onDisconnected() {},
    });
  }

  async start(sessionId: string): Promise<void> {
    expect(await this.client.start(sessionId)).toBe(true);
  }

  send(type: string, payload: unknown): void {
    expect(this.client.send(type, payload)).toBeDefined();
  }

  async waitFor(
    predicate: (message: BrokerEnvelope) => boolean,
    description: string,
  ): Promise<BrokerEnvelope> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const message = this.messages.find(predicate);
      if (message !== undefined) return message;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`等待局域网消息超时：${description}`);
  }
}

describe("真实网络栈三 Session E2E", () => {
  let directory: string | undefined;
  let broker: BrokerServer | undefined;
  const sessions: LanSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.client.stop()));
    sessions.length = 0;
    await broker?.close();
    broker = undefined;
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it.skipIf(lanAddress === undefined && process.env.CI !== "true")(
    "三个远程 Session 经局域网地址完成 Agent 自动转交",
    async () => {
      if (lanAddress === undefined) {
        throw new Error("CI runner 未提供可用的私有 IPv4 地址");
      }
      directory = await mkdtemp(join(tmpdir(), "pi-comms-lan-e2e-"));
      broker = createBrokerServer({
        listen: { host: "0.0.0.0", port: 0 },
        dbPath: join(directory, "comms.db"),
        mode: "lan-host",
        mdnsPublisherFactory: () => ({ async stop() {} }),
        networkAccessRequired: false,
      });
      await broker.start();
      const endpoint = { host: lanAddress, port: broker.endpoint.port };
      const alice = new LanSession(
        { host: "127.0.0.1", port: broker.endpoint.port },
        "00000000-0000-4000-8000-000000000101",
      );
      const bob = new LanSession(endpoint, "00000000-0000-4000-8000-000000000102");
      const carol = new LanSession(endpoint, "00000000-0000-4000-8000-000000000103");
      sessions.push(alice, bob, carol);
      await Promise.all([
        alice.start("lan-alice"),
        bob.start("lan-bob"),
        carol.start("lan-carol"),
      ]);

      alice.send("group.create", {
        groupName: "局域网验收组",
        userName: "Alice",
        agentName: "Alice-Pi",
        visibility: "nearby",
      });
      const aliceSnapshot = await alice.waitFor(
        (message) => message.type === "snapshot" &&
          message.payload.group?.groupName === "局域网验收组",
        "Alice 创建群组",
      );
      if (aliceSnapshot.type !== "snapshot" || aliceSnapshot.payload.group === undefined) {
        throw new Error("未获得群组快照");
      }
      const groupId = aliceSnapshot.payload.group.groupId;
      const welcome = await alice.waitFor(
        (message) => message.type === "membership.welcome" &&
          message.payload.groupId === groupId,
        "Alice 获得群组邀请",
      );
      if (welcome.type !== "membership.welcome" || welcome.payload.inviteCode === undefined) {
        throw new Error("未获得群组邀请码");
      }
      bob.send("group.join", {
        groupId,
        userName: "Bob",
        agentName: "Bob-Pi",
        inviteCode: welcome.payload.inviteCode,
      });
      carol.send("group.join", {
        groupId,
        userName: "Carol",
        agentName: "Carol-Pi",
        inviteCode: welcome.payload.inviteCode,
      });
      await Promise.all([
        bob.waitFor(
          (message) => message.type === "snapshot" &&
            message.payload.group?.groupId === groupId,
          "Bob 加入群组",
        ),
        carol.waitFor(
          (message) => message.type === "snapshot" &&
            message.payload.group?.groupId === groupId,
          "Carol 加入群组",
        ),
      ]);

      alice.send("chat.send", { text: "@Bob-Pi 检查接口并转交 Carol-Pi" });
      const bobDelivery = await bob.waitFor(
        (message) => message.type === "agent.deliver" &&
          message.payload.targetAgentName === "Bob-Pi",
        "Bob Agent 接收任务",
      );
      if (bobDelivery.type !== "agent.deliver") throw new Error("Bob 未收到任务");
      bob.send("agent.deliver.ack", { requestId: bobDelivery.payload.requestId });
      bob.send("agent.result", {
        requestId: bobDelivery.payload.requestId,
        ok: true,
        text: "@Carol-Pi 请完成局域网验收",
      });

      const carolDelivery = await carol.waitFor(
        (message) => message.type === "agent.deliver" &&
          message.payload.targetAgentName === "Carol-Pi",
        "Carol Agent 接收自动转交",
      );
      if (carolDelivery.type !== "agent.deliver") throw new Error("Carol 未收到任务");
      carol.send("agent.deliver.ack", { requestId: carolDelivery.payload.requestId });
      carol.send("agent.result", {
        requestId: carolDelivery.payload.requestId,
        ok: true,
        text: "LAN_E2E_OK",
      });

      await Promise.all(sessions.map((session) =>
        session.waitFor(
          (message) => message.type === "chat.message" &&
            message.payload.senderName === "Carol-Pi" &&
            message.payload.text === "LAN_E2E_OK",
          "所有 Session 收到最终回答",
        ),
      ));
      expect(new Set(sessions.map((session) => session.client.brokerId)))
        .toEqual(new Set([broker!.brokerId]));
    },
    10_000,
  );
});
