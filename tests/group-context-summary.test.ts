import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerDatabase, historyMessage } from "../src/broker/database.js";
import { GroupContextSummary } from "../src/broker/group-context-summary.js";
import {
  FakeProactiveRouter,
  ProactiveProviderError,
  SUMMARY_PROMPT_VERSION,
} from "../src/broker/proactive-provider.js";
import { ProactiveCallScheduler } from "../src/broker/proactive-scheduler.js";

describe("群聊滚动摘要", () => {
  let directory: string;
  let path: string;
  let database: BrokerDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-summary-"));
    path = join(directory, "comms.db");
    database = new BrokerDatabase(path, "00000000-0000-4000-8000-000000000001");
    database.insertGroup({ groupId: "g", groupName: "开发组" });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("用旧摘要和落出 12 条窗口的公开消息连续滚动，并在重启后恢复", async () => {
    insertMessages(database, 1, 15);
    const inputs: number[][] = [];
    const provider = new FakeProactiveRouter(undefined, undefined, (input) => {
      inputs.push(input.messages.map((message) => message.groupSeq));
      return `覆盖到 #${input.messages.at(-1)!.groupSeq}`;
    });
    const context = createContext(provider);

    const first = await context.prepare("g", "key", 15);
    expect(inputs).toEqual([[1, 2, 3]]);
    expect(first).toMatchObject({
      omitted: true,
      summaryIncomplete: false,
      summary: { fromSeq: 1, throughSeq: 3, promptVersion: SUMMARY_PROMPT_VERSION },
    });
    expect(first.messages.map((message) => message.groupSeq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 4),
    );

    insertMessages(database, 16, 18);
    const second = await context.prepare("g", "key", 18);
    expect(inputs).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(second.summary).toMatchObject({ fromSeq: 1, throughSeq: 6 });
    expect(second.messages[0]?.groupSeq).toBe(7);

    database.close();
    database = new BrokerDatabase(path, "00000000-0000-4000-8000-000000000001");
    const restored = createContext(provider).snapshot("g", 18);
    expect(restored.summary).toMatchObject({ fromSeq: 1, throughSeq: 6 });
    expect(restored.summaryIncomplete).toBe(false);
  });

  it("摘要失败时保留最近 12 条并标记不完整，且并发调用只生成一次", async () => {
    insertMessages(database, 1, 13);
    let release!: () => void;
    const summarize = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      throw new ProactiveProviderError("invalid_response", "bad summary");
    });
    const provider = new FakeProactiveRouter();
    provider.summarize = summarize;
    const context = createContext(provider);
    const first = context.prepare("g", "key", 13);
    const second = context.prepare("g", "key", 13);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ omitted: true, summaryIncomplete: true });
    expect(results[0].messages).toHaveLength(12);
    expect(results[0].summary).toBeUndefined();
    expect(results[1]).toEqual(results[0]);
  });

  it("不把 system 消息送进摘要，群组删除时删除摘要", async () => {
    insertMessages(database, 1, 13);
    database.insertMessage(historyMessage("system-14", 14, {
      groupId: "g",
      groupSeq: 14,
      senderId: "system",
      senderName: "系统",
      senderType: "user",
      text: "成员变化和本地文件内容",
      mentionIds: [],
      status: "sent",
    }, "sent"));
    const summaryInputs: string[] = [];
    const provider = new FakeProactiveRouter(undefined, undefined, (input) => {
      summaryInputs.push(JSON.stringify(input));
      return "公开摘要";
    });
    await createContext(provider).prepare("g", "key", 14);
    expect(summaryInputs.join("\n")).not.toContain("成员变化和本地文件内容");
    expect(database.groupSummary("g")).toBeDefined();
    database.deleteGroup("g");
    expect(database.groupSummary("g")).toBeUndefined();
  });

  it("检测无效覆盖范围并从第一条公开消息重建", async () => {
    insertMessages(database, 1, 15);
    database.saveGroupSummary({
      groupId: "g",
      summary: "缺少第一条的旧摘要",
      fromSeq: 2,
      throughSeq: 3,
      promptVersion: SUMMARY_PROMPT_VERSION,
      updatedAt: 1,
    });
    const inputs: number[][] = [];
    const provider = new FakeProactiveRouter(undefined, undefined, (input) => {
      inputs.push(input.messages.map((message) => message.groupSeq));
      return "重建摘要";
    });
    const context = createContext(provider);
    expect(context.snapshot("g", 15).summaryIncomplete).toBe(true);
    const rebuilt = await context.prepare("g", "key", 15);
    expect(inputs).toEqual([[1, 2, 3]]);
    expect(rebuilt.summary).toMatchObject({ fromSeq: 1, throughSeq: 3 });
    expect(rebuilt.summaryIncomplete).toBe(false);
  });

  function createContext(provider: FakeProactiveRouter): GroupContextSummary {
    return new GroupContextSummary({
      database: () => database,
      provider,
      scheduler: new ProactiveCallScheduler(),
    });
  }
});

function insertMessages(database: BrokerDatabase, from: number, through: number): void {
  for (let seq = from; seq <= through; seq += 1) {
    database.insertMessage(historyMessage(`m-${seq}`, seq, {
      groupId: "g",
      groupSeq: seq,
      senderId: seq % 2 === 0 ? "agent:a" : "user:a",
      senderName: seq % 2 === 0 ? "Agent-A" : "Alice",
      senderType: seq % 2 === 0 ? "agent" : "user",
      text: `公开消息 ${seq}`,
      mentionIds: [],
      status: "sent",
    }, "sent"));
  }
}
