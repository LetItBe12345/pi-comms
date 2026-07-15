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

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any> | any;
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
  readonly sentUserMessages: string[] = [];
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
    sendUserMessage: (content: string) => {
      this.sentUserMessages.push(content);
    },
  } as unknown as ExtensionAPI;

  async emit(
    event: string,
    ctx: ExtensionContext,
    payload: unknown = { type: event },
  ) {
    return await this.handlers.get(event)?.(payload, ctx);
  }
}

function createFakeContext(sessionId: string): {
  ctx: ExtensionContext;
  notices: Notice[];
  statuses: Array<string | undefined>;
  setIdle(idle: boolean): void;
  aborted(): number;
} {
  const notices: Notice[] = [];
  const statuses: Array<string | undefined> = [];
  let idle = true;
  let abortCount = 0;
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
    isIdle: () => idle,
    abort: () => {
      abortCount += 1;
    },
  } as ExtensionContext;

  return {
    ctx,
    notices,
    statuses,
    setIdle(value: boolean) {
      idle = value;
    },
    aborted() {
      return abortCount;
    },
  };
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
    createCommsExtension({
      socketPath,
      reconnectIntervalMs: 20,
      resultRetryIntervalMs: 20,
    })(pi.api);
    return { pi, ...context };
  }

  function clientIdOf(extension: ReturnType<typeof setupExtension>): string {
    const connectionNotice = [...extension.notices]
      .reverse()
      .find((notice) => notice.message.includes("Client:"));
    const clientId = connectionNotice?.message.match(/Client: ([\w-]+)/)?.[1];
    if (clientId === undefined) {
      throw new Error("未找到 clientId");
    }
    return clientId;
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
      message: "Broker 未连接，正在等待 npm run broker 启动",
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

  it("Broker 重启后自动重连", async () => {
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
    await waitFor(
      () => extension.statuses.at(-1) === "Broker 已连接",
      "Broker 重启后没有自动重连",
    );
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

  it("Broker 实例变化时终止旧活动请求并接受新请求", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const a = setupExtension("session-a");
    const b = setupExtension("session-b");
    await Promise.all([
      a.pi.emit("session_start", a.ctx),
      b.pi.emit("session_start", b.ctx),
    ]);
    await a.pi.command?.(
      `@${clientIdOf(b)} 旧请求`,
      a.ctx as ExtensionCommandContext,
    );
    await waitFor(
      () => b.pi.sentUserMessages.length === 1,
      "旧请求没有开始",
    );

    await broker.close();
    broker = createBrokerServer({ socketPath });
    await broker.start();
    await waitFor(
      () =>
        a.statuses.at(-1) === "Broker 已连接" &&
        b.statuses.at(-1) === "Broker 已连接",
      "Broker 重启后两个 Extension 没有恢复",
    );
    expect(b.aborted()).toBe(1);

    await a.pi.command?.(
      `@${clientIdOf(b)} 新请求`,
      a.ctx as ExtensionCommandContext,
    );
    await waitFor(
      () => b.pi.sentUserMessages.length === 2,
      "Broker 重启后没有接收新请求",
    );
    expect(b.pi.sentUserMessages[1]).toContain("消息：新请求");

    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("公开 @ 消息，但只向目标 Pi 注入请求并回传一次回答", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const a = setupExtension("session-a");
    const b = setupExtension("session-b");
    const c = setupExtension("session-c");
    await Promise.all([
      a.pi.emit("session_start", a.ctx),
      b.pi.emit("session_start", b.ctx),
      c.pi.emit("session_start", c.ctx),
    ]);
    const bClientId = clientIdOf(b);
    const publicText = `@${bClientId} 只回复 STAGE3_OK`;

    await a.pi.command?.(publicText, a.ctx as ExtensionCommandContext);
    await waitFor(
      () => b.pi.sentUserMessages.length === 1,
      "B 没有收到 Agent 注入",
    );
    await waitFor(
      () =>
        [a, b, c].every((extension) =>
          extension.notices.some((notice) => notice.message.includes(publicText)),
        ),
      "公开 @ 消息没有显示给所有 Session",
    );

    expect(a.pi.sentUserMessages).toEqual([]);
    expect(c.pi.sentUserMessages).toEqual([]);
    expect(b.pi.sentUserMessages[0]).toContain("消息：只回复 STAGE3_OK");
    expect(b.pi.sentUserMessages[0]).toContain("群组：default");

    const blocked = await b.pi.emit("input", b.ctx, {
      text: "私人内容",
      source: "interactive",
    });
    expect(blocked).toEqual({ action: "handled" });

    await b.pi.emit("message_end", b.ctx, {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "不应公开" },
          { type: "text", text: "STAGE3_OK" },
        ],
      },
    });
    await b.pi.emit("agent_settled", b.ctx);
    await b.pi.emit("agent_settled", b.ctx);

    await waitFor(
      () =>
        [a, b, c].every((extension) =>
          extension.notices.some((notice) =>
            notice.message.includes("] STAGE3_OK"),
          ),
        ),
      "Agent 回答没有公开返回",
    );
    for (const extension of [a, b, c]) {
      expect(
        extension.notices.filter((notice) =>
          notice.message.includes("] STAGE3_OK"),
        ),
      ).toHaveLength(1);
    }

    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
      c.pi.emit("session_shutdown", c.ctx),
    ]);
  });

  it("普通消息不注入 Agent，忙碌目标把远程请求加入队列", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const a = setupExtension("session-a");
    const b = setupExtension("session-b");
    await Promise.all([
      a.pi.emit("session_start", a.ctx),
      b.pi.emit("session_start", b.ctx),
    ]);

    await a.pi.command?.("普通消息", a.ctx as ExtensionCommandContext);
    await waitFor(
      () => b.notices.some((notice) => notice.message.includes("普通消息")),
      "B 没有看到普通消息",
    );
    expect(b.pi.sentUserMessages).toEqual([]);

    b.setIdle(false);
    await a.pi.command?.(
      `@${clientIdOf(b)} 忙碌测试`,
      a.ctx as ExtensionCommandContext,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    expect(b.pi.sentUserMessages).toEqual([]);
    expect(
      a.notices.some((notice) => notice.message.includes("目标 Agent 正忙")),
    ).toBe(false);

    b.setIdle(true);
    await b.pi.emit("agent_settled", b.ctx);
    await waitFor(
      () => b.pi.sentUserMessages.length === 1,
      "Agent 空闲后没有处理排队请求",
    );

    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("连续请求按 FIFO 顺序逐个注入和回传", async () => {
    broker = createBrokerServer({ socketPath });
    await broker.start();
    const a = setupExtension("session-a");
    const b = setupExtension("session-b");
    await Promise.all([
      a.pi.emit("session_start", a.ctx),
      b.pi.emit("session_start", b.ctx),
    ]);
    const bClientId = clientIdOf(b);

    await a.pi.command?.(
      `@${bClientId} 请求一`,
      a.ctx as ExtensionCommandContext,
    );
    await a.pi.command?.(
      `@${bClientId} 请求二`,
      a.ctx as ExtensionCommandContext,
    );
    await a.pi.command?.(
      `@${bClientId} 请求三`,
      a.ctx as ExtensionCommandContext,
    );
    await waitFor(
      () => b.pi.sentUserMessages.length === 1,
      "第一条请求没有注入",
    );
    expect(b.pi.sentUserMessages[0]).toContain("消息：请求一");

    for (const [index, answer] of ["QUEUE-1", "QUEUE-2", "QUEUE-3"].entries()) {
      await b.pi.emit("message_end", b.ctx, {
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      });
      await b.pi.emit("agent_settled", b.ctx);
      if (index < 2) {
        await waitFor(
          () => b.pi.sentUserMessages.length === index + 2,
          `第 ${index + 2} 条请求没有注入`,
        );
      }
    }

    expect(b.pi.sentUserMessages[1]).toContain("消息：请求二");
    expect(b.pi.sentUserMessages[2]).toContain("消息：请求三");
    await waitFor(
      () =>
        ["QUEUE-1", "QUEUE-2", "QUEUE-3"].every((answer) =>
          a.notices.some((notice) => notice.message.includes(answer)),
        ),
      "队列回答没有全部公开",
    );
    for (const answer of ["QUEUE-1", "QUEUE-2", "QUEUE-3"]) {
      expect(
        a.notices.filter((notice) => notice.message.includes(answer)),
      ).toHaveLength(1);
    }

    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });
});
