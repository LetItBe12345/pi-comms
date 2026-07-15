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

  it("初始化 v2 Schema、WAL 和 FULL，并恢复群组", () => {
    const store = new BrokerDatabase(dbPath);
    expect(store.configuration()).toEqual({
      journalMode: "wal",
      synchronous: 2,
    });
    store.insertGroup({ groupId: "g", groupName: "开发组" });
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(2);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "agent_requests",
      "groups",
      "messages",
    ]);
    raw.close();

    const reopened = new BrokerDatabase(dbPath);
    expect(reopened.groups()).toEqual([{ groupId: "g", groupName: "开发组" }]);
    reopened.close();
  });

  it("只加载按时间排序的最近 100 条公开消息", () => {
    const store = new BrokerDatabase(dbPath);
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
});
