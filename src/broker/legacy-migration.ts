import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";

export const LEGACY_SOCKET_PATH = join(homedir(), ".pi", "comms", "broker.sock");
export const LEGACY_LOCK_PATH = `${LEGACY_SOCKET_PATH}.lock`;

export interface LegacyBrokerPaths {
  socketPath: string;
  lockPath: string;
}

const DEFAULT_LEGACY_PATHS: LegacyBrokerPaths = {
  socketPath: LEGACY_SOCKET_PATH,
  lockPath: LEGACY_LOCK_PATH,
};

export async function assertNoLiveLegacyBroker(
  paths: LegacyBrokerPaths = DEFAULT_LEGACY_PATHS,
): Promise<void> {
  if (platform() === "win32") return;
  const pid = await legacyBrokerPid(paths.lockPath);
  if (pid !== undefined && processExists(pid)) {
    throw new Error(
      `检测到旧 Unix Broker（PID ${pid}）。请先运行 npm run broker:migrate`,
    );
  }
  await removeLegacyFiles(paths);
}

export async function migrateLegacyBroker(
  paths: LegacyBrokerPaths = DEFAULT_LEGACY_PATHS,
): Promise<string> {
  if (platform() === "win32") return "Windows 不需要迁移 Unix Broker";

  const pid = await legacyBrokerPid(paths.lockPath);
  if (pid === undefined || !processExists(pid)) {
    await removeLegacyFiles(paths);
    return "没有正在运行的旧 Unix Broker，遗留文件已清理";
  }
  if (!(await probeLegacyBroker(paths.socketPath))) {
    throw new Error("旧 Socket 未通过 Pi Comms 校验，拒绝停止对应进程");
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (processExists(pid)) {
    throw new Error(`旧 Broker 未能退出（PID ${pid}）`);
  }
  await removeLegacyFiles(paths);
  return `旧 Unix Broker 已停止（PID ${pid}）`;
}

async function probeLegacyBroker(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    const decoder = new JsonlDecoder();
    let settled = false;
    const timer = setTimeout(() => finish(false), 1_500);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(ok);
    };

    socket.once("connect", () => {
      socket.write(encodeEnvelope(createEnvelope("client.hello", {
        sessionId: `legacy-migration-${randomUUID()}`,
        permission: "blocked",
      })));
    });
    socket.on("data", (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) return finish(false);
        const message = result.value as BrokerEnvelope;
        if (
          message.type === "snapshot" &&
          typeof message.payload.brokerInstanceId === "string" &&
          message.payload.brokerInstanceId.length > 0
        ) {
          return finish(true);
        }
      }
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

async function legacyBrokerPid(lockPath: string): Promise<number | undefined> {
  const value = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeLegacyFiles(paths: LegacyBrokerPaths): Promise<void> {
  await Promise.all([paths.socketPath, paths.lockPath].map(async (path) => {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}
