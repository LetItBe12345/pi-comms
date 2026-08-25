import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  maskApiKey,
  normalizeAgentDescription,
  ProactiveConfigStore,
} from "../src/broker/proactive-config.js";

describe("Broker Proactive 配置", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  async function store(): Promise<ProactiveConfigStore> {
    const directory = await mkdtemp(join(tmpdir(), "pi-comms-config-"));
    directories.push(directory);
    return new ProactiveConfigStore(join(directory, "config.json"));
  }

  it("规范化 Description 并只显示 Key 后四位", () => {
    expect(normalizeAgentDescription("  负责\n  Node.js   和 SQLite  ")).toBe(
      "负责 Node.js 和 SQLite",
    );
    expect([...normalizeAgentDescription("甲".repeat(300))]).toHaveLength(240);
    expect(maskApiKey("sk-12345678")).toBe("****5678");
  });

  it("原子保存、恢复、标记无效和删除 Key", async () => {
    const config = await store();
    expect(config.load().proactiveStatus).toBe("unconfigured");
    const ready = config.saveVerified("sk-test-1234");
    expect(ready).toMatchObject({
      proactiveStatus: "ready",
      maskedApiKey: "****1234",
      configVersion: 1,
    });
    if (process.platform !== "win32") {
      expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    }
    const restored = new ProactiveConfigStore(config.path);
    expect(restored.load()).toMatchObject({ proactiveStatus: "ready", configVersion: 1 });
    expect(restored.markInvalid().proactiveStatus).toBe("invalid_key");
    expect(restored.delete()).toMatchObject({
      proactiveStatus: "unconfigured",
      configVersion: 3,
    });
    expect(JSON.parse(await readFile(config.path, "utf8"))).not.toHaveProperty("apiKey");
  });

  it("不允许未验证 Key 覆盖有效 Key", async () => {
    const config = await store();
    config.load();
    config.saveVerified("sk-old");
    expect(() => config.saveUnverified("sk-new")).toThrow("不能保存未验证");
    expect(config.snapshot().apiKey).toBe("sk-old");
  });

  it("环境变量只作为首次迁移候选，不会自动写入", async () => {
    const config = await store();
    config.load();
    expect(config.importEnvironment({ DEEPSEEK_API_KEY: " sk-env " })).toBe("sk-env");
    expect(config.snapshot().proactiveStatus).toBe("unconfigured");
    config.saveVerified("sk-saved");
    expect(config.importEnvironment({ DEEPSEEK_API_KEY: "sk-other" })).toBeUndefined();
  });

  it("损坏配置进入 config_error，重建前保留备份", async () => {
    const config = await store();
    await writeFile(config.path, "{bad json", { mode: 0o600 });
    expect(config.load().proactiveStatus).toBe("config_error");
    const rebuilt = config.rebuild();
    expect(rebuilt.snapshot.proactiveStatus).toBe("unconfigured");
    expect(rebuilt.backupPath).toBeDefined();
    expect(await readFile(rebuilt.backupPath!, "utf8")).toBe("{bad json");
    if (process.platform !== "win32") {
      expect((await stat(rebuilt.backupPath!)).mode & 0o777).toBe(0o600);
    }
  });
});
