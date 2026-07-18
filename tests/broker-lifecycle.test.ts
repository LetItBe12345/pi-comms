import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import { probeBroker } from "../src/transport/broker-probe.js";

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
});
