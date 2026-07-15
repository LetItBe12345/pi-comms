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
import {
  createCommsExtension,
  formatAgentRequest,
} from "../src/extension/index.js";

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
  ) {
    return await this.handlers.get(event)?.(payload, ctx);
  }
}

function createFakeContext(sessionId: string, branch: unknown[] = []): {
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
      getBranch: () => branch,
      getEntries: () => branch,
    },
    isIdle: () => idle,
    abort: () => {
      abortCount += 1;
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    notices,
    statuses,
    setIdle(value: boolean) {
      idle = value;
    },
    aborted: () => abortCount,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Pi Extension 群组接入", () => {
  let directory: string;
  let socketPath: string;
  let dbPath: string;
  let broker: BrokerServer | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-extension-"));
    socketPath = join(directory, "broker.sock");
    dbPath = join(directory, "comms.db");
  });

  afterEach(async () => {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function setup(sessionId: string, branch: unknown[] = []) {
    const pi = new FakePi();
    const context = createFakeContext(sessionId, branch);
    createCommsExtension({
      socketPath,
      reconnectIntervalMs: 20,
      resultRetryIntervalMs: 20,
      registerTestCommands: true,
      startBroker: () => {},
    })(pi.api);
    return { pi, ...context };
  }

  async function command(
    extension: ReturnType<typeof setup>,
    name: string,
    args = "",
  ): Promise<void> {
    await extension.pi.commands.get(name)?.(
      args,
      extension.ctx as ExtensionCommandContext,
    );
  }

  async function start(extension: ReturnType<typeof setup>): Promise<void> {
    await extension.pi.emit("session_start", extension.ctx);
  }

  async function createGroup(
    extension: ReturnType<typeof setup>,
    args = "开发组 Alice Alice-Pi",
  ): Promise<string> {
    await command(extension, "comms-create", args);
    await waitFor(
      () => extension.notices.some((notice) => notice.message.includes("Group ID:")),
      "未创建群组",
    );
    const notice = extension.notices.find((item) => item.message.includes("Group ID:"));
    const groupId = notice?.message.match(/Group ID: ([\w-]+)/)?.[1];
    if (groupId === undefined) throw new Error("未找到 groupId");
    return groupId;
  }

  async function joinGroup(
    extension: ReturnType<typeof setup>,
    groupId: string,
    userName = "Bob",
    agentName = "Bob-Pi",
  ): Promise<void> {
    await command(
      extension,
      "comms-join",
      `${groupId} ${userName} ${agentName}`,
    );
    await waitFor(
      () => extension.notices.some((notice) => notice.message.includes("已加入群组")),
      "未加入群组",
    );
  }

  it("通过临时命令创建、加入、查看成员并公开聊天", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    await Promise.all([start(a), start(b)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);
    await command(a, "comms-members");
    expect(a.notices.at(-1)?.message).toContain("Alice-Pi (Agent)");
    expect(a.notices.at(-1)?.message).toContain("Bob-Pi (Agent)");

    await command(a, "comms-test", "公开消息");
    await waitFor(
      () => [a, b].every((item) => item.notices.some((notice) => notice.message === "[Alice] 公开消息")),
      "群消息未公开",
    );
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("未入群不能发送，并能查看本机群组列表", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    await Promise.all([start(a), start(b)]);
    await createGroup(a);
    await command(b, "comms-members");
    expect(b.notices.at(-1)?.message).toContain("开发组");
    await command(b, "comms-test", "不能发送");
    expect(b.notices.at(-1)).toEqual({
      message: "请先创建或加入群组",
      type: "error",
    });
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("@Agent 只注入目标，并使用确定的群聊上下文格式", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    const c = setup("session-c");
    await Promise.all([start(a), start(b), start(c)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);
    await joinGroup(c, groupId, "Carol", "Carol-Pi");

    await command(a, "comms-test", "@Bob-Pi 只回复 OK");
    await waitFor(() => b.pi.sentUserMessages.length === 1, "目标未收到注入");
    expect(a.pi.sentUserMessages).toEqual([]);
    expect(c.pi.sentUserMessages).toEqual([]);
    expect(b.pi.sentUserMessages[0]).toBe(
      [
        "[Pi Comms 群聊请求]",
        "你是：Bob-Pi（Agent）",
        "所属用户：Bob",
        "来自：Alice（用户）",
        "群组：开发组",
        "在线：Alice(用户)、Alice-Pi(Agent)、Bob(用户)、Carol(用户)、Carol-Pi(Agent)",
        "",
        "只回复 OK",
        "",
        "你的回答会作为公开消息发送到群组「开发组」，用于回应 Alice。请直接回答。",
      ].join("\n"),
    );

    await b.pi.emit("message_end", b.ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
    });
    await b.pi.emit("agent_settled", b.ctx);
    await waitFor(
      () => [a, b, c].every((item) => item.notices.some((notice) => notice.message === "[Bob-Pi] OK")),
      "Agent 回答未公开",
    );
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
      c.pi.emit("session_shutdown", c.ctx),
    ]);
  });

  it("从 Session 恢复需要批准权限，未批准前不注入", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b", [{
      type: "custom",
      customType: "pi-comms-permission",
      data: { permission: "approval" },
    }]);
    await Promise.all([start(a), start(b)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);

    await command(a, "comms-test", "@Bob-Pi 等待批准");
    await waitFor(
      () =>
        a.notices.some(
          (notice) => notice.message === "[Alice] @Bob-Pi 等待批准",
        ),
      "待批准消息未公开",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.pi.sentUserMessages).toEqual([]);
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("忙碌 Agent 按 FIFO 处理连续请求", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    await Promise.all([start(a), start(b)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);
    b.setIdle(false);
    for (const text of ["请求一", "请求二", "请求三"]) {
      await command(a, "comms-test", `@Bob-Pi ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.pi.sentUserMessages).toEqual([]);
    b.setIdle(true);
    await b.pi.emit("agent_settled", b.ctx);
    await waitFor(() => b.pi.sentUserMessages.length === 1, "第一项未开始");

    for (const [index, answer] of ["一", "二", "三"].entries()) {
      await b.pi.emit("message_end", b.ctx, {
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      });
      await b.pi.emit("agent_settled", b.ctx);
      if (index < 2) {
        await waitFor(
          () => b.pi.sentUserMessages.length === index + 2,
          "下一项未开始",
        );
      }
    }
    expect(b.pi.sentUserMessages.map((text) => text.match(/请求[一二三]/)?.[0])).toEqual([
      "请求一",
      "请求二",
      "请求三",
    ]);
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("离群时中止当前远程任务并清空队列", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    await Promise.all([start(a), start(b)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);
    await command(a, "comms-test", "@Bob-Pi 长任务");
    await waitFor(() => b.pi.sentUserMessages.length === 1, "任务未开始");
    await command(b, "comms-leave");
    await waitFor(
      () => b.notices.some((notice) => notice.message === "已离开群组"),
      "未离群",
    );
    expect(b.aborted()).toBe(1);
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });

  it("Broker 重启后中止旧请求、自动重新入群并加载历史", async () => {
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    const a = setup("session-a");
    const b = setup("session-b");
    await Promise.all([start(a), start(b)]);
    const groupId = await createGroup(a);
    await joinGroup(b, groupId);
    await command(a, "comms-test", "@Bob-Pi 旧请求");
    await waitFor(() => b.pi.sentUserMessages.length === 1, "旧请求未开始");

    await broker.close();
    broker = createBrokerServer({ socketPath, dbPath });
    await broker.start();
    await waitFor(
      () =>
        a.notices.some((notice) => notice.message.includes("Broker 已重启")) &&
        b.notices.some((notice) => notice.message.includes("Broker 已重启")),
      "重启后未恢复连接",
    );
    expect(b.aborted()).toBe(1);
    await waitFor(
      () =>
        a.notices.filter((notice) => notice.message.includes("已加入群组"))
          .length >= 2 &&
        b.notices.filter((notice) => notice.message.includes("已加入群组"))
          .length >= 2,
      "重启后未自动重新入群",
    );
    expect(a.notices.some((notice) => notice.message.includes("已加载 1 条历史消息"))).toBe(true);
    await command(a, "comms-test", "恢复后消息");
    await waitFor(
      () =>
        [a, b].every((item) =>
          item.notices.some((notice) => notice.message === "[Alice] 恢复后消息"),
        ),
      "恢复后无法发送",
    );
    await Promise.all([
      a.pi.emit("session_shutdown", a.ctx),
      b.pi.emit("session_shutdown", b.ctx),
    ]);
  });
});

describe("Agent 注入格式", () => {
  it("第 2 轮起标明自动对话轮数", () => {
    const text = formatAgentRequest({
      requestId: "r",
      groupId: "g",
      groupName: "开发组",
      senderId: "agent:a",
      senderName: "Alice-Pi",
      senderType: "agent",
      senderOwnerUserName: "Alice",
      targetAgentId: "agent:b",
      targetAgentName: "Bob-Pi",
      ownerUserName: "Bob",
      onlineMembers: [],
      text: "继续",
      chainId: "c",
      round: 2,
    });
    expect(text).toContain("这是第 2 轮自动对话。");
    expect(text).toContain("来自：Alice-Pi（Agent）");
    expect(text).toContain("Alice-Pi 所属用户：Alice");
    expect(text).toContain("在线：无其他在线成员");
    expect(text).not.toContain("目标：");
  });
});
