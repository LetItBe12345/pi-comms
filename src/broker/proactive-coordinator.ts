import { randomUUID } from "node:crypto";
import type {
  HistoryMessage,
  ProactiveDeliverPayload,
  ProactiveResultPayload,
  ProactiveStatus,
} from "../protocol.js";
import {
  ProactiveProviderError,
  FRESHNESS_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  type ProactiveCandidate,
  type ProactiveProvider,
  withProactiveRetry,
} from "./proactive-provider.js";
import { ProactiveCallScheduler } from "./proactive-scheduler.js";

export interface EligibleProactiveAgent extends ProactiveCandidate {
  clientId: string;
}

export interface ProactiveCredentials {
  proactiveStatus: ProactiveStatus;
  configVersion: number;
  apiKey?: string;
}

export interface ProactiveCoordinatorOptions {
  provider: ProactiveProvider;
  scheduler?: ProactiveCallScheduler;
  credentials(): ProactiveCredentials;
  groupName(groupId: string): string | undefined;
  candidates(groupId: string): EligibleProactiveAgent[];
  messages(groupId: string, afterSeq?: number, limit?: number): HistoryMessage[];
  latestSeq(groupId: string): number;
  deliver(clientId: string, payload: ProactiveDeliverPayload): boolean;
  publish(pending: PendingProactive, text: string): Promise<void> | void;
  onInvalidKey(): void;
  onStatusChanged?(): void;
  log?(event: string, fields?: Record<string, unknown>): void;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
  groupIntervalMs?: number;
  deliveryTtlMs?: number;
  cooldownMs?: number;
  pauseMs?: number;
}

interface ProactiveBatch {
  groupId: string;
  fromSeq: number;
  toSeq: number;
  firstAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PendingProactive {
  proactiveId: string;
  groupId: string;
  groupName: string;
  target: EligibleProactiveAgent;
  triggerFromSeq: number;
  triggerToSeq: number;
  observedToSeq: number;
  triggerMessages: HistoryMessage[];
  createdAt: number;
  expiresAt: number;
  configVersion: number;
}

export class ProactiveCoordinator {
  readonly #provider: ProactiveProvider;
  readonly #scheduler: ProactiveCallScheduler;
  readonly #credentials: () => ProactiveCredentials;
  readonly #groupName: (groupId: string) => string | undefined;
  readonly #candidates: (groupId: string) => EligibleProactiveAgent[];
  readonly #messages: (groupId: string, afterSeq?: number, limit?: number) => HistoryMessage[];
  readonly #latestSeq: (groupId: string) => number;
  readonly #deliver: (clientId: string, payload: ProactiveDeliverPayload) => boolean;
  readonly #publish: (pending: PendingProactive, text: string) => Promise<void> | void;
  readonly #onInvalidKey: () => void;
  readonly #onStatusChanged: () => void;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #now: () => number;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #groupIntervalMs: number;
  readonly #deliveryTtlMs: number;
  readonly #cooldownMs: number;
  readonly #pauseMs: number;
  readonly #batches = new Map<string, ProactiveBatch>();
  readonly #routerQueue: string[] = [];
  readonly #queuedGroups = new Set<string>();
  readonly #lastRouterStarted = new Map<string, number>();
  readonly #pending = new Map<string, PendingProactive>();
  readonly #cooldownUntil = new Map<string, number>();
  readonly #completed = new Map<string, number>();
  #running = false;
  #pausedUntil = 0;
  #resultQueue: Promise<void> = Promise.resolve();

