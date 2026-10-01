import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { createBrokerMcpServer } from "../src/broker/mcp-server.js";
import { BrokerDatabase } from "../src/broker/database.js";
import { FakeProactiveRouter } from "../src/broker/proactive-provider.js";
import { SUMMARY_PROMPT_VERSION } from "../src/broker/proactive-provider.js";
import type { McpAccessPayload } from "../src/protocol.js";
import { brokerSession, waitUntil } from "./helpers/broker-session.js";

type Session = Awaited<ReturnType<typeof brokerSession>>;
const lanHost = Object.values(networkInterfaces()).flat().find((entry) =>
  entry?.family === "IPv4" && !entry.internal)?.address;

describe("Broker MCP native Pi client", () => {
  let directory: string;
  let broker: BrokerServer;
  let host: string;
  const sessions: Session[] = [];
  const mcpClients: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(mcpClients.splice(0).map((client) => client.close()));
    await Promise.all(sessions.splice(0).map((session) => session.client.stop()));
    await broker?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function setup(lan = false) {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-mcp-"));
    host = lan ? lanHost ?? "127.0.0.1" : "127.0.0.1";
    const provider = new FakeProactiveRouter();
    const summarize = vi.spyOn(provider, "summarize");
    const select = vi.spyOn(provider, "select");
    broker = createBrokerServer({
      dbPath: join(directory, "comms.db"),
      listen: { host: lan ? "0.0.0.0" : host, port: 0 },
      mode: lan ? "lan-host" : "local", networkAccessRequired: false,
      mdnsPublisherFactory: () => ({ stop: async () => {} }),
      proactiveProvider: provider,
    });
    await broker.start();
    const endpoint = { host, port: broker.endpoint.port };
    const alice = await brokerSession({ host: "127.0.0.1", port: endpoint.port }, "Alice");
    const bob = await brokerSession(endpoint, "Bob");
    sessions.push(alice, bob);
    alice.client.send("group.create", {
      groupName: "MCP测试组", userName: "Alice", agentName: "Alice-Pi",
      agentDescription: "Backend", visibility: lan ? "nearby" : "local",
    });
    await waitUntil(() => alice.snapshot.group !== undefined);
    bob.client.send("group.join", {
      groupId: alice.snapshot.group!.groupId, userName: "Bob", agentName: "Bob-Pi", agentDescription: "Tests",
    });
    await waitUntil(() => bob.snapshot.mcpAccess !== undefined);
    return { alice, bob, summarize, select };
  }

  async function connect(access: McpAccessPayload) {
    const client = new McpClient({ name: "pi-comms-test", version: "1" });
    mcpClients.push(client);
    await client.connect(new StreamableHttpTransport({
      url: `http://${host}:${access.port}/mcp`, headers: { Authorization: `Bearer ${access.token}` },
    }));
    return client;
  }

  async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool(name, args);
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content![0] as { text: string }).text);
  }

  for (const lan of [false, true]) {
    it(`${lan ? "LAN" : "Local"}: 最新 context、两用户、只读快照、分页、字段过滤和 Resource`, async () => {
      const { alice, bob, summarize, select } = await setup(lan);
      const client = await connect(bob.snapshot.mcpAccess!);
      expect((await client.listTools()).map((tool) => tool.name)).toEqual([
        "get_group_context", "read_group_messages",
      ]);
      for (let i = 1; i <= 60; i++) alice.client.send("chat.send", { text: `message-${i}` });
      await waitUntil(() => bob.messages.filter((m) => m.type === "chat.message").length === 60);
      // Compare actual persisted state and calls across MCP reads, not only mock counters.
      const raw = new Database(broker.dbPath);
      const before = raw.prepare("SELECT * FROM group_memberships ORDER BY session_key").all();
      const context = await call(client, "get_group_context");
      expect(context.latestGroupSeq).toBe(60);
      expect(context.messages).toHaveLength(12);
      expect(context.messages[0].groupSeq).toBe(49);
      expect(context.summaryIncomplete).toBe(true);
      expect(context.participants.map((p: any) => p.user.name)).toEqual(["Alice", "Bob"]);
      expect(context.participants[1].agent.description).toBe("Tests");
      raw.prepare(`INSERT INTO group_summaries
        (group_id, summary, from_seq, through_seq, prompt_version, updated_at)
        VALUES (?, 'existing summary', 1, 48, ?, 1)`).run(alice.snapshot.group!.groupId, SUMMARY_PROMPT_VERSION);
      const summarized = await call(client, "get_group_context");
      expect(summarized.summary).toMatchObject({ text: "existing summary", fromSeq: 1, throughSeq: 48 });
      expect(summarized.summaryIncomplete).toBe(false);
      const page = await call(client, "read_group_messages");
      expect(page.messages).toHaveLength(20);
      expect(page.messages[0].groupSeq).toBe(41);
      expect(Object.keys(page.messages[0]).sort()).toEqual([
        "groupSeq", "messageId", "timestamp", "senderName", "senderType", "text", "mentionIds",
      ].sort());
      const range = await call(client, "read_group_messages", { afterSeq: 10, throughSeq: 15, limit: 100 });
      expect(range.messages.map((m: any) => m.groupSeq)).toEqual([11, 12, 13, 14, 15]);
      expect((await call(client, "read_group_messages", { limit: 100 })).messages).toHaveLength(50);
      expect((await client.callTool("get_group_context", { groupId: "other" })).isError).toBe(true);
      expect((await client.callTool("read_group_messages", { limit: 0 })).isError).toBe(true);
      const sdk = new Client({ name: "resource-test", version: "1" });
      mcpClients.push(sdk);
      await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://${host}:${broker.mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bob.snapshot.mcpAccess!.token}` } },
      }));
      expect((await sdk.listResources()).resources.map((r) => r.uri)).toEqual([
        "pi-comms://group/current", "pi-comms://group/context",
      ]);
      for (const uri of ["pi-comms://group/current", "pi-comms://group/context"]) {
        const resource = await sdk.readResource({ uri });
        expect(JSON.parse((resource.contents[0] as { text: string }).text).latestGroupSeq).toBe(60);
      }
      expect(raw.prepare("SELECT * FROM group_memberships ORDER BY session_key").all()).toEqual(before);
      raw.close();
      expect(summarize).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      alice.client.send("chat.send", { text: "newest" });
      await waitUntil(() => bob.messages.some((m) => m.type === "chat.message" && m.payload.text === "newest"));
      expect((await call(client, "get_group_context")).latestGroupSeq).toBe(61);
    });
  }

  it("未入群、错误 token、离群重入、Session 结束和 Broker 重启均拒绝旧凭证", async () => {
    const { alice, bob } = await setup();
    const access = bob.snapshot.mcpAccess!;
    const url = `http://${host}:${access.port}/mcp`;
    expect((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    bob.client.send("group.leave", {});
    await waitUntil(() => bob.snapshot.group === undefined);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${access.token}` } })).status).toBe(401);
    bob.client.send("mcp.access", {});
    await waitUntil(() => bob.messages.some((m) => m.type === "error" && m.payload.code === "not_in_group"));
    bob.client.send("group.join", {
      groupId: alice.snapshot.group!.groupId, userName: "Bob", agentName: "Bob-Pi", agentDescription: "Tests",
    });
    await waitUntil(() => bob.snapshot.mcpAccess !== undefined && bob.snapshot.mcpAccess.token !== access.token);
    const newToken = bob.snapshot.mcpAccess!.token;
    await bob.client.stop();
    expect((await fetch(url, { headers: { Authorization: `Bearer ${newToken}` } })).status).toBe(401);
    const aliceToken = alice.snapshot.mcpAccess!.token;
    await alice.client.stop();
    await broker.close();
    broker = createBrokerServer({ dbPath: broker.dbPath, listen: { host, port: 0 } });
    await broker.start();
    expect((await fetch(`http://${host}:${broker.mcpPort}/mcp`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    })).status).toBe(401);
  });

  it("显式 Agent 请求保存 sourceGroupSeq，重启后仍保留", async () => {
    const { alice, bob } = await setup();
    alice.client.send("chat.send", { text: "@Bob-Pi test anchor" });
    await waitUntil(() => bob.messages.some((m) => m.type === "agent.deliver"));
    const delivery = bob.messages.find((m) => m.type === "agent.deliver")!;
    if (delivery.type !== "agent.deliver") throw new Error("Missing delivery");
    expect(delivery.payload.sourceGroupSeq).toBe(1);
    const client = await connect(bob.snapshot.mcpAccess!);
    const history = await call(client, "read_group_messages", { throughSeq: delivery.payload.sourceGroupSeq });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].text).toBe("@Bob-Pi test anchor");
    expect(history.messages[0].status).toBeUndefined();
    expect(history.messages[0].requestId).toBeUndefined();
    await Promise.all(sessions.map((s) => s.client.stop()));
    await broker.close();
    const reopened = new BrokerDatabase(broker.dbPath);
    reopened.close();
    const raw = new Database(broker.dbPath);
    expect(raw.prepare("SELECT source_group_seq AS seq FROM agent_requests WHERE request_id = ?")
      .get(delivery.payload.requestId)).toEqual({ seq: 1 });
    raw.close();
  });

  it("凭证只读所属群，成员被群主移除后立即失效", async () => {
    const { alice, bob } = await setup();
    const other = await brokerSession({ host, port: broker.endpoint.port }, "Other");
    sessions.push(other);
    other.client.send("group.create", {
      groupName: "OtherGroup", userName: "Other", agentName: "Other-Pi", agentDescription: "Other",
    });
    await waitUntil(() => other.snapshot.group !== undefined);
    other.client.send("chat.send", { text: "OTHER_GROUP_SECRET" });
    await waitUntil(() => other.messages.some((m) => m.type === "chat.message"));
    const client = await connect(bob.snapshot.mcpAccess!);
    expect(JSON.stringify(await call(client, "get_group_context"))).not.toContain("OTHER_GROUP_SECRET");
    expect((await client.callTool("read_group_messages", { groupId: other.snapshot.group!.groupId })).isError).toBe(true);
    const welcome = alice.messages.find((m) => m.type === "membership.welcome");
    if (welcome?.type !== "membership.welcome") throw new Error("Missing owner credentials");
    const token = bob.snapshot.mcpAccess!.token;
    const sessionKey = bob.snapshot.members.find((m) => m.displayName === "Bob")!.stableSessionKey;
    alice.client.send("group.member.remove", {
      groupId: alice.snapshot.group!.groupId,
      ownerCredential: welcome.payload.ownerCredential,
      sessionKey,
    });
    await waitUntil(() => bob.snapshot.group === undefined);
    alice.client.send("group.member.allow", {
      groupId: alice.snapshot.group!.groupId, ownerCredential: welcome.payload.ownerCredential, sessionKey,
    });
    const membershipDb = new Database(broker.dbPath);
    await waitUntil(() => membershipDb.prepare(
      "SELECT 1 FROM group_memberships WHERE group_id = ? AND session_key = ?",
    ).get(alice.snapshot.group!.groupId, sessionKey) === undefined);
    membershipDb.close();
    bob.client.send("group.join", {
      groupId: alice.snapshot.group!.groupId, userName: "Bob", agentName: "Bob-Pi", agentDescription: "Tests",
    });
    await waitUntil(() => bob.snapshot.group !== undefined);
    expect(bob.snapshot.mcpAccess!.token).not.toBe(token);
    expect((await fetch(`http://${host}:${broker.mcpPort}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(401);
  });
});

it("MCP token 到期和刷新，网络权限拒绝", async () => {
  let now = 0;
  let allowed = true;
  const server = createBrokerMcpServer({
    host: "127.0.0.1", now: () => now,
    currentGroup: () => "group-a", networkAllowed: () => allowed,
    current: () => ({}), context: () => ({}), messages: () => [],
  });
  await server.start();
  try {
    const access = server.issue("client-a", "group-a");
    const read = (token: string) => fetch(`http://127.0.0.1:${server.port}/mcp`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    });
    now = access.expiresAt;
    expect((await read(access.token)).status).toBe(401);
    const next = server.issue("client-a", "group-a");
    expect(next.token).not.toBe(access.token);
    // Auth succeeds; GET is unsupported by this stateless server.
    expect((await read(next.token)).status).toBe(405);
    allowed = false;
    expect((await read(next.token)).status).toBe(403);
  } finally { await server.close(); }
});
