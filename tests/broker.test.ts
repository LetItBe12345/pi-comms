import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
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
import type { TcpConnectEndpoint } from "../src/transport/tcp-endpoint.js";

type BrokerEnvelopeType = BrokerEnvelope["type"];
type EnvelopeByType<T extends BrokerEnvelopeType> = Extract<
  BrokerEnvelope,
  { type: T }
>;

class TestClient {
  readonly messages: BrokerEnvelope[] = [];
  readonly sessionId: string;
  readonly deviceId: string;
  clientId: string | undefined;
  resumeToken: string | undefined;
  readonly #socket: Socket;
  readonly #decoder = new JsonlDecoder();
  readonly #listeners = new Set<() => void>();

  private constructor(
    endpoint: TcpConnectEndpoint,
    sessionId: string,
    deviceId: string,
    credentials?: { clientId: string; resumeToken: string },
  ) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.#socket = createConnection(endpoint);
    this.#socket.once("connect", () => {
      this.send("broker.probe", {
        service: BROKER_SERVICE,
        protocolVersion: BROKER_PROTOCOL_VERSION,
      }, "test-probe");
    });
    this.#socket.on("data", (chunk) => {
      for (const result of this.#decoder.push(chunk)) {
        if (!result.ok) throw new Error(result.error);
        const message = result.value as BrokerEnvelope;
        this.messages.push(message);
        if (message.type === "broker.ready" && message.payload.requestId === "test-probe") {
          this.send("client.hello", {
            protocolVersion: BROKER_PROTOCOL_VERSION,
            deviceId,
            sessionId,
            permission: "auto",
            ...credentials,
          });
        }
        if (message.type === "client.welcome") {
          this.clientId = message.payload.clientId;
          this.resumeToken = message.payload.resumeToken;
        }
        for (const listener of this.#listeners) listener();
      }
    });
  }

  static async connect(
    endpoint: TcpConnectEndpoint,
    sessionId: string = randomUUID(),
    deviceId = "00000000-0000-4000-8000-000000000001",
    credentials?: { clientId: string; resumeToken: string },
  ): Promise<TestClient> {
    const client = new TestClient(endpoint, sessionId, deviceId, credentials);
    await new Promise<void>((resolve, reject) => {
      client.#socket.once("connect", resolve);
      client.#socket.once("error", reject);
    });
    const result = await Promise.race([
      client.waitFor("snapshot").then(() => "ready" as const),
      client.waitFor("error", (message) =>
        message.payload.code === "resume_rejected" ||
        message.payload.code === "session_in_use").then((message) => message.payload.code),
    ]);
    if (result !== "ready") {
      await client.close();
      throw new Error(result);
    }
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
        reject(new Error(`等待 ${type} 超时：${JSON.stringify(this.messages)}`));
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
  let endpoint: TcpConnectEndpoint;
  let dbPath: string;
  let broker: BrokerServer;
  let clients: TestClient[];
  let credentials: Map<string, { clientId: string; resumeToken: string }>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-"));
    dbPath = join(directory, "comms.db");
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath,
      disconnectGraceMs: 80,
    });
    clients = [];
    credentials = new Map();
    await broker.start();
    endpoint = broker.endpoint;
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connect(
    sessionId: string = randomUUID(),
    deviceId = "00000000-0000-4000-8000-000000000001",
  ): Promise<TestClient> {
    const key = `${deviceId}:${sessionId}`;
    let client: TestClient;
    try {
      client = await TestClient.connect(endpoint, sessionId, deviceId, credentials.get(key));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "resume_rejected") throw error;
      client = await TestClient.connect(endpoint, sessionId, deviceId);
    }
    credentials.set(key, { clientId: client.clientId!, resumeToken: client.resumeToken! });
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

  it("不同设备使用相同 sessionId 时不会互相覆盖", async () => {
    const a = await connect(
      "shared-session",
      "00000000-0000-4000-8000-000000000001",
    );
    const b = await connect(
      "shared-session",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(a.clientId).not.toBe(b.clientId);
    await createGroup(a, "A组", "Alice", "Alice-Pi");
    await createGroup(b, "B组", "Bob", "Bob-Pi");
    expect((await a.waitFor("snapshot", (item) => item.payload.group?.groupName === "A组"))
      .payload.group?.groupName).toBe("A组");
    expect((await b.waitFor("snapshot", (item) => item.payload.group?.groupName === "B组"))
      .payload.group?.groupName).toBe("B组");
  });

  it("只有正确 clientId 和 resumeToken 可以接管同一 Session", async () => {
    const sessionId = "protected-session";
    const deviceId = "00000000-0000-4000-8000-000000000001";
    const original = await connect(sessionId, deviceId);
    await expect(TestClient.connect(endpoint, sessionId, deviceId))
      .rejects.toThrow("session_in_use");
    await expect(TestClient.connect(endpoint, sessionId, deviceId, {
      clientId: original.clientId!,
      resumeToken: "wrong-token",
    })).rejects.toThrow("resume_rejected");

    const resumed = await TestClient.connect(endpoint, sessionId, deviceId, {
      clientId: original.clientId!,
      resumeToken: original.resumeToken!,
    });
    clients.push(resumed);
    expect(resumed.clientId).toBe(original.clientId);
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
    expect(joined.payload.members).toContainEqual(expect.objectContaining({
      memberId: `user:${bClientId}`,
      clientId: bClientId,
      type: "user",
      displayName: "Bob",
      groupId,
      online: true,
    }));
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

  it("群名唯一，群主不能退出且离线群仍保留", async () => {
    const a = await connect();
    const first = await createGroup(a, "Team-A");
    a.send("group.leave", {}, "leave-a");
    expect(
      await a.waitFor("error", (message) => message.payload.requestId === "leave-a"),
    ).toMatchObject({ payload: { code: "owner_cannot_leave" } });

    const b = await connect();
    b.send("group.create", {
      groupName: "team-a",
      userName: "Bob",
      agentName: "Bob-Pi",
    }, "duplicate-group");
    expect(
      await b.waitFor("error", (message) => message.payload.requestId === "duplicate-group"),
    ).toMatchObject({ payload: { code: "group_name_conflict" } });
    expect(first.payload.groups).toHaveLength(1);
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

  it("需要批准时不注入，批准后只投递一次", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const b = await connect();
    await joinGroup(b, created.payload.group!.groupId);
    b.send("permission.update", { permission: "approval" });
    await a.waitFor(
      "presence.changed",
      (message) =>
        message.payload.displayName === "Bob-Pi" &&
        message.payload.agentPermission === "approval",
    );

    a.send("chat.send", { text: "@Bob-Pi 请审批" }, "approval-request");
    const [message, pending] = await Promise.all([
      a.waitFor("chat.message", (item) => item.id === "approval-request"),
      b.waitFor("request.pending", (item) => item.payload.requestId === "approval-request"),
    ]);
    expect(message.payload.status).toBe("waiting_approval");
    expect(pending.payload.text).toBe("请审批");
    await a.waitFor(
      "presence.changed",
      (item) =>
        item.payload.displayName === "Bob-Pi" &&
        item.payload.pendingApprovalCount === 1,
    );
    expect(
      b.messages.some(
        (item) =>
          item.type === "agent.deliver" &&
          item.payload.requestId === "approval-request",
      ),
    ).toBe(false);

    b.send("request.approve", { requestId: "approval-request" });
    await b.waitFor(
      "agent.deliver",
      (item) => item.payload.requestId === "approval-request",
    );
    expect(
      await a.waitFor(
        "chat.message",
        (item) => item.id === "approval-request" && item.payload.status === "queued",
      ),
    ).toBeDefined();
    b.send("request.approve", { requestId: "approval-request" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      b.messages.filter(
        (item) =>
          item.type === "agent.deliver" &&
          item.payload.requestId === "approval-request",
      ),
    ).toHaveLength(1);
  });

  it("拒绝、禁止接收和失效请求返回公开原因", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const b = await connect();
    await joinGroup(b, created.payload.group!.groupId);

    b.send("permission.update", { permission: "approval" });
    await a.waitFor(
      "presence.changed",
      (item) => item.payload.agentPermission === "approval",
    );
    a.send("chat.send", { text: "@Bob-Pi 拒绝我" }, "reject-request");
    await b.waitFor("request.pending", (item) => item.payload.requestId === "reject-request");
    b.send("request.reject", { requestId: "reject-request" });
    expect(
      await a.waitFor("send.failed", (item) => item.payload.requestId === "reject-request"),
    ).toMatchObject({ payload: { reason: "request_rejected" } });
    b.send("request.reject", { requestId: "reject-request" });

    b.send("permission.update", { permission: "blocked" });
    await a.waitFor(
      "presence.changed",
      (item) => item.payload.agentPermission === "blocked",
    );
    a.send("chat.send", { text: "@Bob-Pi 禁止请求" }, "blocked-request");
    expect(
      await a.waitFor("send.failed", (item) => item.payload.requestId === "blocked-request"),
    ).toMatchObject({ payload: { reason: "target_blocked" } });

    b.send("permission.update", { permission: "approval" });
    await a.waitFor(
      "presence.changed",
      (item) => item.payload.agentPermission === "approval" && item.timestamp > 1,
    );
    a.send("chat.send", { text: "@Bob-Pi 等待后离线" }, "invalid-request");
    await b.waitFor("request.pending", (item) => item.payload.requestId === "invalid-request");
    await b.close();
    expect(
      await a.waitFor("send.failed", (item) => item.payload.requestId === "invalid-request"),
    ).toMatchObject({ payload: { reason: "request_invalid" } });
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

  it("Agent 回答可沿同一通信链路由到多个 Agent", async () => {
    const a = await connect("session-a");
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect("session-b");
    await joinGroup(b, groupId);
    const c = await connect("session-c");
    await joinGroup(c, groupId, "Carol", "Carol-Pi");

    a.send("chat.send", { text: "@Bob-Pi 开始检查" }, "chain-one");
    const first = await b.waitFor("agent.deliver", (item) => item.payload.requestId === "chain-one");
    b.sendResult({ requestId: first.payload.requestId, ok: true, text: "  \n@Carol-Pi 请检查测试" });
    const second = await c.waitFor("agent.deliver", (item) => item.payload.round === 2);
    expect(second.payload).toMatchObject({
      chainId: "chain-one",
      senderName: "Bob-Pi",
      senderType: "agent",
      senderOwnerUserName: "Bob",
      targetAgentName: "Carol-Pi",
      text: "请检查测试",
      round: 2,
    });

    c.sendResult({ requestId: second.payload.requestId, ok: true, text: "@Alice-Pi 请汇总" });
    const third = await a.waitFor("agent.deliver", (item) => item.payload.round === 3);
    expect(third.payload).toMatchObject({
      chainId: "chain-one",
      senderName: "Carol-Pi",
      senderOwnerUserName: "Carol",
      targetAgentName: "Alice-Pi",
      round: 3,
    });
    const publicAnswer = await a.waitFor(
      "chat.message",
      (item) => item.payload.senderName === "Bob-Pi" && item.payload.round === 1,
    );
    expect(publicAnswer.payload).toMatchObject({
      routeStatus: "queued",
      routeTargetName: "Carol-Pi",
      nextRound: 2,
    });
  });

  it("Agent 自动路由拒绝自身和空任务，并遵守目标审批权限", async () => {
    const a = await connect();
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect();
    await joinGroup(b, groupId);
    const c = await connect();
    await joinGroup(c, groupId, "Carol", "Carol-Pi");

    a.send("chat.send", { text: "@Bob-Pi 自测" }, "self-chain");
    await b.waitFor("agent.deliver", (item) => item.payload.requestId === "self-chain");
    b.sendResult({ requestId: "self-chain", ok: true, text: "@Bob-Pi 不应注入自己" });
    expect(
      (await a.waitFor("chat.message", (item) => item.payload.requestId === "self-chain" && item.payload.kind === "agent"))
        .payload,
    ).toMatchObject({ routeStatus: "failed", routeFailureReason: "target_self" });

    a.send("chat.send", { text: "@Bob-Pi 空任务" }, "empty-chain");
    await b.waitFor("agent.deliver", (item) => item.payload.requestId === "empty-chain");
    b.sendResult({ requestId: "empty-chain", ok: true, text: "@Carol-Pi" });
    expect(
      (await a.waitFor("chat.message", (item) => item.payload.requestId === "empty-chain" && item.payload.kind === "agent"))
        .payload,
    ).toMatchObject({ routeStatus: "failed", routeFailureReason: "empty_mention" });

    c.send("permission.update", { permission: "approval" });
    await a.waitFor("presence.changed", (item) => item.payload.displayName === "Carol-Pi" && item.payload.agentPermission === "approval");
    a.send("chat.send", { text: "@Bob-Pi 转交" }, "approval-chain");
    await b.waitFor("agent.deliver", (item) => item.payload.requestId === "approval-chain");
    b.sendResult({ requestId: "approval-chain", ok: true, text: "@Carol-Pi 请批准" });
    const pending = await c.waitFor("request.pending", (item) => item.payload.round === 2);
    expect(pending.payload.chainId).toBe("approval-chain");
    expect(
      (await a.waitFor("chat.message", (item) => item.payload.routeRequestId === pending.payload.requestId))
        .payload.routeStatus,
    ).toBe("waiting_approval");
    c.send("request.approve", { requestId: pending.payload.requestId });
    expect((await c.waitFor("agent.deliver", (item) => item.payload.requestId === pending.payload.requestId)).payload.round)
      .toBe(2);
  });

  it("第 10 轮后暂停，只有发起 Session 可继续下一个 10 轮", async () => {
    const a = await connect("session-owner");
    const created = await createGroup(a);
    const groupId = created.payload.group!.groupId;
    const b = await connect("session-b");
    await joinGroup(b, groupId);
    const c = await connect("session-c");
    await joinGroup(c, groupId, "Carol", "Carol-Pi");

    a.send("chat.send", { text: "@Bob-Pi 第 1 轮" }, "limited-chain");
    let currentClient = b;
    let delivery = await b.waitFor("agent.deliver", (item) => item.payload.requestId === "limited-chain");
    for (let round = 1; round <= 9; round += 1) {
      const nextClient = currentClient === b ? c : b;
      const nextName = currentClient === b ? "Carol-Pi" : "Bob-Pi";
      currentClient.sendResult({
        requestId: delivery.payload.requestId,
        ok: true,
        text: `@${nextName} 继续第 ${round + 1} 轮`,
      });
      delivery = await nextClient.waitFor("agent.deliver", (item) => item.payload.round === round + 1);
      currentClient = nextClient;
    }
    currentClient.sendResult({
      requestId: delivery.payload.requestId,
      ok: true,
      text: "@Bob-Pi 请进入第 11 轮",
    });
    const paused = await a.waitFor("chain.paused", (item) => item.payload.chainId === "limited-chain");
    expect(paused.payload).toMatchObject({
      nextRound: 11,
      roundLimit: 10,
      sourceAgentName: "Carol-Pi",
      targetAgentName: "Bob-Pi",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      b.messages.some((item) => item.type === "agent.deliver" && item.payload.round === 11),
    ).toBe(false);

    const sameSessionOnOtherDevice = await connect(
      "session-owner",
      "00000000-0000-4000-8000-000000000002",
    );
    await joinGroup(sameSessionOnOtherDevice, groupId, "Dave", "Dave-Pi");
    sameSessionOnOtherDevice.send("chain.continue", { chainId: "limited-chain" });
    expect((await sameSessionOnOtherDevice.waitFor(
      "error",
      (item) => item.payload.requestId === "limited-chain",
    )).payload.code).toBe("request_invalid");

    b.send("chain.continue", { chainId: "limited-chain" });
    expect((await b.waitFor("error", (item) => item.payload.requestId === "limited-chain")).payload.code)
      .toBe("request_invalid");
    a.send("chain.continue", { chainId: "limited-chain" });
    const resumed = await b.waitFor("agent.deliver", (item) => item.payload.round === 11);
    expect(resumed.payload.chainId).toBe("limited-chain");
    expect(
      (await a.waitFor("chain.resolved", (item) => item.payload.chainId === "limited-chain"))
        .payload,
    ).toMatchObject({ action: "continued", roundLimit: 20 });
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

  it("拒绝同一数据库的第二个 Broker，并支持临时端口", async () => {
    await expect(createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath,
    }).start()).rejects.toThrow("Broker 数据目录已被占用");
    const another = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "stale.db"),
    });
    await another.start();
    expect(another.endpoint.port).toBeGreaterThan(0);
    const client = await TestClient.connect(another.endpoint);
    expect((await client.waitFor("snapshot")).payload.clientId).toBeTypeOf("string");
    await client.close();
    await another.close();
  });

  it("并发启动时只允许一个 Broker 获得数据库锁", async () => {
    const raceDbPath = join(directory, "race.db");
    const raceEndpoint = { host: "127.0.0.1", port: 0 };
    const candidates = [
      createBrokerServer({ listen: raceEndpoint, dbPath: raceDbPath }),
      createBrokerServer({ listen: raceEndpoint, dbPath: raceDbPath }),
    ];
    const results = await Promise.allSettled(candidates.map((candidate) => candidate.start()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await Promise.all(candidates.map((candidate) => candidate.close()));
  });
});
