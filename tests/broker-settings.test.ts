import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { showBrokerSettings } from "../src/extension/broker-settings.js";
import { createBrokerServer } from "../src/broker/server.js";
import { FakeProactiveRouter, ProactiveProviderError } from "../src/broker/proactive-provider.js";
import { ProactiveConfigStore } from "../src/broker/proactive-config.js";
import { brokerSession, waitUntil } from "./helpers/broker-session.js";

function dialogs(action = "配置或更换 API Key") {
  return {
    select: vi.fn(async () => action),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => " sk-test-only "),
    notify: vi.fn(),
  };
}

it("向导说明模型、保存位置和主动参与入口，确认后才提交 Key", async () => {
  const ui = dialogs();
  const request = vi.fn(async () => ({
    proactiveStatus: "ready" as const, message: "DeepSeek API Key 已验证并保存",
  }));
  await showBrokerSettings({ ui: ui as unknown as ExtensionUIContext, status: "unconfigured", request });
  expect(ui.select.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining("DeepSeek V4.1 Flash")]));
  expect(ui.confirm.mock.calls.flat().join(" ")).toContain("~/.pi/comms/config.json");
  expect(request).toHaveBeenCalledWith("broker.config.update", { apiKey: "sk-test-only" });
  expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Ctrl+P"), "info");
});

it("取消保存不会发送 Key，重新验证不再要求输入", async () => {
  const ui = dialogs();
  ui.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const request = vi.fn(async () => undefined);
  await showBrokerSettings({ ui: ui as unknown as ExtensionUIContext, status: "unconfigured", request });
  expect(request).not.toHaveBeenCalled();
  ui.select.mockResolvedValue("重新验证 API Key");
  await showBrokerSettings({ ui: ui as unknown as ExtensionUIContext, status: "unverified", maskedApiKey: "sk-…only", request });
  expect(request).toHaveBeenCalledWith("broker.config.validate", {});
  expect(ui.input).toHaveBeenCalledTimes(1);
});

it("验证失败不能把仍有效的旧 Key 误报为新配置成功", async () => {
  const ui = dialogs();
  await showBrokerSettings({
    ui: ui as unknown as ExtensionUIContext, status: "ready",
    request: async () => ({ proactiveStatus: "ready", message: "DeepSeek API Key 无效" }),
  });
  expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("已就绪"), "info");
});

it("两个 Session 共享已保存的 Broker Key；空 payload 重新验证并持久化为 verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-comms-settings-"));
  const configPath = join(directory, "config.json");
  const store = new ProactiveConfigStore(configPath);
  store.load();
  store.saveUnverified("sk-test-only");
  const provider = new FakeProactiveRouter();
  const validate = vi.spyOn(provider, "validate");
  const broker = createBrokerServer({
    listen: { host: "127.0.0.1", port: 0 }, dbPath: join(directory, "comms.db"),
    proactiveConfigPath: configPath, proactiveProvider: provider,
  });
  await broker.start();
  const alice = await brokerSession(broker.endpoint, "Alice");
  const bob = await brokerSession(broker.endpoint, "Bob");
  try {
    const requestId = alice.client.send("broker.config.validate", {});
    await waitUntil(() => alice.messages.some(m => m.type === "broker.config.status" && m.payload.requestId === requestId));
    expect(validate).toHaveBeenCalledWith("sk-test-only", expect.any(AbortSignal));
    expect(JSON.parse(await readFile(configPath, "utf8")).keyStatus).toBe("verified");
    await waitUntil(() => bob.messages.some(m => m.type === "broker.config.status" && m.payload.proactiveStatus === "ready"));
    expect(bob.messages.filter(m => m.type === "broker.config.status")).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ apiKey: "sk-test-only" }) }),
    );
    validate.mockRejectedValueOnce(new ProactiveProviderError("invalid_key", "DeepSeek API Key 无效", 401));
    alice.client.send("broker.config.validate", {});
    await waitUntil(() => bob.messages.some(m => m.type === "broker.config.status" && m.payload.proactiveStatus === "invalid_key"));
    expect(JSON.parse(await readFile(configPath, "utf8")).keyStatus).toBe("invalid");
    alice.client.send("broker.config.delete", {});
    await waitUntil(() => bob.messages.some(m => m.type === "broker.config.status" && m.payload.proactiveStatus === "unconfigured"));
    expect(JSON.parse(await readFile(configPath, "utf8")).apiKey).toBeUndefined();
  } finally {
    await alice.client.stop();
    await bob.client.stop();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
