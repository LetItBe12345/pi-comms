import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProactiveStatus } from "../protocol.js";

export const DEFAULT_PROACTIVE_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "comms",
  "config.json",
);

export interface ProactiveConfig {
  version: 1;
  configVersion: number;
  apiKey?: string;
  keyStatus: "verified" | "unverified" | "invalid" | "missing";
  updatedAt: number;
}

export interface ProactiveConfigSnapshot {
  proactiveStatus: ProactiveStatus;
  configVersion: number;
  apiKey?: string;
  maskedApiKey?: string;
  error?: string;
}

const EMPTY_CONFIG: ProactiveConfig = {
  version: 1,
  configVersion: 0,
  keyStatus: "missing",
  updatedAt: 0,
};

export class ProactiveConfigStore {
  #config: ProactiveConfig = { ...EMPTY_CONFIG };
  #error: string | undefined;

  constructor(readonly path = DEFAULT_PROACTIVE_CONFIG_PATH) {}

  load(): ProactiveConfigSnapshot {
    this.#error = undefined;
    if (!existsSync(this.path)) {
      this.#config = { ...EMPTY_CONFIG };
      return this.snapshot();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      this.#config = parseConfig(parsed);
      chmodPrivate(this.path);
    } catch (error) {
      this.#config = { ...EMPTY_CONFIG };
      this.#error = error instanceof Error ? error.message : String(error);
    }
    return this.snapshot();
  }

  snapshot(): ProactiveConfigSnapshot {
    if (this.#error !== undefined) {
      return {
        proactiveStatus: "config_error",
        configVersion: this.#config.configVersion,
        error: this.#error,
      };
    }
    return {
      proactiveStatus: statusFor(this.#config.keyStatus),
      configVersion: this.#config.configVersion,
      ...(this.#config.apiKey === undefined ? {} : {
        apiKey: this.#config.apiKey,
        maskedApiKey: maskApiKey(this.#config.apiKey),
      }),
    };
  }

  saveVerified(apiKey: string): ProactiveConfigSnapshot {
    return this.#save(apiKey, "verified");
  }

  saveUnverified(apiKey: string): ProactiveConfigSnapshot {
    if (this.#config.keyStatus === "verified") {
      throw new Error("已有有效 Key 时不能保存未验证的新 Key");
    }
    return this.#save(apiKey, "unverified");
  }

  markInvalid(): ProactiveConfigSnapshot {
    if (this.#config.apiKey === undefined) return this.snapshot();
    return this.#save(this.#config.apiKey, "invalid");
  }

  delete(): ProactiveConfigSnapshot {
    const next: ProactiveConfig = {
      version: 1,
      configVersion: this.#config.configVersion + 1,
      keyStatus: "missing",
      updatedAt: Date.now(),
    };
    this.#write(next);
    return this.snapshot();
  }

  rebuild(): { snapshot: ProactiveConfigSnapshot; backupPath?: string } {
    let backupPath: string | undefined;
    if (existsSync(this.path)) {
      backupPath = `${this.path}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(this.path, backupPath);
      chmodPrivate(backupPath);
    }
    this.#error = undefined;
    this.#config = { ...EMPTY_CONFIG };
    this.#write(this.#config);
    return { snapshot: this.snapshot(), ...(backupPath === undefined ? {} : { backupPath }) };
  }

  importEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (this.#error !== undefined || this.#config.apiKey !== undefined) return undefined;
    const value = env.DEEPSEEK_API_KEY?.trim();
    return value ? value : undefined;
  }

  #save(
    apiKey: string,
    keyStatus: ProactiveConfig["keyStatus"],
  ): ProactiveConfigSnapshot {
    const normalized = apiKey.trim();
    if (!normalized) throw new Error("DeepSeek API Key 不能为空");
    const next: ProactiveConfig = {
      version: 1,
      configVersion: this.#config.configVersion + 1,
      apiKey: normalized,
      keyStatus,
      updatedAt: Date.now(),
    };
    this.#write(next);
    return this.snapshot();
  }

  #write(config: ProactiveConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodPrivate(tempPath);
    renameSync(tempPath, this.path);
    chmodPrivate(this.path);
    this.#config = config;
    this.#error = undefined;
  }
}

export function normalizeAgentDescription(value: string): string {
  return [...value.trim().replace(/\s+/gu, " ")].slice(0, 240).join("");
}

export function maskApiKey(apiKey: string): string {
  const suffix = apiKey.slice(-4);
  return `****${suffix}`;
}

function parseConfig(value: unknown): ProactiveConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Broker 配置必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Number.isInteger(record.configVersion) ||
    (record.configVersion as number) < 0 ||
    !Number.isFinite(record.updatedAt) ||
    !["verified", "unverified", "invalid", "missing"].includes(String(record.keyStatus))
  ) {
    throw new Error("Broker 配置字段无效");
  }
  const keyStatus = record.keyStatus as ProactiveConfig["keyStatus"];
  const apiKey = typeof record.apiKey === "string" && record.apiKey.trim()
    ? record.apiKey.trim()
    : undefined;
  if (keyStatus !== "missing" && apiKey === undefined) {
    throw new Error("Broker 配置缺少 DeepSeek API Key");
  }
  return {
    version: 1,
    configVersion: record.configVersion as number,
    keyStatus,
    updatedAt: record.updatedAt as number,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

function statusFor(keyStatus: ProactiveConfig["keyStatus"]): ProactiveStatus {
  if (keyStatus === "verified") return "ready";
  if (keyStatus === "unverified") return "unverified";
  if (keyStatus === "invalid") return "invalid_key";
  return "unconfigured";
}

function chmodPrivate(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
