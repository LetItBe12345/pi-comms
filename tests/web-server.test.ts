import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer, type BrokerServerOptions } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { BrokerDatabase } from "../src/broker/database.js";
import { createEnvelope, type Envelope, type BrokerEnvelope } from "../src/protocol.js";
import { mobileInvitationUrl, mobileInvitationQr } from "../src/web/invitation.js";
import { NetworkAccessStore } from "../src/discovery/network-access.js";
import { primaryOrdinaryNetwork } from "../src/discovery/network.js";
import { createSessionKey } from "../src/session-key.js";

async function until<T>(read: () => T | undefined): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = read(); if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待 Web 消息超时");
}
class Phone {
  readonly messages: Envelope<any>[] = [];
  readonly socket: WebSocket;
  closed = false;
  constructor(port: number, readonly deviceId: string = randomUUID(), readonly sessionId: string = randomUUID()) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on("message", (value) => this.messages.push(JSON.parse(value.toString())));
    this.socket.on("close", () => { this.closed = true; });
  }
  async start() {
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
    this.send("web.hello", { deviceId: this.deviceId, sessionId: this.sessionId });
    await this.wait("web.welcome");
  }
  send(type: string, payload: unknown = {}) { this.socket.send(JSON.stringify(createEnvelope(type, payload))); }
  wait(type: string, predicate: (message: Envelope<any>) => boolean = () => true) {
    return until(() => this.messages.find((message) => message.type === type && predicate(message)));
  }
  async join(groupId: string, userName: string, inviteCode?: string) {
    this.send("group.join", { groupId, userName, inviteCode });
    const welcome = await this.wait("membership.welcome");
    await this.wait("snapshot", (message) => message.payload.group?.groupId === groupId);
    return welcome.payload.membershipCredential as string;
  }
}

