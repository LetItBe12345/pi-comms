import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type AgentResultPayload,
  type BrokerEnvelope,
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
  readonly sessionId: string;
  readonly #socket: Socket;
  readonly #decoder = new JsonlDecoder();
  readonly #listeners = new Set<() => void>();

  private constructor(socketPath: string, sessionId: string) {
    this.sessionId = sessionId;
    this.#socket = createConnection(socketPath);
    this.#socket.once("connect", () => {
      this.send("client.hello", { sessionId });
    });
    this.#socket.on("data", (chunk) => {
      for (const result of this.#decoder.push(chunk)) {
        if (!result.ok) throw new Error(result.error);
        this.messages.push(result.value as BrokerEnvelope);
        for (const listener of this.#listeners) listener();
      }
    });
  }

  static async connect(
    socketPath: string,
    sessionId: string = randomUUID(),
  ): Promise<TestClient> {
    const client = new TestClient(socketPath, sessionId);
    await new Promise<void>((resolve, reject) => {
      client.#socket.once("connect", resolve);
      client.#socket.once("error", reject);
    });
    await client.waitFor("snapshot");
    return client;
  }

  send(type: string, payload: unknown, id: string = randomUUID()): string {
    this.#socket.write(
      encodeEnvelope(createEnvelope(type, payload, { id, timestamp: 1 })),
    );
    return id;
  }

  sendResult(payload: AgentResultPayload): void {
    this.send("agent.result", payload);
  }

  writeRaw(value: string): void {
    this.#socket.write(value);
  }

  async waitFor<T extends BrokerEnvelopeType>(
    type: T,
    predicate: (message: EnvelopeByType<T>) => boolean = () => true,
  ): Promise<EnvelopeByType<T>> {
    const find = () =>
      this.messages.find(
        (message): message is EnvelopeByType<T> =>
          message.type === type && predicate(message as EnvelopeByType<T>),
      );
    const existing = find();
    if (existing) return existing;
    return new Promise<EnvelopeByType<T>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#listeners.delete(check);
        reject(new Error(`等待 ${type} 超时`));
      }, 1_000);
      const check = () => {
        const message = find();
        if (!message) return;
        clearTimeout(timeout);
        this.#listeners.delete(check);
        resolve(message);
      };
      this.#listeners.add(check);
    });
  }

  async close(): Promise<void> {
    if (this.#socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.destroy();
    });
  }
}

