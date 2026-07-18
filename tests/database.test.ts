import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrokerDatabase,
  historyMessage,
} from "../src/broker/database.js";
import type { AgentRequestPayload, ChatMessagePayload } from "../src/protocol.js";
import { createSessionKey } from "../src/session-key.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_KEY = createSessionKey(DEVICE_ID, "session-a");

describe("Broker SQLite", () => {
  let directory: string;
  let dbPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-db-"));
    dbPath = join(directory, "comms.db");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("初始化 v6 Schema、WAL 和 FULL，并恢复群组", () => {
    const store = new BrokerDatabase(dbPath);
    expect(store.configuration()).toEqual({
      journalMode: "wal",
      synchronous: 2,
    });
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(6);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "agent_requests",
      "broker_metadata",
      "group_memberships",
      "groups",
      "messages",
      "paused_chains",
    ]);
    raw.close();

    const reopened = new BrokerDatabase(dbPath);
    expect(reopened.groups()).toEqual([{ groupId: "g", groupName: "开发组" }]);
    reopened.close();
  });

  it("从 v2 升级时保留群组、公开历史和请求结果", () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        text TEXT NOT NULL,
        mention_ids TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        request_id TEXT,
        chain_id TEXT,
        round INTEGER,
        failure_reason TEXT,
        kind TEXT
      );
      CREATE TABLE agent_requests (
        request_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        target_agent_id TEXT,
        target_agent_name TEXT NOT NULL,
        owner_user_name TEXT,
        online_members TEXT NOT NULL,
        text TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_text TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO groups VALUES ('g', '旧群组', '旧群组', 1);
      INSERT INTO messages VALUES (
        'm-completed', 'g', 'user:a', 'Alice', 'user', '@Bob-Pi 已完成',
        '["agent:b"]', 10, 'completed', 'r-completed', 'r-completed', 1, NULL, NULL
      );
      INSERT INTO messages VALUES (
        'm-pending', 'g', 'user:a', 'Alice', 'user', '@Bob-Pi 未完成',
        '["agent:b"]', 20, 'processing', 'r-pending', 'r-pending', 1, NULL, NULL
      );
      INSERT INTO agent_requests VALUES (
        'r-completed', 'g', 'm-completed', 'user:a', 'Alice', 'agent:b',
        'Bob-Pi', 'Bob', '[]', '已完成', 'r-completed', 1, 'completed',
        'DONE', NULL, 10, 11
      );
      INSERT INTO agent_requests VALUES (
        'r-pending', 'g', 'm-pending', 'user:a', 'Alice', 'agent:b',
        'Bob-Pi', 'Bob', '[]', '未完成', 'r-pending', 1, 'pending',
        NULL, NULL, 20, 20
      );
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new BrokerDatabase(dbPath, DEVICE_ID);
    expect(migrated.groups()).toEqual([{ groupId: "g", groupName: "旧群组" }]);
    expect(migrated.requestStatus("r-completed")).toBe("completed");
    expect(migrated.requestStatus("r-pending")).toBe("interrupted");
    expect(migrated.recentMessages("g")).toEqual([
      expect.objectContaining({
        messageId: "m-completed",
        status: "completed",
        text: "@Bob-Pi 已完成",
      }),
      expect.objectContaining({
        messageId: "m-pending",
        status: "interrupted",
        failureReason: "broker_restarted",
      }),
    ]);
    migrated.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(6);
    const columns = raw
      .prepare("PRAGMA table_info(agent_requests)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("round_limit");
    expect(columns.map((column) => column.name)).toContain("initiator_session_key");
    expect(columns.map((column) => column.name)).not.toContain("initiator_session_id");
    expect((raw.prepare(
      "SELECT initiator_session_key AS sessionKey FROM agent_requests WHERE request_id = 'r-completed'",
    ).get() as { sessionKey: string }).sessionKey).toBe(
      createSessionKey(DEVICE_ID, "r-completed"),
    );
    expect(raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paused_chains'",
    ).get()).toBeDefined();
    raw.close();
  });

  it("只加载按时间排序的最近 100 条公开消息", () => {
    const store = new BrokerDatabase(dbPath, DEVICE_ID);
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    for (let index = 0; index < 105; index += 1) {
      const payload: ChatMessagePayload = {
        groupId: "g",
        senderId: "user:a",
        senderName: "Alice",
        senderType: "user",
        text: `消息 ${index}`,
        mentionIds: [],
        status: "sent",
      };
      store.insertMessage(historyMessage(`m-${index}`, index, payload, "sent"));
    }

    const messages = store.recentMessages("g");
    expect(messages).toHaveLength(100);
    expect(messages[0]?.text).toBe("消息 5");
    expect(messages.at(-1)?.text).toBe("消息 104");
    store.close();
  });

  it("重启时把未完成请求标记为 interrupted", () => {
    const store = new BrokerDatabase(dbPath);
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    const payload: ChatMessagePayload = {
      groupId: "g",
      senderId: "user:a",
      senderName: "Alice",
      senderType: "user",
      text: "@Bob-Pi 回答",
      mentionIds: ["agent:b"],
      requestId: "r",
      status: "processing",
    };
    const request: AgentRequestPayload = {
      requestId: "r",
      groupId: "g",
      groupName: "开发组",
      senderId: "user:a",
      senderName: "Alice",
      targetAgentId: "agent:b",
      targetAgentName: "Bob-Pi",
      ownerUserName: "Bob",
      onlineMembers: [],
      text: "回答",
      chainId: "r",
      round: 1,
    };
    store.insertAgentRequest(historyMessage("r", 1, payload, "processing"), request);
    store.markDelivered("r");
    store.close();

    const reopened = new BrokerDatabase(dbPath);
    expect(reopened.requestStatus("r")).toBe("interrupted");
    expect(reopened.recentMessages("g")[0]).toMatchObject({
      status: "interrupted",
      failureReason: "broker_restarted",
    });
    reopened.close();
  });

  it("保存待批准请求，并在批准或拒绝后更新公开消息", () => {
    const store = new BrokerDatabase(dbPath);
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    const makeRequest = (id: string): AgentRequestPayload => ({
      requestId: id,
      groupId: "g",
      groupName: "开发组",
      senderId: "user:a",
      senderName: "Alice",
      targetAgentId: "agent:b",
      targetAgentName: "Bob-Pi",
      ownerUserName: "Bob",
      onlineMembers: [],
      text: "回答",
      chainId: id,
      round: 1,
    });
    const makeMessage = (id: string): ChatMessagePayload => ({
      groupId: "g",
      senderId: "user:a",
      senderName: "Alice",
      senderType: "user",
      text: "@Bob-Pi 回答",
      mentionIds: ["agent:b"],
      requestId: id,
      status: "waiting_approval",
    });

    store.insertAgentRequest(
      historyMessage("approve", 1, makeMessage("approve"), "waiting_approval"),
      makeRequest("approve"),
      true,
    );
    store.insertAgentRequest(
      historyMessage("reject", 2, makeMessage("reject"), "waiting_approval"),
      makeRequest("reject"),
      true,
    );
    expect(store.requestStatus("approve")).toBe("awaiting_approval");
    expect(store.approveRequest("approve")).toBe(true);
    expect(store.rejectRequest("reject")).toBe(true);
    expect(store.requestStatus("approve")).toBe("pending");
    expect(store.requestStatus("reject")).toBe("rejected");
    expect(store.recentMessages("g")).toEqual([
      expect.objectContaining({ messageId: "approve", status: "queued" }),
      expect.objectContaining({
        messageId: "reject",
        status: "failed",
        failureReason: "request_rejected",
      }),
    ]);
    store.close();
  });

  it("Broker 重启后让待批准请求失效", () => {
    const store = new BrokerDatabase(dbPath);
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    const payload: ChatMessagePayload = {
      groupId: "g",
      senderId: "user:a",
      senderName: "Alice",
      senderType: "user",
      text: "@Bob-Pi 等待",
      mentionIds: ["agent:b"],
      requestId: "waiting",
      status: "waiting_approval",
    };
    const request: AgentRequestPayload = {
      requestId: "waiting",
      groupId: "g",
      groupName: "开发组",
      senderId: "user:a",
      senderName: "Alice",
      targetAgentId: "agent:b",
      targetAgentName: "Bob-Pi",
      ownerUserName: "Bob",
      onlineMembers: [],
      text: "等待",
      chainId: "waiting",
      round: 1,
    };
    store.insertAgentRequest(
      historyMessage("waiting", 1, payload, "waiting_approval"),
      request,
      true,
    );
    store.close();

    const reopened = new BrokerDatabase(dbPath);
    expect(reopened.requestStatus("waiting")).toBe("invalid");
    expect(reopened.recentMessages("g")[0]).toMatchObject({
      status: "failed",
      failureReason: "request_invalid",
    });
    reopened.close();
  });

  it("Broker 重启后保留达到轮数上限的待决定通信链", () => {
    const store = new BrokerDatabase(dbPath, DEVICE_ID);
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    const request: AgentRequestPayload = {
      requestId: "round-10",
      groupId: "g",
      groupName: "开发组",
      senderId: "agent:b",
      senderName: "Bob-Pi",
      senderType: "agent",
      senderOwnerUserName: "Bob",
      targetAgentId: "agent:c",
      targetAgentName: "Carol-Pi",
      ownerUserName: "Carol",
      onlineMembers: [],
      text: "第十轮",
      chainId: "chain",
      round: 10,
    };
    const source = historyMessage("source", 1, {
      groupId: "g",
      senderId: "agent:b",
      senderName: "Bob-Pi",
      senderType: "agent",
      text: "@Carol-Pi 第十轮",
      mentionIds: ["agent:c"],
      routeRequestId: "round-10",
      routeStatus: "queued",
      status: "sent",
      kind: "agent",
      chainId: "chain",
      round: 9,
    }, "sent");
    store.insertAgentRequest(source, request, false, {
      initiatorSessionKey: SESSION_KEY,
      initiatorName: "Alice",
      participants: ["Bob-Pi", "Carol-Pi"],
      roundLimit: 10,
    });
    store.markDelivered("round-10");
    const answer = historyMessage("answer", 2, {
      groupId: "g",
      senderId: "agent:c",
      senderName: "Carol-Pi",
      senderType: "agent",
      text: "@Bob-Pi 第十一轮",
      mentionIds: ["agent:b"],
      requestId: "round-10",
      kind: "agent",
      status: "sent",
      chainId: "chain",
      round: 10,
      routeStatus: "paused",
      routeTargetName: "Bob-Pi",
      nextRound: 11,
    }, "sent");
    store.completeAndRoute("round-10", answer, { paused: {
      chainId: "chain",
      groupId: "g",
      messageId: "answer",
      initiatorSessionKey: SESSION_KEY,
      initiatorName: "Alice",
      sourceAgentName: "Carol-Pi",
      sourceOwnerUserName: "Carol",
      targetAgentId: "agent:b",
      targetAgentName: "Bob-Pi",
      text: "第十一轮",
      nextRound: 11,
      roundLimit: 10,
      participants: ["Bob-Pi", "Carol-Pi"],
      pausedAt: 2,
    } });
    store.close();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP INDEX paused_chains_owner_group_idx;
      ALTER TABLE agent_requests
        RENAME COLUMN initiator_session_key TO initiator_session_id;
      ALTER TABLE paused_chains
        RENAME COLUMN initiator_session_key TO initiator_session_id;
      UPDATE agent_requests SET initiator_session_id = 'session-a';
      UPDATE paused_chains SET initiator_session_id = 'session-a';
      CREATE INDEX paused_chains_owner_group_idx
        ON paused_chains(initiator_session_id, group_id, paused_at DESC);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const reopened = new BrokerDatabase(dbPath, DEVICE_ID);
    expect(reopened.pausedChains(SESSION_KEY, "g")).toEqual([
      expect.objectContaining({ chainId: "chain", nextRound: 11, roundLimit: 10 }),
    ]);
    expect(reopened.recentMessages("g").at(-1)).toMatchObject({
      messageId: "answer",
      routeStatus: "paused",
      round: 10,
    });
    reopened.close();
  });
});