describe("手机 Web transport 与真实 Broker", () => {
  let directory: string, broker: BrokerServer, desktop: BrokerClient;
  const phones: Phone[] = [], desktopMessages: BrokerEnvelope[] = [];
  afterEach(async () => {
    phones.forEach((phone) => phone.socket.terminate()); phones.length = 0;
    await desktop?.stop(); await broker?.close(); desktopMessages.length = 0;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function setup(options: BrokerServerOptions = {}, inviteRequired = false) {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-web-"));
    broker = createBrokerServer({ listen: { host: "127.0.0.1", port: 0 }, dbPath: join(directory, "comms.db"), mode: "lan-host", networkAccessRequired: false, mdnsPublisherFactory: () => ({ async stop() {} }), webPort: 0, disconnectGraceMs: 20, ...options });
    await broker.start();
    desktop = new BrokerClient({ endpoint: broker.endpoint, deviceId: randomUUID(), onMessage: (message) => desktopMessages.push(message), onDisconnected() {} });
    expect(await desktop.start("desktop")).toBe(true);
    desktop.send("group.create", { groupName: "手机实验组", userName: "Alice", agentName: "Alice-Pi", agentDescription: "测试助手", visibility: "nearby", inviteRequired });
    const welcome = await until(() => desktopMessages.find((message) => message.type === "membership.welcome"));
    if (welcome.type !== "membership.welcome") throw new Error("missing membership");
    return welcome.payload;
  }
  async function phone(deviceId?: string, sessionId?: string) {
    const result = new Phone(broker.webPort!, deviceId, sessionId); phones.push(result); await result.start(); return result;
  }
  it("同一邀请的两个独立用户、文本、Agent 回答、刷新、接管和退出", async () => {
    const { groupId } = await setup();
    const url = mobileInvitationUrl("127.0.0.1", groupId, undefined, broker.webPort);
    const response = await fetch(url); expect(response.status).toBe(200); expect(await response.text()).toContain("join-form");
    for (const path of ["app.js", "style.css"]) expect((await fetch(`http://127.0.0.1:${broker.webPort}/${path}`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${broker.webPort}/api/groups/${groupId}`)).json()).toMatchObject({ groupName: "手机实验组" });
    const bob = await phone(), carol = await phone();
    bob.send("ping"); await bob.wait("pong");
    expect(bob.messages.some((m) => m.type === "error")).toBe(false);
    const credential = await bob.join(groupId, "Bob"); await carol.join(groupId, "Carol");
    bob.send("chat.send", { text: "Bob 从手机打招呼" });
    await carol.wait("chat.message", (m) => m.payload.text === "Bob 从手机打招呼");
    await until(() => desktopMessages.find((m) => m.type === "chat.message" && m.payload.text === "Bob 从手机打招呼"));
    carol.send("chat.send", { text: "@Alice-Pi 帮我测试" });
    const delivery = await until(() => desktopMessages.find((m) => m.type === "agent.deliver"));
    if (delivery.type !== "agent.deliver") throw new Error("missing delivery");
    expect(delivery.payload.participants.find((p) => p.user.name === "Bob")).toEqual({ user: { name: "Bob", online: true, isOwner: false } });
    desktop.send("agent.deliver.ack", { requestId: delivery.payload.requestId });
    desktop.send("agent.result", { requestId: delivery.payload.requestId, ok: true, text: "手机 Agent 闭环成功" });
    await bob.wait("chat.message", (m) => m.payload.text === "手机 Agent 闭环成功");
    await carol.wait("chat.message", (m) => m.payload.text === "手机 Agent 闭环成功");
    bob.socket.close(); await until(() => bob.closed ? true : undefined);
    const refreshed = await phone(bob.deviceId, bob.sessionId);
    refreshed.send("group.join", { groupId, membershipCredential: credential });
    const snapshot = await refreshed.wait("snapshot", (m) => !!m.payload.group);
    expect(snapshot.payload.members.map((m: any) => m.displayName).sort()).toEqual(["Alice", "Alice-Pi", "Bob", "Carol"]);
    expect(snapshot.payload.messages.some((m: any) => m.text === "手机 Agent 闭环成功")).toBe(true);
    expect(snapshot.payload.mcpAccess).toBeUndefined();
    const takeover = await phone(bob.deviceId, bob.sessionId);
    takeover.send("group.join", { groupId, membershipCredential: credential });
    await takeover.wait("snapshot", (m) => !!m.payload.group);
    expect((await refreshed.wait("error")).payload.code).toBe("session_in_use");
    await until(() => refreshed.closed ? true : undefined);
    carol.messages.length = 0;
    carol.send("group.leave"); await carol.wait("snapshot", (m) => !m.payload.group && m.payload.members.length === 0);
    const db = new BrokerDatabase(broker.dbPath);
    expect(db.memberships(groupId).map((m) => m.userName).sort()).toEqual(["Alice", "Bob"]);
    expect(db.memberships(groupId).find((m) => m.userName === "Bob")?.agentName).toBeUndefined();
    expect(db.memberships(groupId).find((m) => m.userName === "Bob")?.proactiveEnabled).toBe(false);
    db.close();
  });
  it("名称不能撞 Agent、拒绝越权协议、邀请码轮换和恢复不受影响", async () => {
    const { groupId, inviteCode, ownerCredential } = await setup({}, true);
    const bob = await phone();
    bob.send("group.join", { groupId, userName: "Alice-Pi", inviteCode });
    expect((await bob.wait("error")).payload.code).toBe("member_name_conflict");
    bob.messages.length = 0;
    const credential = await bob.join(groupId, "Bob", inviteCode);
    for (const type of ["group.create", "agent.result", "proactive.update", "broker.config.update", "permission.update", "mcp.access"]) {
      bob.messages.length = 0; bob.send(type, { apiKey: "x" });
      expect((await bob.wait("error")).payload.code).toBe("unsupported_type");
    }
    desktop.send("group.invite.rotate", { groupId, ownerCredential });
    await until(() => desktopMessages.find((m) => m.type === "group.invite.updated"));
    const carol = await phone(); carol.send("group.join", { groupId, userName: "Carol", inviteCode });
    expect((await carol.wait("error")).payload.code).toBe("invite_invalid");
    const restored = await phone(bob.deviceId, bob.sessionId);
    restored.send("group.join", { groupId, membershipCredential: credential });
    await restored.wait("snapshot", (m) => !!m.payload.group);
    expect(mobileInvitationUrl("192.168.1.23", groupId, inviteCode)).toContain("#/join/");
    expect(new URL(mobileInvitationUrl("192.168.1.23", groupId, inviteCode)).search).toBe("");
    expect(await mobileInvitationQr("http://127.0.0.1:43128/#/join/test")).toContain("█");
  });
  it("坏凭证不能接管，停止附近加入关闭 Web，TCP 保持可用", async () => {
    const { groupId, ownerCredential } = await setup();
    const bob = await phone(); await bob.join(groupId, "Bob");
    const fake = await phone(bob.deviceId, bob.sessionId);
    fake.send("group.join", { groupId, membershipCredential: "wrong" });
    expect((await fake.wait("error")).payload.code).toBe("membership_invalid"); expect(bob.closed).toBe(false);
    desktop.send("group.visibility.update", { groupId, visibility: "local", ownerCredential });
    expect((await bob.wait("error")).payload.code).toBe("invite_invalid");
    await until(() => bob.closed ? true : undefined); expect(desktop.connected).toBe(true);
    const carol = await phone(); carol.send("group.join", { groupId, userName: "Carol" });
    expect((await carol.wait("error")).payload.code).toBe("invite_invalid");
  });
  it("Broker 重启后长期 Web membership 可恢复", async () => {
    const { groupId } = await setup();
    const bob = await phone(); const credential = await bob.join(groupId, "Bob");
    await desktop.stop(); await broker.close();
    broker = createBrokerServer({ listen: { host: "127.0.0.1", port: 0 }, dbPath: join(directory, "comms.db"), mode: "lan-host", networkAccessRequired: false, webPort: 0, mdnsPublisherFactory: () => ({ async stop() {} }) });
    await broker.start();
    const restored = await phone(bob.deviceId, bob.sessionId); restored.send("group.join", { groupId, membershipCredential: credential });
    const snapshot = await restored.wait("snapshot", (m) => !!m.payload.group);
    expect(snapshot.payload.members.filter((m: any) => m.displayName === "Bob")).toHaveLength(1);
    const db = new BrokerDatabase(broker.dbPath); expect(db.membership(groupId, createSessionKey(bob.deviceId, bob.sessionId))?.userName).toBe("Bob"); db.close();
  });
  it("固定 Web 端口被占用时 TCP 仍能启动并报告错误", async () => {
    const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const port = (occupied.address() as { port: number }).port;
      await setup({ webPort: port });
      expect(broker.webPort).toBeUndefined(); expect(broker.webError).toContain("已被占用"); expect(desktop.webError).toContain("已被占用"); expect(desktop.connected).toBe(true);
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  });
  it("手机发起 10 轮接力后只有发起者能继续和结束", async () => {
    const { groupId } = await setup();
    const agentMessages: BrokerEnvelope[] = [];
    const second = new BrokerClient({ endpoint: broker.endpoint, deviceId: randomUUID(), onMessage: (m) => agentMessages.push(m), onDisconnected() {} });
    try {
      expect(await second.start("second-agent")).toBe(true);
      second.send("group.join", { groupId, userName: "Dave", agentName: "Dave-Pi", agentDescription: "接力助手" });
      await until(() => agentMessages.find((m) => m.type === "snapshot" && !!m.payload.group));
      const bob = await phone(), carol = await phone();
      await bob.join(groupId, "Bob"); await carol.join(groupId, "Carol");
      bob.send("chat.send", { text: "@Alice-Pi 开始接力" });
      const seen = new Set<string>();
      async function rounds(count: number) {
        for (let i = 0; i < count; i++) {
          const message = await until(() => [...desktopMessages, ...agentMessages].find((m) => m.type === "agent.deliver" && !seen.has(m.payload.requestId)));
          if (message.type !== "agent.deliver") throw new Error("missing delivery");
          seen.add(message.payload.requestId);
          const alice = message.payload.targetAgentName === "Alice-Pi";
          const target = alice ? desktop : second;
          target.send("agent.deliver.ack", { requestId: message.payload.requestId });
          target.send("agent.result", { requestId: message.payload.requestId, ok: true, text: `@${alice ? "Dave-Pi" : "Alice-Pi"} 继续接力` });
        }
      }
      await rounds(10);
      const paused = await bob.wait("chain.paused");
      expect(paused.payload.roundLimit).toBe(10);
      expect(carol.messages.some((m) => m.type === "chain.paused")).toBe(false);
      carol.send("chain.continue", { chainId: paused.payload.chainId });
      expect((await carol.wait("error")).payload.code).toBe("request_invalid");
      bob.send("chain.continue", { chainId: paused.payload.chainId });
      expect((await bob.wait("chain.resolved")).payload.action).toBe("continued");
      await rounds(10);
      const paused20 = await bob.wait("chain.paused", (m) => m.payload.roundLimit === 20);
      carol.messages.length = 0; carol.send("chain.end", { chainId: paused20.payload.chainId });
      expect((await carol.wait("error")).payload.code).toBe("request_invalid");
      bob.send("chain.end", { chainId: paused20.payload.chainId });
      expect((await bob.wait("chain.resolved", (m) => m.payload.action === "ended")).payload.action).toBe("ended");
    } finally { await second.stop(); }
  });
  it("邀请码失败沿用 Broker 限流", async () => {
    const { groupId } = await setup({ inviteFailureLimit: 1 }, true);
    const first = await phone(); first.send("group.join", { groupId, userName: "Bob", inviteCode: "WRONG" });
    expect((await first.wait("error")).payload.code).toBe("invite_invalid");
    const second = await phone(); second.send("group.join", { groupId, userName: "Carol", inviteCode: "WRONG" });
    expect((await second.wait("error")).payload.code).toBe("invite_rate_limited");
  });
  it("网络未确认时拒绝 Web HTTP", async () => {
    await setup({ networkAccessRequired: true });
    expect((await fetch(`http://127.0.0.1:${broker.webPort}/`)).status).toBe(403);
  });
  it.skipIf(primaryOrdinaryNetwork() === undefined)("已连接手机在网络授权失效时关闭，长期身份保留", async () => {
    const { groupId } = await setup({ networkAccessRequired: true });
    await new NetworkAccessStore(broker.dbPath).confirm(primaryOrdinaryNetwork()!);
    const refreshed = desktop.send("broker.network.refresh", {});
    await until(() => desktopMessages.find((m) => m.type === "broker.network.updated" && m.payload.requestId === refreshed && m.payload.allowed));
    const bob = await phone(); await bob.join(groupId, "Bob");
    await rm(`${broker.dbPath}.networks.json`);
    desktop.send("broker.network.refresh", {});
    expect((await bob.wait("error")).payload.code).toBe("network_unavailable");
    await until(() => bob.closed ? true : undefined);
    const db = new BrokerDatabase(broker.dbPath); expect(db.memberships(groupId).some((m) => m.userName === "Bob")).toBe(true); db.close();
  });
  it("移出手机成员和解散群组都明确关闭 Web", async () => {
    const { groupId, ownerCredential } = await setup();
    const bob = await phone(), carol = await phone(); await bob.join(groupId, "Bob"); await carol.join(groupId, "Carol");
    desktop.send("group.member.remove", { groupId, ownerCredential, sessionKey: createSessionKey(bob.deviceId, bob.sessionId) });
    expect((await bob.wait("error")).payload.code).toBe("member_removed"); await until(() => bob.closed ? true : undefined);
    desktop.send("group.delete", { groupId, ownerCredential });
    expect((await carol.wait("error")).payload.code).toBe("group_deleted"); await until(() => carol.closed ? true : undefined);
  });
  it("只有手机在线时 Broker 保持存活，全部离线后按 idle 规则关闭", async () => {
    const { groupId } = await setup({ idleShutdownMs: 100 });
    const bob = await phone(); await bob.join(groupId, "Bob"); await desktop.stop();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect((await fetch(`http://127.0.0.1:${broker.webPort}/`)).status).toBe(200);
    bob.socket.close(); await until(() => bob.closed ? true : undefined);
    await until(() => broker.webPort === undefined ? true : undefined);
    const db = new BrokerDatabase(broker.dbPath); expect(db.memberships(groupId).some((m) => m.userName === "Bob")).toBe(true); db.close();
  });
  it("local 模式拒绝 Web HTTP 和 WebSocket", async () => {
    await setup({ mode: "local" });
    expect((await fetch(`http://127.0.0.1:${broker.webPort}/`)).status).toBe(403);
    const ws = new WebSocket(`ws://127.0.0.1:${broker.webPort}/ws`);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); ws.terminate(); });
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });
});