describe("Local Broker 群组与成员", () => {
  let directory: string;
  let socketPath: string;
  let dbPath: string;
  let broker: BrokerServer;
  let clients: TestClient[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-"));
    socketPath = join(directory, "broker.sock");
    dbPath = join(directory, "comms.db");
    broker = createBrokerServer({ socketPath, dbPath, disconnectGraceMs: 80 });
    clients = [];
    await broker.start();
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connect(sessionId?: string): Promise<TestClient> {
    const client = await TestClient.connect(socketPath, sessionId);
    clients.push(client);
    return client;
  }

  async function createGroup(
    client: TestClient,
    groupName = "开发组",
    userName = "Alice",
    agentName = "Alice-Pi",
  ) {
    client.send("group.create", { groupName, userName, agentName });
    return client.waitFor("snapshot", (message) => message.payload.group !== undefined);
  }

  async function joinGroup(
    client: TestClient,
    groupId: string,
    userName = "Bob",
    agentName = "Bob-Pi",
  ) {
    client.send("group.join", { groupId, userName, agentName });
    return client.waitFor(
      "snapshot",
      (message) => message.payload.group?.groupId === groupId,
    );
  }

  it("连接后不自动入群，并返回本机群组列表", async () => {
    const a = await connect();
    const initial = await a.waitFor("snapshot");
    expect(initial.payload).toMatchObject({
      brokerInstanceId: broker.instanceId,
      groups: [],
      members: [],
    });
    expect(initial.payload.group).toBeUndefined();

    const created = await createGroup(a);
    const b = await connect();
    const bSnapshot = await b.waitFor("snapshot");
    expect(bSnapshot.payload.groups).toEqual([
      {
        groupId: created.payload.group!.groupId,
        groupName: "开发组",
        onlineSessionCount: 1,
      },
    ]);
  });

  it("两个 Session 入群后看到四个稳定成员", async () => {
    const a = await connect("session-a");
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect("session-b");
    const joined = await joinGroup(b, groupId);

    expect(joined.payload.members.map((member) => member.displayName)).toEqual([
      "Alice",
      "Alice-Pi",
      "Bob",
      "Bob-Pi",
    ]);
    const bClientId = joined.payload.clientId;
    expect(joined.payload.members).toContainEqual({
      memberId: `user:${bClientId}`,
      clientId: bClientId,
      type: "user",
      displayName: "Bob",
      groupId,
      online: true,
    });
    const online = await a.waitFor(
      "presence.changed",
      (message) => message.payload.displayName === "Bob-Pi",
    );
    expect(online.payload.memberId).toBe(`agent:${bClientId}`);

    b.send("agent.status", { status: "busy" });
    const busy = await a.waitFor(
      "presence.changed",
      (message) =>
        message.payload.displayName === "Bob-Pi" &&
        message.payload.agentStatus === "busy",
    );
    expect(busy.payload.type).toBe("agent");
  });

  it("断线恢复期显示离线，超时后明确移除成员", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const b = await connect();
    const joined = await joinGroup(b, created.payload.group!.groupId);
    const bClientId = joined.payload.clientId;

    await b.close();
    await a.waitFor(
      "presence.changed",
      (message) => message.payload.clientId === bClientId && !message.payload.online,
    );
    const removed = await a.waitFor(
      "presence.removed",
      (message) => message.payload.memberIds.includes(`user:${bClientId}`),
    );
    expect(removed.payload.memberIds).toEqual([
      `user:${bClientId}`,
      `agent:${bClientId}`,
    ]);
  });

  it("拒绝非法名称、大小写冲突和重复入群", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect();
    b.send("group.join", { groupId, userName: "alice", agentName: "Bob-Pi" }, "name-conflict");
    expect(
      await b.waitFor("error", (message) => message.payload.requestId === "name-conflict"),
    ).toMatchObject({ payload: { code: "member_name_conflict" } });

    const c = await connect();
    c.send("group.create", {
      groupName: "非法 群",
      userName: "Carol",
      agentName: "Carol-Pi",
    }, "invalid-name");
    expect(
      await c.waitFor("error", (message) => message.payload.requestId === "invalid-name"),
    ).toMatchObject({ payload: { code: "invalid_name" } });

    a.send("group.create", {
      groupName: "新群",
      userName: "A2",
      agentName: "A2-Pi",
    }, "already-in-group");
    expect(
      await a.waitFor("error", (message) => message.payload.requestId === "already-in-group"),
    ).toMatchObject({ payload: { code: "already_in_group" } });
  });

  it("群名唯一，空群保留且离群后可以加入其他群", async () => {
    const a = await connect();
    const first = await createGroup(a, "Team-A");
    const firstId = first.payload.group!.groupId;
    a.send("group.leave", {}, "leave-a");
    await a.waitFor("snapshot", (message) => message.payload.group === undefined && message.payload.groups.length === 1);

    const b = await connect();
    b.send("group.create", {
      groupName: "team-a",
      userName: "Bob",
      agentName: "Bob-Pi",
    }, "duplicate-group");
    expect(
      await b.waitFor("error", (message) => message.payload.requestId === "duplicate-group"),
    ).toMatchObject({ payload: { code: "group_name_conflict" } });

    const rejoined = await joinGroup(a, firstId, "Alice2", "Alice2-Pi");
    expect(rejoined.payload.group?.groupId).toBe(firstId);
  });

  it("群聊和成员事件严格按群隔离", async () => {
    const a = await connect();
    const groupA = await createGroup(a, "A群");
    const b = await connect();
    await joinGroup(b, groupA.payload.group!.groupId);
    const c = await connect();
    await createGroup(c, "C群", "Carol", "Carol-Pi");

    a.send("chat.send", { text: "只在 A 群" }, "group-message");
    await Promise.all([
      a.waitFor("chat.message", (message) => message.id === "group-message"),
      b.waitFor("chat.message", (message) => message.id === "group-message"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      c.messages.some((message) => message.type === "chat.message" && message.id === "group-message"),
    ).toBe(false);
  });

  it("按 Agent 名称公开消息并注入完整群组上下文", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect();
    await joinGroup(b, groupId);
    const c = await connect();
    await joinGroup(c, groupId, "Carol", "Carol-Pi");

    a.send("chat.send", { text: "@bob-pi  原样正文" }, "agent-request");
    const [publicMessage, delivery] = await Promise.all([
      c.waitFor("chat.message", (message) => message.id === "agent-request"),
      b.waitFor("agent.deliver", (message) => message.payload.requestId === "agent-request"),
    ]);
    expect(publicMessage.payload).toMatchObject({
      senderId: expect.stringMatching(/^user:/),
      senderName: "Alice",
      senderType: "user",
      text: "@bob-pi  原样正文",
      mentionIds: [expect.stringMatching(/^agent:/)],
    });
    expect(delivery.payload).toMatchObject({
      groupId,
      groupName: "开发组",
      senderName: "Alice",
      targetAgentName: "Bob-Pi",
      ownerUserName: "Bob",
      text: "原样正文",
      round: 1,
    });
    expect(delivery.payload.onlineMembers).not.toContainEqual({
      displayName: "Bob-Pi",
      type: "agent",
    });
    expect(delivery.payload.onlineMembers).toContainEqual({
      displayName: "Bob",
      type: "user",
    });
    expect(c.messages.some((message) => message.type === "agent.deliver")).toBe(false);
  });

  it("@用户只公开提醒，不注入 Agent", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const b = await connect();
    await joinGroup(b, created.payload.group!.groupId);
    a.send("chat.send", { text: "@Bob 请查看" }, "user-mention");
    const message = await b.waitFor("chat.message", (item) => item.id === "user-mention");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(message.payload.mentionIds).toEqual([expect.stringMatching(/^user:/)]);
    expect(b.messages.some((item) => item.type === "agent.deliver")).toBe(false);
  });

  it("目标不存在或离线时公开消息和失败状态", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect("session-b");
    await joinGroup(b, groupId);

    a.send("chat.send", { text: "@Nobody 在吗" }, "missing-target");
    await a.waitFor("chat.message", (message) => message.id === "missing-target");
    expect(
      await a.waitFor("send.failed", (message) => message.payload.requestId === "missing-target"),
    ).toMatchObject({ payload: { reason: "target_not_found" } });

    await b.close();
    await a.waitFor("presence.changed", (message) => message.payload.displayName === "Bob-Pi" && !message.payload.online);
    a.send("chat.send", { text: "@Bob-Pi 在吗" }, "offline-target");
    expect(
      await a.waitFor("send.failed", (message) => message.payload.requestId === "offline-target"),
    ).toMatchObject({ payload: { reason: "target_offline" } });
  });

  it("短暂断线恢复成员 ID，并重新投递未确认请求", async () => {
    const a = await connect("session-a");
    const created = await createGroup(a);
    const b = await connect("session-b");
    const joined = await joinGroup(b, created.payload.group!.groupId);
    const oldAgent = joined.payload.members.find((member) => member.displayName === "Bob-Pi")!;
    a.send("chat.send", { text: "@Bob-Pi 请回答" }, "retry-request");
    await b.waitFor("agent.deliver");
    await b.close();

    const reconnected = await connect("session-b");
    const snapshot = await reconnected.waitFor("snapshot", (message) => message.payload.group !== undefined);
    const redelivery = await reconnected.waitFor("agent.deliver", (message) => message.payload.requestId === "retry-request");
    expect(snapshot.payload.members).toContainEqual(oldAgent);
    expect(redelivery.payload.text).toBe("请回答");
  });

  it("只接受目标的一次回答，发送者离群后仍在原群公开", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect();
    await joinGroup(b, groupId);
    const c = await connect();
    await joinGroup(c, groupId, "Carol", "Carol-Pi");
    a.send("chat.send", { text: "@Bob-Pi 请回答" }, "result-request");
    await b.waitFor("agent.deliver");
    a.send("group.leave", {});
    await a.waitFor("snapshot", (message) => message.payload.group === undefined);

    b.sendResult({ requestId: "result-request", ok: true, text: "唯一回答" });
    const answer = await c.waitFor("chat.message", (message) => message.payload.kind === "agent");
    b.sendResult({ requestId: "result-request", ok: true, text: "重复回答" });
    await b.waitFor("agent.result.ack", (message) => message.payload.requestId === "result-request");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(answer.payload).toMatchObject({
      groupId,
      senderName: "Bob-Pi",
      senderType: "agent",
      text: "唯一回答",
    });
    expect(
      c.messages.filter((message) => message.type === "chat.message" && message.payload.kind === "agent"),
    ).toHaveLength(1);
  });

  it("超过恢复期移除两个成员并让待处理请求失败", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const b = await connect();
    await joinGroup(b, created.payload.group!.groupId);
    a.send("chat.send", { text: "@Bob-Pi 慢请求" }, "slow-request");
    await b.waitFor("agent.deliver");
    await b.close();
    const failure = await a.waitFor("send.failed", (message) => message.payload.requestId === "slow-request");
    expect(failure.payload.reason).toBe("target_offline");

    const reconnected = await connect(b.sessionId);
    const snapshot = await reconnected.waitFor("snapshot");
    expect(snapshot.payload.group).toBeUndefined();
  });

  it("坏消息返回错误但连接继续服务", async () => {
    const a = await connect();
    a.writeRaw("{bad json}\n");
    expect((await a.waitFor("error")).payload.code).toBe("invalid_json");
    await createGroup(a);
    a.send("chat.send", { text: "仍然在线" }, "after-error");
    expect(
      (await a.waitFor("chat.message", (message) => message.id === "after-error")).payload.text,
    ).toBe("仍然在线");
  });

  it("拒绝第二个 Broker，并清理失效 Socket 文件", async () => {
    await expect(createBrokerServer({ socketPath, dbPath }).start()).rejects.toThrow("Broker 已经在运行");
    const stalePath = join(directory, "stale.sock");
    await writeFile(stalePath, "stale");
    const another = createBrokerServer({
      socketPath: stalePath,
      dbPath: join(directory, "stale.db"),
    });
    await another.start();
    const client = await TestClient.connect(stalePath);
    expect((await client.waitFor("snapshot")).payload.clientId).toBeTypeOf("string");
    await client.close();
    await another.close();
  });

  it("并发启动时只允许一个 Broker 获得 Socket", async () => {
    const racePath = join(directory, "race.sock");
    const raceDbPath = join(directory, "race.db");
    const candidates = [
      createBrokerServer({ socketPath: racePath, dbPath: raceDbPath }),
      createBrokerServer({ socketPath: racePath, dbPath: raceDbPath }),
    ];
    const results = await Promise.allSettled(candidates.map((candidate) => candidate.start()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await Promise.all(candidates.map((candidate) => candidate.close()));
  });
});
