import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { brokerLockPath } from "../src/broker/process-lock.js";
import {
  startLanHostBroker,
  startLocalBroker,
  stopBroker,
} from "../src/extension/broker-process.js";
import { probeBroker } from "../src/transport/broker-probe.js";

interface ChildRecord {
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
}

describe("Broker 跨进程竞争", () => {
  let directory: string | undefined;
  const children: ChildRecord[] = [];
  const previousDisableMdns = process.env.PI_COMMS_DISABLE_MDNS;

  beforeAll(() => {
    process.env.PI_COMMS_DISABLE_MDNS = "1";
  });

  afterAll(() => {
    if (previousDisableMdns === undefined) {
      delete process.env.PI_COMMS_DISABLE_MDNS;
    } else {
      process.env.PI_COMMS_DISABLE_MDNS = previousDisableMdns;
    }
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => child.exit));
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("两个进程并发首次启动时只有一个监听，另一个正常复用", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-process-"));
    const dbPath = join(directory, "comms.db");
    const port = await freePort();
    const endpoint = { host: "127.0.0.1", port };
    children.push(startBrokerProcess(port, dbPath), startBrokerProcess(port, dbPath));

    await waitFor(
      () => children.some((child) => child.stdout.includes("正在监听")) &&
        children.some((child) => child.stdout.includes("复用现有")),
      12_000,
      () => children.map((child) => ({ stdout: child.stdout, stderr: child.stderr })),
    );

    const owner = children.find((child) => child.stdout.includes("正在监听"));
    const follower = children.find((child) => child.stdout.includes("复用现有"));
    expect(owner).toBeDefined();
    expect(follower).toBeDefined();
    await expect(follower?.exit).resolves.toBe(0);
    await expect(probeBroker(endpoint)).resolves.toMatchObject({ status: "compatible" });

    owner?.process.kill("SIGTERM");
    await expect(owner?.exit).resolves.toBe(0);
    await expect(access(brokerLockPath(dbPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("使用统一 launcher 从本机模式优雅切换为局域网主机", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-switch-"));
    const dbPath = join(directory, "comms.db");
    const endpoint = { host: "127.0.0.1", port: await freePort() };
    const originalCwd = process.cwd();
    process.chdir(directory);
    try {
      await startLocalBroker(endpoint, dbPath);
      const local = await probeBroker(endpoint);
      expect(local).toMatchObject({
        status: "compatible",
        brokerMode: "local",
      });
      if (local.status !== "compatible") throw new Error("本机 Broker 未启动");

      await startLanHostBroker(endpoint, dbPath);
      const host = await probeBroker(endpoint);
      expect(host).toMatchObject({
        status: "compatible",
        brokerId: local.brokerId,
        brokerMode: "lan-host",
      });
      if (host.status !== "compatible") throw new Error("局域网 Broker 未启动");
      expect(host.brokerInstanceId).not.toBe(local.brokerInstanceId);
    } finally {
      if ((await probeBroker(endpoint)).status === "compatible") {
        await stopBroker(endpoint);
      }
      process.chdir(originalCwd);
    }
  }, 20_000);
});

function startBrokerProcess(port: number, dbPath: string): ChildRecord {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    resolve("src/broker/launcher.ts"),
    "--mode",
    "local",
    "--port",
    String(port),
    "--db",
    dbPath,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record: ChildRecord = {
    process: child,
    stdout: "",
    stderr: "",
    exit: new Promise((resolveExit) => child.once("exit", resolveExit)),
  };
  child.stdout?.on("data", (chunk) => { record.stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { record.stderr += String(chunk); });
  return record;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("未获得临时端口");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  debug: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 Broker 进程超时：${JSON.stringify(debug())}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
