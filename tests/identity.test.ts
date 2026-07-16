import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateDeviceId } from "../src/device-identity.js";
import { createSessionKey, parseSessionKey } from "../src/session-key.js";

describe("设备与 Session 身份", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("首次生成 deviceId，后续启动稳定复用", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-device-"));
    const path = join(directory, "nested", "device-id");
    const first = loadOrCreateDeviceId(path);
    expect(loadOrCreateDeviceId(path)).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
  });

  it("已有设备身份损坏时拒绝静默覆盖", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-device-"));
    const path = join(directory, "device-id");
    await writeFile(path, "broken\n", "utf8");
    expect(() => loadOrCreateDeviceId(path)).toThrow("设备身份文件无效");
    expect(await readFile(path, "utf8")).toBe("broken\n");
  });

  it("SessionKey 无歧义编码并可解析", () => {
    const key = createSessionKey("device:a", "session:b:c");
    expect(parseSessionKey(key)).toEqual({
      deviceId: "device:a",
      sessionId: "session:b:c",
    });
    expect(key).not.toBe(createSessionKey("device:a:session", "b:c"));
  });
});
