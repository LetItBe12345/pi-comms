import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrokerServer,
  type BrokerServer,
} from "../src/broker/server.js";
import { createCommsExtension } from "../src/extension/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

interface Notice {
  message: string;
  type?: "info" | "warning" | "error";
}

class FakePi {
  readonly handlers = new Map<string, EventHandler>();
  command: CommandHandler | undefined;

  readonly api = {
    on: (event: string, handler: EventHandler) => {
      this.handlers.set(event, handler);
    },
    registerCommand: (
      name: string,
      options: { handler: CommandHandler },
    ) => {
      if (name === "comms-test") {
        this.command = options.handler;
      }
    },
  } as unknown as ExtensionAPI;

  async emit(event: "session_start" | "session_shutdown", ctx: ExtensionContext) {
    await this.handlers.get(event)?.({ type: event }, ctx);
  }
}

function createFakeContext(sessionId: string): {
  ctx: ExtensionContext;
  notices: Notice[];
  statuses: Array<string | undefined>;
} {
  const notices: Notice[] = [];
  const statuses: Array<string | undefined> = [];
  const ui = {
    notify: (message: string, type?: Notice["type"]) => {
      notices.push({ message, type });
    },
    setStatus: (_key: string, text: string | undefined) => {
      statuses.push(text);
    },
  } as ExtensionUIContext;
  const ctx = {
    ui,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as ExtensionContext;

  return { ctx, notices, statuses };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

describe("Pi Extension", () => {
  let directory: string;
  let socketPath: string;
  let broker: BrokerServer | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-extension-"));
    socketPath = join(directory, "broker.sock");
  });

  afterEach(async () => {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function setupExtension(sessionId: string) {
    const pi = new FakePi();
    const context = createFakeContext(sessionId);
    createCommsExtension({ socketPath })(pi.api);
    return { pi, ...context };
  }

  it("两个 Session 连接后都能看到广播消息", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const a = setupExtension("session-a");
    const b = setupExtension("session-b");

    await Promise.all([
      a.pi.emit("session_start", a.ctx),
      b.pi.emit("session_start", b.ctx),
    ]);
    await a.pi.command?.(
      "来自 A 的测试",
      a.ctx as ExtensionCommandContext,
    );

    await Promise.all([
      waitFor(
        () => a.notices.some((notice) => notice.message.includes("来自 A 的测试")),
        "A 没有收到广播",
      ),
      waitFor(
        () => b.notices.some((notice) => notice.message.includes("来自 A 的测试")),
        "B 没有收到广播",
      ),
    ]);

    expect(a.statuses).toContain("Broker 已连接");
    expect(b.statuses).toContain("Broker 已连接");

    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
    expect(a.statuses.at(-1)).toBeUndefined();
    expect(b.statuses.at(-1)).toBeUndefined();
  });

  it("首次连接失败后由命令重新连接", async () => {
    const extension = setupExtension("session-retry");

    await extension.pi.emit("session_start", extension.ctx);
    expect(extension.notices).toContainEqual({
      message:
        "Broker 未连接，请先运行 npm run broker；之后可执行 /comms-test 重试",
      type: "warning",
    });

    broker = createBrokerServer({ socketPath });
    await broker.start();
    await extension.pi.command?.(
      "重连成功",
      extension.ctx as ExtensionCommandContext,
    );

    await waitFor(
      () =>
        extension.notices.some((notice) => notice.message.includes("重连成功")),
      "重连后没有收到广播",
    );
    expect(extension.statuses).toContain("Broker 已连接");

    await extension.pi.emit("session_shutdown", extension.ctx);
  });

  it("Broker 中断后由下一次命令重连", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const extension = setupExtension("session-reconnect");
    await extension.pi.emit("session_start", extension.ctx);

    await broker.close();
    await waitFor(
      () => extension.statuses.at(-1) === "Broker 未连接",
      "断线状态没有更新",
    );

    broker = createBrokerServer({ socketPath });
    await broker.start();
    await extension.pi.command?.(
      "再次连接",
      extension.ctx as ExtensionCommandContext,
    );

    await waitFor(
      () =>
        extension.notices.some((notice) => notice.message.includes("再次连接")),
      "Broker 重启后没有重连",
    );
    await extension.pi.emit("session_shutdown", extension.ctx);
  });
});
