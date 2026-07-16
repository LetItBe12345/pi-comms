import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoLiveLegacyBroker,
  migrateLegacyBroker,
} from "../src/broker/legacy-migration.js";

describe.skipIf(process.platform === "win32")("旧 Unix Broker 迁移", () => {
  let directory: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("只在握手确认后停止旧 Broker 并清理文件", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-legacy-"));
    const paths = {
      socketPath: join(directory, "broker.sock"),
      lockPath: join(directory, "broker.sock.lock"),
    };
    child = spawnLegacyBroker(paths.socketPath);
    await waitForOutput(child, "ready");
    if (child.pid === undefined) throw new Error("旧 Broker 没有 PID");
    await writeFile(paths.lockPath, String(child.pid));

    await expect(assertNoLiveLegacyBroker(paths)).rejects.toThrow("检测到旧 Unix Broker");
    await expect(migrateLegacyBroker(paths)).resolves.toContain(`PID ${child.pid}`);
    await Promise.all([
      expect(access(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" }),
      expect(access(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" }),
    ]);
  });
});

function spawnLegacyBroker(socketPath: string): ChildProcess {
  const script = String.raw`
    const net = require("node:net");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline));
        if (request.type === "client.hello") {
          socket.write(JSON.stringify({
            id: "snapshot",
            type: "snapshot",
            timestamp: Date.now(),
            payload: {
              brokerInstanceId: "legacy-broker",
              clientId: "legacy-client",
              groups: [],
              members: [],
              messages: []
            }
          }) + "\n");
        }
      });
    });
    server.listen(process.argv[1], () => console.log("ready"));
    process.once("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  return spawn(process.execPath, ["-e", script, socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    const timer = setTimeout(() => rejectOutput(new Error("等待旧 Broker 超时")), 2_000);
    child.stdout?.on("data", (chunk) => {
      if (!String(chunk).includes(expected)) return;
      clearTimeout(timer);
      resolveOutput();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectOutput(new Error(`旧 Broker 提前退出：${code}`));
    });
  });
}
