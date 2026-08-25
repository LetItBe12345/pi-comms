import { describe, expect, it, vi } from "vitest";
import type { HistoryMessage, ProactiveDeliverPayload } from "../src/protocol.js";
import { ProactiveCoordinator } from "../src/broker/proactive-coordinator.js";
import { FakeProactiveRouter } from "../src/broker/proactive-provider.js";

function message(groupSeq: number, text: string, senderType: "user" | "agent" = "user"):
  HistoryMessage {
  return {
    messageId: `m-${groupSeq}`,
    groupId: "g",
    groupSeq,
    senderId: `${senderType}:a`,
    senderName: senderType === "user" ? "Alice" : "Agent-A",
    senderType,
    text,
    mentionIds: [],
    timestamp: groupSeq,
    status: "sent",
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待 Proactive 事件超时");
}

describe("Proactive Coordinator", () => {
  it("合并 batch、投递、发布并启动 cooldown", async () => {
    const history = [message(1, "请检查数据库"), message(2, "重点看迁移")];
    const deliveries: ProactiveDeliverPayload[] = [];
    const published: string[] = [];
    const provider = new FakeProactiveRouter(() => "agent:a");
    const coordinator = new ProactiveCoordinator({
      provider,
      credentials: () => ({ proactiveStatus: "ready", configVersion: 1, apiKey: "key" }),
      groupName: () => "开发组",
      candidates: () => [{
        agentId: "agent:a", clientId: "client-a", name: "Agent-A", description: "数据库",
      }],
      messages: (_groupId, afterSeq = 0, limit = 20) =>
        history.filter((item) => item.groupSeq > afterSeq).slice(-limit),
      latestSeq: () => history.at(-1)?.groupSeq ?? 0,
      deliver: (_clientId, payload) => (deliveries.push(payload), true),
      publish: (_pending, text) => {
        published.push(text);
      },
      onInvalidKey: vi.fn(),
      debounceMs: 5,
      maxWaitMs: 10,
      groupIntervalMs: 0,
      cooldownMs: 100,
      deliveryTtlMs: 100,
    });
    coordinator.trigger("g", 1);
    coordinator.trigger("g", 2);
    await waitFor(() => deliveries.length === 1);
    expect(deliveries[0]).toMatchObject({ triggerFromSeq: 1, triggerToSeq: 2, observedToSeq: 2 });
    await expect(coordinator.result({
      proactiveId: deliveries[0]!.proactiveId,
      action: "answer",
      text: "迁移需要事务。",
    })).resolves.toBe(true);
    expect(published).toEqual(["迁移需要事务。​".replace("\u200b", "")]);
    expect(coordinator.eligibleCandidates("g")).toEqual([]);
    coordinator.clear();
  });

  it("exact duplicate 不调用 Freshness，新增消息时 Freshness fail closed", async () => {
    const history = [message(1, "问题")];
    let delivery: ProactiveDeliverPayload | undefined;
    const freshness = vi.fn(() => false);
    const provider = new FakeProactiveRouter(() => "agent:a", freshness);
    const publish = vi.fn();
    const coordinator = new ProactiveCoordinator({
      provider,
      credentials: () => ({ proactiveStatus: "ready", configVersion: 1, apiKey: "key" }),
      groupName: () => "开发组",
      candidates: () => [{
        agentId: "agent:a", clientId: "client-a", name: "Agent-A", description: "后端",
      }],
      messages: (_groupId, afterSeq = 0, limit = 20) =>
        history.filter((item) => item.groupSeq > afterSeq).slice(-limit),
      latestSeq: () => history.at(-1)?.groupSeq ?? 0,
      deliver: (_clientId, payload) => (delivery = payload, true),
      publish,
      onInvalidKey: vi.fn(),
      debounceMs: 1,
      maxWaitMs: 1,
      groupIntervalMs: 0,
      cooldownMs: 0,
      deliveryTtlMs: 100,
    });
    coordinator.trigger("g", 1);
    await waitFor(() => delivery !== undefined);
    history.push(message(2, "已有 答案", "agent"));
    await coordinator.result({
      proactiveId: delivery!.proactiveId,
      action: "answer",
      text: "  已有   答案 ",
    });
    expect(freshness).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    delivery = undefined;
    history.push(message(3, "还有补充吗"));
    coordinator.trigger("g", 3);
    await waitFor(() => delivery !== undefined);
    history.push(message(4, "问题已经解决"));
    await coordinator.result({
      proactiveId: delivery!.proactiveId,
      action: "answer",
      text: "另一个回答",
    });
    expect(freshness).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    coordinator.clear();
  });

  it("并行 Agent 结果按到达顺序处理，后一个 Freshness 能看到先发布的回答", async () => {
    const history = [message(1, "问题一")];
    const deliveries: ProactiveDeliverPayload[] = [];
    let routeIndex = 0;
    const freshnessInputs: string[][] = [];
    const provider = new FakeProactiveRouter(
      () => routeIndex++ === 0 ? "agent:a" : "agent:b",
      (input) => {
        freshnessInputs.push(input.newMessages.map((item) => item.text));
        return true;
      },
    );
    const coordinator = new ProactiveCoordinator({
      provider,
      credentials: () => ({ proactiveStatus: "ready", configVersion: 1, apiKey: "key" }),
      groupName: () => "开发组",
      candidates: () => [
        { agentId: "agent:a", clientId: "client-a", name: "A", description: "A" },
        { agentId: "agent:b", clientId: "client-b", name: "B", description: "B" },
      ],
      messages: (_groupId, afterSeq = 0, limit = 20) =>
        history.filter((item) => item.groupSeq > afterSeq).slice(-limit),
      latestSeq: () => history.at(-1)?.groupSeq ?? 0,
      deliver: (_clientId, payload) => (deliveries.push(payload), true),
      publish: (pending, text) => {
        history.push({
          ...message((history.at(-1)?.groupSeq ?? 0) + 1, text, "agent"),
          senderId: pending.target.agentId,
          senderName: pending.target.name,
        });
      },
      onInvalidKey: vi.fn(),
      debounceMs: 1,
      maxWaitMs: 1,
      groupIntervalMs: 0,
      cooldownMs: 0,
      deliveryTtlMs: 200,
    });
    coordinator.trigger("g", 1);
    await waitFor(() => deliveries.length === 1);
    history.push(message(2, "问题二"));
    coordinator.trigger("g", 2);
    await waitFor(() => deliveries.length === 2);
    const first = coordinator.result({
      proactiveId: deliveries[0]!.proactiveId,
      action: "answer",
      text: "A 的回答",
    });
    const second = coordinator.result({
      proactiveId: deliveries[1]!.proactiveId,
      action: "answer",
      text: "B 的回答",
    });
    await Promise.all([first, second]);
    expect(history.slice(-2).map((item) => item.text)).toEqual(["A 的回答", "B 的回答"]);
    expect(freshnessInputs.at(-1)).toContain("A 的回答");
    coordinator.clear();
  });
});