  constructor(options: ProactiveCoordinatorOptions) {
    this.#provider = options.provider;
    this.#scheduler = options.scheduler ?? new ProactiveCallScheduler();
    this.#credentials = options.credentials;
    this.#groupName = options.groupName;
    this.#candidates = options.candidates;
    this.#messages = options.messages;
    this.#latestSeq = options.latestSeq;
    this.#deliver = options.deliver;
    this.#publish = options.publish;
    this.#onInvalidKey = options.onInvalidKey;
    this.#onStatusChanged = options.onStatusChanged ?? (() => undefined);
    this.#log = options.log ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#debounceMs = options.debounceMs ?? 800;
    this.#maxWaitMs = options.maxWaitMs ?? 2_000;
    this.#groupIntervalMs = options.groupIntervalMs ?? 5_000;
    this.#deliveryTtlMs = options.deliveryTtlMs ?? 10_000;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#pauseMs = options.pauseMs ?? 30_000;
  }

  trigger(groupId: string, groupSeq: number): void {
    if (!this.#available() || this.eligibleCandidates(groupId).length === 0) return;
    const now = this.#now();
    const batch = this.#batches.get(groupId) ?? {
      groupId,
      fromSeq: groupSeq,
      toSeq: groupSeq,
      firstAt: now,
    };
    batch.toSeq = Math.max(batch.toSeq, groupSeq);
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    const dueAt = Math.min(now + this.#debounceMs, batch.firstAt + this.#maxWaitMs);
    batch.timer = setTimeout(() => this.#queueBatch(groupId), Math.max(0, dueAt - now));
    batch.timer.unref?.();
    this.#batches.set(groupId, batch);
  }

  eligibleCandidates(groupId: string): EligibleProactiveAgent[] {
    const now = this.#now();
    return this.#candidates(groupId).filter(
      (candidate) => (this.#cooldownUntil.get(candidate.agentId) ?? 0) <= now,
    );
  }

  status(): ProactiveStatus {
    const configured = this.#credentials().proactiveStatus;
    if (configured === "ready" && this.#now() < this.#pausedUntil) {
      return "temporarily_unavailable";
    }
    return configured;
  }

  acknowledge(proactiveId: string): void {
    if (!this.#pending.has(proactiveId)) return;
    this.#log("proactive.delivery.ack", { proactiveId });
  }

  decline(proactiveId: string, reason: string): void {
    if (this.#pending.delete(proactiveId)) {
      this.#log("proactive.delivery.declined", { proactiveId, reason });
    }
  }

  result(result: ProactiveResultPayload): Promise<boolean> {
    if (this.#completed.has(result.proactiveId)) return Promise.resolve(true);
    if (!this.#pending.has(result.proactiveId)) return Promise.resolve(false);
    let accepted = false;
    this.#resultQueue = this.#resultQueue.then(async () => {
      const pending = this.#pending.get(result.proactiveId);
      if (pending === undefined) return;
      this.#pending.delete(result.proactiveId);
      this.#rememberCompleted(result.proactiveId);
      this.#cooldownUntil.set(pending.target.agentId, this.#now() + this.#cooldownMs);
      accepted = true;
      if (result.action === "silent") {
        this.#log("proactive.agent.silent", { proactiveId: result.proactiveId });
        return;
      }
      const normalized = normalizeAnswer(result.text);
      if (this.#isDuplicate(pending.groupId, normalized)) {
        this.#log("proactive.result.duplicate", { proactiveId: result.proactiveId });
        return;
      }
      const newMessages = this.#messages(pending.groupId, pending.observedToSeq, 20);
      if (newMessages.length > 0) {
        const credentials = this.#credentials();
        if (credentials.proactiveStatus !== "ready" || credentials.apiKey === undefined) {
          this.#log("proactive.result.stale", {
            proactiveId: result.proactiveId,
            promptVersion: FRESHNESS_PROMPT_VERSION,
          });
          return;
        }
        try {
          const fresh = await this.#scheduler.schedule("freshness", (signal) =>
            withProactiveRetry(() => {
              const latest = this.#messages(pending.groupId, pending.observedToSeq, 21);
              return this.#provider.isFresh(
                credentials.apiKey!,
                {
                  triggerMessages: pending.triggerMessages.map(toObservation),
                  answer: result.text,
                  newMessages: latest.slice(-20).map(toObservation),
                  omitted: latest.length > 20,
                },
                signal,
              );
            })
          );
          if (!fresh.publish || credentials.configVersion !== this.#credentials().configVersion) {
            this.#log("proactive.result.stale", { proactiveId: result.proactiveId });
            return;
          }
        } catch (error) {
          if (credentials.configVersion === this.#credentials().configVersion) {
            this.#handleProviderError(error);
          }
          this.#log("proactive.result.stale", { proactiveId: result.proactiveId });
          return;
        }
      }
      await this.#publish(pending, result.text);
      this.#log("proactive.result.published", { proactiveId: result.proactiveId });
    });
    return this.#resultQueue.then(() => accepted);
  }

