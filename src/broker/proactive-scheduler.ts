export type ProactiveCallPriority = "validation" | "freshness" | "router";

interface QueuedCall<T> {
  run(signal: AbortSignal): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class ProactiveCallScheduler {
  readonly #queues: Record<ProactiveCallPriority, QueuedCall<unknown>[]> = {
    validation: [],
    freshness: [],
    router: [],
  };
  #running = false;
  #controller: AbortController | undefined;

  schedule<T>(
    priority: ProactiveCallPriority,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queues[priority].push({ run, resolve, reject } as QueuedCall<unknown>);
      void this.#drain();
    });
  }

  abortAll(): void {
    this.#controller?.abort();
    const error = new DOMException("Proactive Provider 请求已取消", "AbortError");
    for (const queue of Object.values(this.#queues)) {
      for (const call of queue.splice(0)) call.reject(error);
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const call = this.#next();
        if (call === undefined) return;
        const controller = new AbortController();
        this.#controller = controller;
        try {
          call.resolve(await call.run(controller.signal));
        } catch (error) {
          call.reject(error);
        } finally {
          if (this.#controller === controller) this.#controller = undefined;
        }
      }
    } finally {
      this.#running = false;
      if (this.#next(false) !== undefined) void this.#drain();
    }
  }

  #next(remove = true): QueuedCall<unknown> | undefined {
    for (const priority of ["validation", "freshness", "router"] as const) {
      const call = this.#queues[priority][0];
      if (call !== undefined) return remove ? this.#queues[priority].shift() : call;
    }
    return undefined;
  }
}
