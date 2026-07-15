import { describe, expect, it } from "vitest";
import type { AgentRequestPayload } from "../src/protocol.js";
import { RemoteQueue } from "../src/extension/remote-queue.js";

function request(requestId: string): AgentRequestPayload {
  return {
    requestId,
    groupId: "default",
    senderId: "sender",
    senderName: "Sender",
    targetAgentId: "target",
    text: requestId,
    chainId: requestId,
    round: 1,
  };
}

describe("RemoteQueue", () => {
  it("按 FIFO 顺序且同一时间只有一个活动请求", () => {
    const queue = new RemoteQueue();
    queue.enqueue(request("one"));
    queue.enqueue(request("two"));

    expect(queue.startNext()?.requestId).toBe("one");
    expect(queue.startNext()).toBeUndefined();
    queue.completeActive({ requestId: "one", ok: true, text: "ONE" });
    expect(queue.startNext()?.requestId).toBe("two");
  });

  it("Session 生命周期内忽略重复请求", () => {
    const queue = new RemoteQueue();

    expect(queue.enqueue(request("same"))).toBe(true);
    expect(queue.enqueue(request("same"))).toBe(false);
    queue.startNext();
    queue.completeActive({ requestId: "same", ok: true, text: "DONE" });
    expect(queue.enqueue(request("same"))).toBe(false);
  });

  it("结果保留到确认并可整体清理", () => {
    const queue = new RemoteQueue();
    queue.enqueue(request("result"));
    queue.startNext();
    queue.completeActive({ requestId: "result", ok: true, text: "DONE" });

    expect(queue.pendingResults()).toEqual([
      { requestId: "result", ok: true, text: "DONE" },
    ]);
    queue.acknowledgeResult("result");
    expect(queue.pendingResults()).toEqual([]);

    queue.enqueue(request("next"));
    queue.startNext();
    queue.clear();
    expect(queue.activeRequest).toBeUndefined();
    expect(queue.pendingResults()).toEqual([]);
  });
});
