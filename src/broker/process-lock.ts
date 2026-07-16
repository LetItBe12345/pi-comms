import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
}

export class BrokerLockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly ownerPid?: number,
  ) {
    super(`Broker 数据目录已被占用：${lockPath}`);
  }
}

export interface BrokerProcessLock {
  readonly path: string;
  readonly ownerPid: number;
  release(): Promise<void>;
}

export function brokerLockPath(dbPath: string): string {
  return `${dbPath}.broker.lock`;
}

export async function acquireBrokerProcessLock(dbPath: string): Promise<BrokerProcessLock> {
  const path = brokerLockPath(dbPath);
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: LockRecord = { pid: process.pid, token: randomUUID() };
    try {
      const file = await open(path, "wx");
      try {
        await file.writeFile(JSON.stringify(record));
      } finally {
        await file.close();
      }
      let released = false;
      return {
        path,
        ownerPid: process.pid,
        async release() {
          if (released) return;
          released = true;
          const current = await readLock(path);
          if (current?.token === record.token) {
            await removeLock(path);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readPublishedLock(path);
      if (owner === undefined || processExists(owner.pid)) {
        throw new BrokerLockBusyError(path, owner?.pid);
      }
      await removeLock(path);
    }
  }

  throw new BrokerLockBusyError(path);
}

async function readPublishedLock(path: string): Promise<LockRecord | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const record = await readLock(path);
    if (record !== undefined) return record;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return undefined;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    return Number.isInteger(value.pid) && typeof value.token === "string"
      ? { pid: value.pid as number, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

async function removeLock(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
