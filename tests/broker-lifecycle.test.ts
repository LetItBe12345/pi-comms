import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { probeBroker } from "../src/transport/broker-probe.js";
import type { BrokerEnvelope } from "../src/protocol.js";

describe("Broker 空闲生命周期", () => {
  let directory: string | undefined;
  let broker: BrokerServer | undefined;

  afterEach(async () => {
    await broker?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("有 Session 在线时保持运行，最后一个 Session 离开后按时退出", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-lifecycle-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      idleShutdownMs: 60,
    });
    await broker.start();
    const endpoint = broker.endpoint;
    const client = new BrokerClient({
      endpoint,
      deviceId: "00000000-0000-4000-8000-000000000301",
      onMessage() {},
      onDisconnected() {},
    });
    expect(await client.start("lifecycle-session")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(probeBroker(endpoint)).resolves.toMatchObject({ status: "compatible" });

    await client.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(probeBroker(endpoint)).resolves.toEqual({ status: "unreachable" });
  });

  it("任一群组要求后台开放时保持运行，并同步自启设置", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-lifecycle-"));
    const configureAutostart = vi.fn(async () => {});
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      idleShutdownMs: 40,
      configureAutostart,
    });
    await broker.start();
    const messages: BrokerEnvelope[] = [];
    const client = new BrokerClient({
      endpoint: broker.endpoint,
      deviceId: "00000000-0000-4000-8000-000000000302",
      onMessage: (message) => messages.push(message),
      onDisconnected() {},
    });
    expect(await client.start("background-session")).toBe(true);
    client.send("group.create", {
      groupName: "后台群组",
      userName: "Alice",
      agentName: "Alice-Pi",
      visibility: "nearby",
    });
    const welcome = await waitForMessage(
      messages,
      (message) => message.type === "membership.welcome",
    );
    if (welcome.type !== "membership.welcome" ||
      welcome.payload.ownerCredential === undefined) {
      throw new Error("未获得群主凭证");
    }
    client.send("group.availability.update", {
      groupId: welcome.payload.groupId,
      keepAvailableWhenEmpty: true,
      openAtLogin: false,
      ownerCredential: welcome.payload.ownerCredential,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(configureAutostart).toHaveBeenCalledWith(
      true,
      false,
      join(directory, "comms.db"),
    );
    const endpoint = broker.endpoint;
    await client.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(probeBroker(endpoint)).resolves.toMatchObject({
      status: "compatible",
    });
  });
});

async function waitForMessage(
  messages: BrokerEnvelope[],
  predicate: (message: BrokerEnvelope) => boolean,
): Promise<BrokerEnvelope> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待消息超时");
}
