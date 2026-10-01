import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { McpRegistration } from "../src/extension/mcp-registration.js";

afterEach(() => vi.useRealTimers());

it("自动注册两个 direct Tool，使用远端 Broker 地址，提前刷新并在离线时注销", () => {
  vi.useFakeTimers();
  const registerMcpServer = vi.fn();
  const unregisterMcpServer = vi.fn();
  const refresh = vi.fn();
  const registration = new McpRegistration({ registerMcpServer, unregisterMcpServer } as unknown as ExtensionAPI, refresh);
  const access = { token: "short-lived", port: 43128, expiresAt: Date.now() + 300_000 };
  registration.update(access, { host: "192.168.1.20", port: 43127 });
  expect(registerMcpServer).toHaveBeenCalledWith("pi-comms", expect.objectContaining({
    url: "http://192.168.1.20:43128/mcp", exposure: "direct",
    toolExposure: { get_group_context: "direct", read_group_messages: "direct" },
    headers: { Authorization: "Bearer short-lived" },
  }));
  registration.update(access, { host: "192.168.1.20", port: 43127 });
  expect(registerMcpServer).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(270_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  registration.update({ ...access, token: "renewed", expiresAt: Date.now() + 300_000 }, { host: "::1", port: 43127 });
  expect(registerMcpServer.mock.lastCall![1].url).toBe("http://[::1]:43128/mcp");
  registration.clear();
  expect(unregisterMcpServer).toHaveBeenCalledWith("pi-comms");
  vi.advanceTimersByTime(300_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});
