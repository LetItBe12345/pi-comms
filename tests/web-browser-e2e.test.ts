import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { expect, it } from "vitest";
import { createBrokerServer } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { BrokerDatabase } from "../src/broker/database.js";
import { mobileInvitationUrl } from "../src/web/invitation.js";
import { primaryOrdinaryNetwork } from "../src/discovery/network.js";
import type { BrokerEnvelope } from "../src/protocol.js";

it("Chromium 窄屏：两手机聊天、Agent 回答、刷新、接管、断网恢复、退出和 Broker 重启", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-comms-browser-"));
  const artifacts = process.env.PI_COMMS_BROWSER_ARTIFACTS ?? join(directory, "screenshots");
  await mkdir(artifacts, { recursive: true });
  const messages: BrokerEnvelope[] = [], errors: string[] = [];
  const options = { listen: { host: "0.0.0.0", port: 0 }, dbPath: join(directory, "comms.db"), mode: "lan-host" as const, networkAccessRequired: false, mdnsPublisherFactory: () => ({ async stop() {} }), webPort: 0, disconnectGraceMs: 50 };
  let broker = createBrokerServer(options);
  let browser: Browser | undefined;
  let relay: BrokerClient | undefined;
  let chainMode = false;
  const desktop = new BrokerClient({ endpoint: { host: "127.0.0.1", port: 1 }, deviceId: randomUUID(), onDisconnected() {}, onMessage(message) {
    messages.push(message);
    if (message.type === "agent.deliver") {
      desktop.send("agent.deliver.ack", { requestId: message.payload.requestId });
      desktop.send("agent.result", { requestId: message.payload.requestId, ok: true, text: chainMode ? "@Relay-Pi 继续接力" : "浏览器 Agent 路由已通过（测试回复）" });
    }
  } });
  async function wait<T>(read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const result = read(); if (result !== undefined) return result; await new Promise((resolve) => setTimeout(resolve,20)); }
    throw new Error("浏览器测试等待超时");
  }
  async function checkText(page: Page, selector: string, text: string) {
    await page.waitForFunction(({selector,text}) => document.querySelector(selector)?.textContent?.includes(text), {selector,text});
  }
  try {
    await broker.start();
    await desktop.setEndpoint({ host: "127.0.0.1", port: broker.endpoint.port });
    expect(await desktop.start("desktop-browser")).toBe(true);
    desktop.send("group.create", { groupName: "手机浏览器验收", userName: "Alice", agentName: "Alice-Pi", agentDescription: "浏览器测试助手", visibility: "nearby" });
    const welcome = await wait(() => messages.find((m) => m.type === "membership.welcome"));
    if (welcome.type !== "membership.welcome") throw new Error("missing group");
    const groupId = welcome.payload.groupId;
    const host = primaryOrdinaryNetwork()?.address ?? "127.0.0.1";
    let url = mobileInvitationUrl(host, groupId, undefined, broker.webPort);
    const systemChromium = !process.env.CI && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
    browser = await chromium.launch({ executablePath: process.env.PI_COMMS_TEST_CHROMIUM ?? systemChromium, headless: true, args: ["--no-sandbox"] });
    const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const carolContext = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
    const bob = await bobContext.newPage(), carol = await carolContext.newPage();
    for (const page of [bob,carol]) page.on("pageerror", (error) => errors.push(error.message));
    await Promise.all([bob.goto(url), carol.goto(url)]);
    await checkText(bob,"#group-name","手机浏览器验收");
    await bob.locator("#join-button").waitFor({ state: "visible" });
    await bob.waitForFunction(() => !(document.querySelector("#join-button") as HTMLButtonElement).disabled);
    await bob.screenshot({ path: join(artifacts,"27-web-join.png") });
    await bob.locator("#username").fill("Bob"); await bob.locator("#join-button").click();
    await bob.locator("#chat-view").waitFor({ state: "visible" });
    await carol.locator("#username").fill("Carol"); await carol.locator("#join-button").click();
    await carol.locator("#chat-view").waitFor({ state: "visible" });
    await bob.locator("#message").fill("来自 Bob 手机页面的中文消息"); await bob.locator("#send-button").click();
    await checkText(carol,"#messages","来自 Bob 手机页面的中文消息");
    await carol.locator("#message").fill("@Alice-Pi 请验证浏览器消息路由"); await carol.locator("#send-button").click();
    await checkText(bob,"#messages","浏览器 Agent 路由已通过"); await checkText(carol,"#messages","浏览器 Agent 路由已通过");
    await bob.locator("#members").click(); await checkText(bob,"#member-list","Carol");
    expect(await bob.locator("#member-list").textContent()).not.toContain("Bob-Pi");
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await bob.screenshot({ path: join(artifacts,"27-web-chat.png"), fullPage: true });
    const before = await bob.evaluate((key) => localStorage.getItem(key), `pi-comms:group:${groupId}`);
    await bob.reload(); await bob.locator("#chat-view").waitFor({ state: "visible" });
    expect(await bob.evaluate((key) => localStorage.getItem(key), `pi-comms:group:${groupId}`)).toBe(before);
    const secondTab = await bobContext.newPage(); secondTab.on("pageerror", (error) => errors.push(error.message));
    await secondTab.goto(url); await secondTab.locator("#chat-view").waitFor({ state: "visible" });
    await checkText(bob,"#status","其他标签页接管"); expect(await bob.locator("#send-button").isDisabled()).toBe(true);
    await bob.screenshot({ path: join(artifacts,"27-web-takeover.png") });
    await bobContext.setOffline(true); await checkText(secondTab,"#status","离线");
    expect(await secondTab.locator("#send-button").isDisabled()).toBe(true);
    await bobContext.setOffline(false); await checkText(secondTab,"#status","在线");
    const relayMessages: BrokerEnvelope[] = [];
    relay = new BrokerClient({ endpoint: { host: "127.0.0.1", port: broker.endpoint.port }, deviceId: randomUUID(), onDisconnected() {}, onMessage(message) {
      relayMessages.push(message);
      if (message.type === "agent.deliver") {
        relay!.send("agent.deliver.ack", { requestId: message.payload.requestId });
        relay!.send("agent.result", { requestId: message.payload.requestId, ok: true, text: "@Alice-Pi 继续接力" });
      }
    } });
    expect(await relay.start("browser-relay")).toBe(true);
    relay.send("group.join", { groupId, userName: "Dave", agentName: "Relay-Pi", agentDescription: "接力测试助手" });
    await wait(() => relayMessages.find((m) => m.type === "snapshot" && !!m.payload.group));
    chainMode = true;
    await secondTab.locator("#message").fill("@Alice-Pi 开始浏览器接力"); await secondTab.locator("#send-button").click();
    await checkText(secondTab,"#chains","10 轮");
    expect(await carol.locator("#chains button").count()).toBe(0);
    await secondTab.screenshot({ path: join(artifacts,"27-web-chain-paused.png"), fullPage: true });
    await secondTab.locator("#chains button").filter({ hasText: "继续" }).click();
    await checkText(secondTab,"#chains","20 轮");
    await secondTab.locator("#chains button").filter({ hasText: "结束" }).click();
    await secondTab.waitForFunction(() => document.querySelectorAll("#chains button").length === 0);
    chainMode = false;
    await carol.locator("#leave-button").click(); await carol.locator("#leave-dialog").waitFor({ state: "visible" });
    await carol.locator("#cancel-leave").click(); expect(await carol.locator("#chat-view").isVisible()).toBe(true);
    await carol.locator("#leave-button").click(); await carol.locator("#confirm-leave").click();
    await carol.locator("#join-view").waitFor({ state: "visible" });
    expect(await carol.evaluate((key) => JSON.parse(localStorage.getItem(key)!).membershipCredential, `pi-comms:group:${groupId}`)).toBeUndefined();
    const db = new BrokerDatabase(broker.dbPath); expect(db.memberships(groupId).map((m) => m.userName).sort()).toEqual(["Alice","Bob","Dave"]); db.close();
    const fixedPort = broker.webPort!;
    await relay.stop(); await desktop.stop(); await broker.close();
    await checkText(secondTab,"#status","离线");
    broker = createBrokerServer({ ...options, webPort: fixedPort }); await broker.start();
    expect(broker.webPort).toBe(fixedPort);
    await checkText(secondTab,"#status","在线"); await checkText(secondTab,"#messages","来自 Bob 手机页面的中文消息");
    await secondTab.screenshot({ path: join(artifacts,"27-web-restored.png"), fullPage: true });
    const restored = new BrokerDatabase(broker.dbPath); expect(restored.memberships(groupId).filter((m) => m.userName === "Bob")).toHaveLength(1); restored.close();
    await desktop.setEndpoint({ host: "127.0.0.1", port: broker.endpoint.port });
    expect(await desktop.start("desktop-browser")).toBe(true);
    desktop.send("group.join", { groupId, membershipCredential: welcome.payload.membershipCredential });
    await wait(() => messages.find((m) => m.type === "snapshot" && m.payload.brokerInstanceId === broker.instanceId && !!m.payload.group));
    desktop.send("group.visibility.update", { groupId, ownerCredential: welcome.payload.ownerCredential, visibility: "local" });
    await checkText(secondTab,"#status","停止向附近设备开放");
    expect(await secondTab.locator("#send-button").isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); await relay?.stop(); await desktop.stop(); await broker.close(); await rm(directory,{recursive:true,force:true});
  }
}, 60_000);
