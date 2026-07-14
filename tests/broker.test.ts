import { writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
  type AgentResultPayload,
  type ChatSendPayload,
} from "../src/protocol.js";
import {
  createBrokerServer,
  type BrokerServer,
} from "../src/broker/server.js";

type BrokerEnvelopeType = BrokerEnvelope["type"];
type EnvelopeByType<T extends BrokerEnvelopeType> = Extract<
  BrokerEnvelope,
  { type: T }
>;

class TestClient {
  readonly messages: BrokerEnvelope[] = [];
  readonly #socket: Socket;
  readonly #decoder = new JsonlDecoder();
  readonly #listeners = new Set<() => void>();

  private constructor(socketPath: string) {
    this.#socket = createConnection(socketPath);
    this.#socket.on("data", (chunk) => {
      for (const result of this.#decoder.push(chunk)) {
        if (!result.ok) {
          throw new Error(result.error);
        }
        this.messages.push(result.value as BrokerEnvelope);
        for (const listener of this.#listeners) {
          listener();
        }
      }
    });
  }

  static async connect(socketPath: string): Promise<TestClient> {
    const client = new TestClient(socketPath);
    await new Promise<void>((resolveConnection, rejectConnection) => {
      client.#socket.once("connect", resolveConnection);
      client.#socket.once("error", rejectConnection);
    });
    return client;
  }

  send(id: string, payload: ChatSendPayload): void {
    this.#socket.write(
      encodeEnvelope(
        createEnvelope("chat.send", payload, { id, timestamp: 1 }),
      ),
    );
  }

  sendResult(id: string, payload: AgentResultPayload): void {
    this.#socket.write(
      encodeEnvelope(
        createEnvelope("agent.result", payload, { id, timestamp: 1 }),
      ),
    );
  }

  writeRaw(value: string): void {
    this.#socket.write(value);
  }

  async waitFor<T extends BrokerEnvelopeType>(
    type: T,
    predicate: (message: EnvelopeByType<T>) => boolean = () => true,
  ): Promise<EnvelopeByType<T>> {
    const findMessage = () =>
      this.messages.find(
        (message): message is EnvelopeByType<T> =>
          message.type === type && predicate(message as EnvelopeByType<T>),
      );
    const existing = findMessage();
    if (existing) {
      return existing;
    }

    return new Promise<EnvelopeByType<T>>((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.#listeners.delete(check);
        rejectMessage(new Error(`等待 ${type} 超时`));
      }, 1_000);
      const check = () => {
        const message = findMessage();
        if (!message) {
          return;
        }
        clearTimeout(timeout);
        this.#listeners.delete(check);
        resolveMessage(message);
      };

      this.#listeners.add(check);
    });
  }

  async close(): Promise<void> {
    if (this.#socket.destroyed) {
      return;
    }
    await new Promise<void>((resolveClose) => {
      this.#socket.once("close", resolveClose);
      this.#socket.end();
    });
  }
}

