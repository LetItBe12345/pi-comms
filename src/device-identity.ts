import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DEVICE_ID_PATH = join(homedir(), ".pi", "comms", "device-id");

export function loadOrCreateDeviceId(path = DEFAULT_DEVICE_ID_PATH): string {
  try {
    return readDeviceId(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  mkdirSync(dirname(path), { recursive: true });
  const deviceId = randomUUID();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${deviceId}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    return deviceId;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      try {
        unlinkSync(path);
      } catch {
        // 文件可能已被其他进程接管。
      }
    }
    if (isAlreadyExists(error)) return readDeviceId(path);
    throw error;
  }
}

function readDeviceId(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!isUuid(value)) {
    throw new Error(`设备身份文件无效：${path}`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
