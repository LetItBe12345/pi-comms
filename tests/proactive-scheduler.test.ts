import { describe, expect, it } from "vitest";
import { ProactiveCallScheduler } from "../src/broker/proactive-scheduler.js";

describe("Proactive Provider 全局调度", () => {
  it("同时只跑一个请求，等待队列按验证、Freshness、Router 排序", async () => {
    const scheduler = new ProactiveCallScheduler();
    const order: string[] = [];
    let release!: () => void;
    const first = scheduler.schedule("router", async () => {
      order.push("router-running");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("router-done");
    });
    await Promise.resolve();
    const waitingRouter = scheduler.schedule("router", async () => {
      order.push("router-waiting");
    });
    const freshness = scheduler.schedule("freshness", async () => {
      order.push("freshness");
    });
    const validation = scheduler.schedule("validation", async () => {
      order.push("validation");
    });
    release();
    await Promise.all([first, waitingRouter, freshness, validation]);
    expect(order).toEqual([
      "router-running",
      "router-done",
      "validation",
      "freshness",
      "router-waiting",
    ]);
  });

  it("删除 Key 时中断在途请求并清空等待队列", async () => {
    const scheduler = new ProactiveCallScheduler();
    const running = scheduler.schedule("router", (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await Promise.resolve();
    const waiting = scheduler.schedule("freshness", async () => undefined);
    scheduler.abortAll();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