  cancelForClient(clientId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.target.clientId === clientId) this.#pending.delete(id);
    }
  }

  clear(): void {
    for (const batch of this.#batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
    }
    this.#batches.clear();
    this.#routerQueue.length = 0;
    this.#queuedGroups.clear();
    this.#pending.clear();
    this.#cooldownUntil.clear();
    this.#completed.clear();
  }

  #queueBatch(groupId: string): void {
    const batch = this.#batches.get(groupId);
    if (batch === undefined) return;
    batch.timer = undefined;
    if (!this.#queuedGroups.has(groupId)) {
      this.#queuedGroups.add(groupId);
      this.#routerQueue.push(groupId);
    }
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#routerQueue.length > 0) {
        const groupId = this.#routerQueue.shift()!;
        this.#queuedGroups.delete(groupId);
        const batch = this.#batches.get(groupId);
        if (batch === undefined) continue;
        const wait = Math.max(
          0,
          (this.#lastRouterStarted.get(groupId) ?? 0) + this.#groupIntervalMs - this.#now(),
        );
        if (wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, wait);
            timer.unref?.();
          });
        }
        this.#batches.delete(groupId);
        await this.#route(batch);
      }
    } finally {
      this.#running = false;
    }
  }

  async #route(batch: ProactiveBatch): Promise<void> {
    if (!this.#available()) return;
    const credentials = this.#credentials();
    if (credentials.apiKey === undefined) return;
    const groupName = this.#groupName(batch.groupId);
    if (groupName === undefined) return;
    this.#lastRouterStarted.set(batch.groupId, this.#now());
    const requestStartedAt = this.#now();
    try {
      const selected = await this.#scheduler.schedule("router", (signal) =>
        withProactiveRetry(async () => {
          this.#mergeLatestBatch(batch);
          const current = this.eligibleCandidates(batch.groupId);
          if (current.length === 0) return { targetAgentId: null };
          const messages = this.#messages(batch.groupId, 0, 21);
          return this.#provider.select(credentials.apiKey!, {
            groupName,
            messages: messages.slice(-20).map(toObservation),
            omitted: messages.length > 20,
            candidates: current.map(({ clientId: _clientId, ...candidate }) => candidate),
          }, signal);
        })
      );
      if (credentials.configVersion !== this.#credentials().configVersion) return;
      if (selected.targetAgentId === null) {
        this.#log("proactive.router.none", {
          groupId: batch.groupId,
          promptVersion: ROUTER_PROMPT_VERSION,
          resultType: "none",
          durationMs: this.#now() - requestStartedAt,
        });
        return;
      }
      const target = this.eligibleCandidates(batch.groupId).find(
        (candidate) => candidate.agentId === selected.targetAgentId,
      );
      if (target === undefined) return;
      const createdAt = this.#now();
      const observedToSeq = this.#latestSeq(batch.groupId);
      const triggerMessages = this.#messages(batch.groupId, batch.fromSeq - 1, 20)
        .filter((message) => message.groupSeq <= batch.toSeq);
      const delta = this.#messages(batch.groupId, 0, 21);
      const observation = delta.length > 20 ? delta.slice(-12) : delta;
      const pending: PendingProactive = {
        proactiveId: randomUUID(),
        groupId: batch.groupId,
        groupName,
        target,
        triggerFromSeq: batch.fromSeq,
        triggerToSeq: batch.toSeq,
        observedToSeq,
        triggerMessages,
        createdAt,
        expiresAt: createdAt + this.#deliveryTtlMs,
        configVersion: credentials.configVersion,
      };
      this.#pending.set(pending.proactiveId, pending);
      const delivered = this.#deliver(target.clientId, {
        proactiveId: pending.proactiveId,
        groupId: pending.groupId,
        groupName,
        targetAgentId: target.agentId,
        targetAgentName: target.name,
        triggerFromSeq: pending.triggerFromSeq,
        triggerToSeq: pending.triggerToSeq,
        observedToSeq,
        messages: observation.map(toObservation),
        omitted: delta.length > 20,
        createdAt,
        expiresAt: pending.expiresAt,
      });
      if (!delivered) this.#pending.delete(pending.proactiveId);
      this.#log("proactive.router.selected", {
        groupId: batch.groupId,
        targetAgentId: target.agentId,
        promptVersion: ROUTER_PROMPT_VERSION,
        resultType: "selected",
        durationMs: this.#now() - requestStartedAt,
      });
      const ttlTimer = setTimeout(() => {
        const current = this.#pending.get(pending.proactiveId);
        if (current !== undefined && this.#now() >= current.expiresAt) {
          this.#pending.delete(pending.proactiveId);
          this.#log("proactive.delivery.expired", { proactiveId: pending.proactiveId });
        }
      }, this.#deliveryTtlMs);
      ttlTimer.unref?.();
    } catch (error) {
      if (credentials.configVersion === this.#credentials().configVersion) {
        this.#handleProviderError(error);
      }
      this.#log("proactive.router.error", {
        groupId: batch.groupId,
        kind: error instanceof ProactiveProviderError ? error.kind : "unknown",
        promptVersion: ROUTER_PROMPT_VERSION,
        resultType: "error",
        durationMs: this.#now() - requestStartedAt,
      });
    }
  }

  #available(): boolean {
    return this.#now() >= this.#pausedUntil &&
      this.#credentials().proactiveStatus === "ready";
  }

  #mergeLatestBatch(batch: ProactiveBatch): void {
    const newer = this.#batches.get(batch.groupId);
    if (newer === undefined || newer === batch) return;
    if (newer.timer !== undefined) clearTimeout(newer.timer);
    batch.fromSeq = Math.min(batch.fromSeq, newer.fromSeq);
    batch.toSeq = Math.max(batch.toSeq, newer.toSeq);
    this.#batches.delete(batch.groupId);
    this.#queuedGroups.delete(batch.groupId);
    for (let index = this.#routerQueue.length - 1; index >= 0; index -= 1) {
      if (this.#routerQueue[index] === batch.groupId) this.#routerQueue.splice(index, 1);
    }
  }

  #handleProviderError(error: unknown): void {
    if (!(error instanceof ProactiveProviderError)) return;
    if (error.kind === "invalid_key") {
      this.#onInvalidKey();
    } else if (error.retryable) {
      this.#pausedUntil = this.#now() + this.#pauseMs;
      this.#onStatusChanged();
      const timer = setTimeout(() => this.#onStatusChanged(), this.#pauseMs);
      timer.unref?.();
    }
  }

  #isDuplicate(groupId: string, normalized: string): boolean {
    return this.#messages(groupId, 0, 20).some(
      (message) => message.senderType === "agent" && normalizeAnswer(message.text) === normalized,
    );
  }

  #rememberCompleted(proactiveId: string): void {
    const now = this.#now();
    this.#completed.set(proactiveId, now + 10 * 60_000);
    for (const [id, expiresAt] of this.#completed) {
      if (expiresAt <= now) this.#completed.delete(id);
    }
  }
}

function toObservation(message: HistoryMessage) {
  return {
    groupSeq: message.groupSeq,
    senderName: message.senderName,
    senderType: message.senderType,
    text: message.text,
  };
}

function normalizeAnswer(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
