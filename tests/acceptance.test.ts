import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
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

class AcceptancePi {
  readonly handlers = new Map<string, EventHandler>();
  readonly commands = new Map<string, CommandHandler>();
  readonly sentUserMessages: string[] = [];

  readonly api = {
    on: (event: string, handler: EventHandler) => {
      this.handlers.set(event, handler);
    },
    registerCommand: (
      name: string,
      options: { handler: CommandHandler },
    ) => {
      this.commands.set(name, options.handler);
    },
    sendUserMessage: (content: string) => {
      this.sentUserMessages.push(content);
    },
  } as unknown as ExtensionAPI;

  async emit(
    event: string,
    ctx: ExtensionContext,
    payload: unknown = { type: event },
  ): Promise<unknown> {
    return await this.handlers.get(event)?.(payload, ctx);
  }
}

function createSession(sessionId: string) {
  const pi = new AcceptancePi();
  const notices: Notice[] = [];
  let idle = true;
  const ui = {
    notify: (message: string, type?: Notice["type"]) => {
      notices.push({ message, type });
    },
    setStatus: () => {},
  } as unknown as ExtensionUIContext;
  const ctx = {
    ui,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getEntries: () => [],
    },
    isIdle: () => idle,
    abort: () => {},
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    notices,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("MVP 双 Session 自动验收", () => {
  let directory: string;
  let socketPath: string;
  let dbPath: string;
  let broker: BrokerServer | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-acceptance-"));
    socketPath = join(directory, "broker.sock");
    dbPath = join(directory, "comms.db");
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
  });

  afterEach(async () => {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function setup(sessionId: string) {
    const session = createSession(sessionId);
    createCommsExtension({
      socketPath,
      reconnectIntervalMs: 20,
      resultRetryIntervalMs: 20,
      registerTestCommands: true,
      startBroker: () => {},
    })(session.pi.api);
    return session;
  }

  async function command(
    session: ReturnType<typeof setup>,
    name: string,
    args = "",
  ): Promise<void> {
    await session.pi.commands.get(name)?.(
      args,
      session.ctx as ExtensionCommandContext,
    );
  }

  async function answer(
    session: ReturnType<typeof setup>,
    text: string,
  ): Promise<void> {
    await session.pi.emit("message_end", session.ctx, {
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    await session.pi.emit("agent_settled", session.ctx);
  }

  it("完成广播、定向注入、FIFO、唯一回答、私人隔离和离线失败", async () => {
    const alice = setup("session-alice");
    const bob = setup("session-bob");
    await Promise.all([
      alice.pi.emit("session_start", alice.ctx),
      bob.pi.emit("session_start", bob.ctx),
    ]);

    await command(alice, "comms-create", "验收组 Alice Alice-Pi");
    await waitFor(
      () => alice.notices.some((notice) => notice.message.includes("Group ID:")),
      "Alice 未创建群组",
    );
    const groupId = alice.notices
      .find((notice) => notice.message.includes("Group ID:"))
      ?.message.match(/Group ID: ([\w-]+)/)?.[1];
    expect(groupId).toBeDefined();
    await command(bob, "comms-join", `${groupId} Bob Bob-Pi`);
    await waitFor(
      () => bob.notices.some((notice) => notice.message.includes("已加入群组")),
      "Bob 未加入群组",
    );

    await command(alice, "comms-test", "公开广播");
    await waitFor(
      () => [alice, bob].every((session) =>
        session.notices.some((notice) => notice.message === "[Alice] 公开广播"),
      ),
      "普通消息未公开广播",
    );

    await command(alice, "comms-test", "@Bob-Pi 检查 package.json");
    await waitFor(() => bob.pi.sentUserMessages.length === 1, "请求未注入 Bob");
    expect(alice.pi.sentUserMessages).toEqual([]);
    expect(bob.pi.sentUserMessages[0]).toContain("检查 package.json");
    await answer(bob, "PACKAGE_OK");
    await bob.pi.emit("agent_settled", bob.ctx);
    await waitFor(
      () => [alice, bob].every((session) =>
        session.notices.filter((notice) => notice.message === "[Bob-Pi] PACKAGE_OK")
          .length === 1,
      ),
      "Agent 回答未唯一公开",
    );

    bob.setIdle(false);
    for (const text of ["QUEUE-1", "QUEUE-2", "QUEUE-3"]) {
      await command(alice, "comms-test", `@Bob-Pi 只回复 ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bob.pi.sentUserMessages).toHaveLength(1);
    bob.setIdle(true);
    await bob.pi.emit("agent_settled", bob.ctx);
    await waitFor(() => bob.pi.sentUserMessages.length === 2, "队列首项未启动");
    for (const [index, text] of ["QUEUE-1", "QUEUE-2", "QUEUE-3"].entries()) {
      expect(bob.pi.sentUserMessages[index + 1]).toContain(text);
      await answer(bob, text);
      if (index < 2) {
        await waitFor(
          () => bob.pi.sentUserMessages.length === index + 3,
          "队列下一项未启动",
        );
      }
    }
    await waitFor(
      () => ["QUEUE-1", "QUEUE-2", "QUEUE-3"].every((text) =>
        [alice, bob].every((session) =>
          session.notices.filter((notice) => notice.message === `[Bob-Pi] ${text}`)
            .length === 1,
        ),
      ),
      "FIFO 回答未按顺序唯一公开",
    );

    await answer(bob, "PRIVATE-ONLY-10");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([alice, bob].flatMap((session) => session.notices))
      .not.toContainEqual(expect.objectContaining({ message: "[Bob-Pi] PRIVATE-ONLY-10" }));

    await bob.pi.emit("session_shutdown", bob.ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await command(alice, "comms-test", "@Bob-Pi 离线请求");
    await waitFor(
      () => alice.notices.some((notice) =>
        notice.message.includes("当前群组中找不到目标"),
      ),
      "离线目标未公开失败",
    );
    expect(bob.pi.sentUserMessages).toHaveLength(4);

    await alice.pi.emit("session_shutdown", alice.ctx);
    await broker?.close();
    broker = undefined;

    const database = new Database(dbPath, { readonly: true });
    const packageAnswer = database.prepare(
      `SELECT answer.request_id AS requestId, COUNT(*) AS count
       FROM messages AS answer
       WHERE answer.sender_name = 'Bob-Pi' AND answer.text = 'PACKAGE_OK'`,
    ).get() as { requestId: string; count: number };
    expect(packageAnswer.count).toBe(1);
    expect(packageAnswer.requestId).toMatch(/[\w-]+/);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_requests WHERE request_id = ? AND status = 'completed'",
    ).get(packageAnswer.requestId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE text LIKE '%PRIVATE-ONLY-10%'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});