describe("Local Broker", () => {
  let directory: string;
  let socketPath: string;
  let broker: BrokerServer;
  let clients: TestClient[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-"));
    socketPath = join(directory, "broker.sock");
    broker = createBrokerServer({ socketPath });
    clients = [];
    await broker.start();
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connectClient(): Promise<{
    client: TestClient;
    clientId: string;
  }> {
    const client = await TestClient.connect(socketPath);
    clients.push(client);
    const snapshot = await client.waitFor("snapshot");
    return { client, clientId: snapshot.payload.clientId };
  }

  it("给 A 和 B 分配 ID，并发布在线状态", async () => {
    const a = await connectClient();
    const b = await connectClient();

    const bOnline = await a.client.waitFor(
      "presence.changed",
      (message) =>
        message.payload.clientId === b.clientId && message.payload.online,
    );
    const bSnapshot = await b.client.waitFor("snapshot");

    expect(a.clientId).not.toBe(b.clientId);
    expect(bOnline.payload.online).toBe(true);
    expect(new Set(bSnapshot.payload.clients)).toEqual(
      new Set([a.clientId, b.clientId]),
    );
  });

  it("把 A 的公开消息发送给 A 和 B", async () => {
    const a = await connectClient();
    const b = await connectClient();

    a.client.send("public-1", { text: "公开消息" });

    const [messageForA, messageForB] = await Promise.all([
      a.client.waitFor("chat.message", (message) => message.id === "public-1"),
      b.client.waitFor("chat.message", (message) => message.id === "public-1"),
    ]);
    expect(messageForA.payload).toEqual({
      senderClientId: a.clientId,
      text: "公开消息",
    });
    expect(messageForA.timestamp).toBeGreaterThan(1);
    expect(messageForB).toEqual(messageForA);
  });

  it("把 A 的定向消息只发送给 B", async () => {
    const a = await connectClient();
    const b = await connectClient();

    a.client.send("direct-1", {
      text: "只给 B",
      targetClientId: b.clientId,
    });

    const messageForB = await b.client.waitFor(
      "chat.message",
      (message) => message.id === "direct-1",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));

    expect(messageForB.payload).toEqual({
      senderClientId: a.clientId,
      text: "只给 B",
      targetClientId: b.clientId,
    });
    expect(
      a.client.messages.some(
        (message) => message.type === "chat.message" && message.id === "direct-1",
      ),
    ).toBe(false);
  });

  it("公开 @ 请求并只向目标发送 agent.deliver", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const c = await connectClient();
    const text = `@${b.clientId} 只回复 STAGE3_OK`;

    a.client.send("request-1", { text });

    const [publicA, publicB, publicC, delivery] = await Promise.all([
      a.client.waitFor("chat.message", (message) => message.id === "request-1"),
      b.client.waitFor("chat.message", (message) => message.id === "request-1"),
      c.client.waitFor("chat.message", (message) => message.id === "request-1"),
      b.client.waitFor(
        "agent.deliver",
        (message) => message.payload.requestId === "request-1",
      ),
    ]);

    expect(publicA).toEqual(publicB);
    expect(publicB).toEqual(publicC);
    expect(publicA.payload).toMatchObject({
      senderClientId: a.clientId,
      targetClientId: b.clientId,
      requestId: "request-1",
      text,
    });
    expect(delivery.payload).toEqual({
      requestId: "request-1",
      groupId: "default",
      senderId: a.clientId,
      senderName: `Client-${a.clientId.slice(0, 8)}`,
      targetAgentId: b.clientId,
      text: "只回复 STAGE3_OK",
      chainId: "request-1",
      round: 1,
    });
    expect(
      c.client.messages.some((message) => message.type === "agent.deliver"),
    ).toBe(false);
  });

  it("只接受目标的一次 Agent 回答并公开广播", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const c = await connectClient();
    a.client.send("request-result", {
      text: `@${b.clientId} 请回答`,
    });
    await b.client.waitFor("agent.deliver");

    c.client.sendResult("fake-result", {
      requestId: "request-result",
      ok: true,
      text: "伪造回答",
    });
    const rejected = await c.client.waitFor("error");
    b.client.sendResult("real-result", {
      requestId: "request-result",
      ok: true,
      text: "真实回答",
    });
    const answer = await a.client.waitFor(
      "chat.message",
      (message) =>
        message.payload.kind === "agent" &&
        message.payload.requestId === "request-result",
    );
    b.client.sendResult("duplicate-result", {
      requestId: "request-result",
      ok: true,
      text: "重复回答",
    });
    const duplicate = await b.client.waitFor(
      "error",
      (message) => message.payload.requestId === "request-result",
    );

    expect(rejected.payload.requestId).toBe("request-result");
    expect(answer.payload).toEqual({
      senderClientId: b.clientId,
      text: "真实回答",
      requestId: "request-result",
      kind: "agent",
    });
    expect(duplicate.payload.message).toContain("没有对应");
  });

  it("公开 @ 离线目标及失败状态", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const offlineId = "12345678-1234-4123-8123-123456789abc";

    a.client.send("offline-agent", {
      text: `@${offlineId} 在吗`,
    });

    const [publicMessage, failureForA, failureForB] = await Promise.all([
      b.client.waitFor(
        "chat.message",
        (message) => message.id === "offline-agent",
      ),
      a.client.waitFor(
        "send.failed",
        (message) => message.payload.requestId === "offline-agent",
      ),
      b.client.waitFor(
        "send.failed",
        (message) => message.payload.requestId === "offline-agent",
      ),
    ]);

    expect(publicMessage.payload.targetClientId).toBe(offlineId);
    expect(failureForA).toEqual(failureForB);
    expect(failureForA.payload.reason).toBe("target_offline");
  });

  it("格式错误的 @ 请求只向发送者返回错误", async () => {
    const a = await connectClient();
    const b = await connectClient();

    a.client.send("invalid-mention", { text: "@不是完整ID 消息" });
    const error = await a.client.waitFor(
      "error",
      (message) => message.payload.requestId === "invalid-mention",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));

    expect(error.payload.message).toContain("@Agent 格式");
    expect(
      b.client.messages.some(
        (message) =>
          message.type === "chat.message" && message.id === "invalid-mention",
      ),
    ).toBe(false);
  });

  it("目标接收请求后断线会公开失败", async () => {
    const a = await connectClient();
    const b = await connectClient();
    a.client.send("disconnect-agent", {
      text: `@${b.clientId} 请回答`,
    });
    await b.client.waitFor("agent.deliver");

    await b.client.close();
    const failed = await a.client.waitFor(
      "send.failed",
      (message) => message.payload.requestId === "disconnect-agent",
    );

    expect(failed.payload.reason).toBe("target_disconnected");
  });

  it("目标断开后返回失败，Broker 继续服务", async () => {
    const a = await connectClient();
    const b = await connectClient();
    await b.client.close();

    await a.client.waitFor(
      "presence.changed",
      (message) =>
        message.payload.clientId === b.clientId && !message.payload.online,
    );
    a.client.send("offline-1", {
      text: "还在吗",
      targetClientId: b.clientId,
    });

    const failed = await a.client.waitFor(
      "send.failed",
      (message) => message.payload.requestId === "offline-1",
    );
    const c = await connectClient();
    a.client.send("after-disconnect", { text: "继续工作" });
    const messageForC = await c.client.waitFor(
      "chat.message",
      (message) => message.id === "after-disconnect",
    );

    expect(failed.payload).toEqual({
      requestId: "offline-1",
      targetClientId: b.clientId,
      reason: "target_offline",
    });
    expect(messageForC.payload.text).toBe("继续工作");
  });

  it("坏消息返回错误但不关闭连接", async () => {
    const a = await connectClient();
    a.client.writeRaw("{bad json}\n");

    const error = await a.client.waitFor("error");
    a.client.send("after-error", { text: "仍然在线" });
    const message = await a.client.waitFor(
      "chat.message",
      (item) => item.id === "after-error",
    );

    expect(error.payload.code).toBe("invalid_json");
    expect(message.payload.text).toBe("仍然在线");
  });

  it("拒绝在同一路径启动第二个 Broker", async () => {
    const anotherBroker = createBrokerServer({ socketPath });

    await expect(anotherBroker.start()).rejects.toThrow("Broker 已经在运行");
  });

  it("启动时清理失效的 Socket 文件", async () => {
    const stalePath = join(directory, "stale.sock");
    await writeFile(stalePath, "stale");
    const anotherBroker = createBrokerServer({ socketPath: stalePath });

    await anotherBroker.start();
    const client = await TestClient.connect(stalePath);
    const snapshot = await client.waitFor("snapshot");

    expect(snapshot.payload.clientId).toBeTypeOf("string");
    await client.close();
    await anotherBroker.close();
  });
});
