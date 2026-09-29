import { randomUUID } from "node:crypto";
import type {
  HistoryMessage,
  ProactiveDeliverPayload,
  ProactiveResultPayload,
  ProactiveStatus,
} from "../protocol.js";
import type { GroupParticipantContext } from "../types.js";
import {
  ProactiveProviderError,
  FRESHNESS_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  type ProactiveCandidate,
  type ProactiveProvider,
  withProactiveRetry,
} from "./proactive-provider.js";
import { ProactiveCallScheduler } from "./proactive-scheduler.js";
import type { ProactiveGroupContext } from "./group-context-summary.js";

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
  context(groupId: string, throughSeq: number, apiKey: string): Promise<ProactiveGroupContext>;
  contextSnapshot?(groupId: string, throughSeq: number): ProactiveGroupContext;
  participants(groupId: string): GroupParticipantContext[];
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
  timer?: ReturnType<typeof setTimeout>;
}

export class ProactiveCoordinator {
  readonly #provider: ProactiveProvider;
  readonly #scheduler: ProactiveCallScheduler;
  readonly #credentials: () => ProactiveCredentials;
  readonly #groupName: (groupId: string) => string | undefined;
  readonly #candidates: (groupId: string) => EligibleProactiveAgent[];
  readonly #messages: (groupId: string, afterSeq?: number, limit?: number) => HistoryMessage[];
  readonly #latestSeq: (groupId: string) => number;
  readonly #context: (
    groupId: string,
    throughSeq: number,
    apiKey: string,
  ) => Promise<ProactiveGroupContext>;
  readonly #contextSnapshot?: (groupId: string, throughSeq: number) => ProactiveGroupContext;
  readonly #participants: (groupId: string) => GroupParticipantContext[];
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
    this.#context = options.context;
    this.#contextSnapshot = options.contextSnapshot;
    this.#participants = options.participants;
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
    const pending = this.#pending.get(proactiveId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    this.#log("proactive.delivery.ack", {
      proactiveId,
      targetAgentId: pending.target.agentId,
    });
  }

  decline(proactiveId: string, reason: string): void {
    const pending = this.#pending.get(proactiveId);
    if (pending !== undefined) clearTimeout(pending.timer);
    if (this.#pending.delete(proactiveId)) {
      this.#log("proactive.delivery.declined", {
        proactiveId,
        targetAgentId: pending?.target.agentId,
        reason,
      });
    }
  }

  result(result: ProactiveResultPayload): Promise<boolean> {
    if (this.#completed.has(result.proactiveId)) return Promise.resolve(true);
    if (!this.#pending.has(result.proactiveId)) return Promise.resolve(false);
    let accepted = false;
    this.#resultQueue = this.#resultQueue.then(async () => {
      const pending = this.#pending.get(result.proactiveId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(result.proactiveId);
      this.#rememberCompleted(result.proactiveId);
      this.#cooldownUntil.set(pending.target.agentId, this.#now() + this.#cooldownMs);
      accepted = true;
      if (result.action === "silent") {
        this.#log("proactive.agent.silent", {
          proactiveId: result.proactiveId,
          targetAgentId: pending.target.agentId,
        });
        return;
      }
      const normalized = normalizeAnswer(result.text);
      if (this.#isDuplicate(pending.groupId, normalized)) {
        this.#log("proactive.result.duplicate", {
          proactiveId: result.proactiveId,
          targetAgentId: pending.target.agentId,
        });
        return;
      }
      const newMessages = this.#messages(pending.groupId, pending.observedToSeq, 13);
      if (newMessages.length > 0) {
        const credentials = this.#credentials();
        if (credentials.proactiveStatus !== "ready" || credentials.apiKey === undefined) {
          this.#log("proactive.result.stale", {
            proactiveId: result.proactiveId,
            targetAgentId: pending.target.agentId,
            promptVersion: FRESHNESS_PROMPT_VERSION,
          });
          return;
        }
        try {
          const latestSeq = this.#latestSeq(pending.groupId);
          const context = await this.#context(pending.groupId, latestSeq, credentials.apiKey);
          if (
            credentials.configVersion !== this.#credentials().configVersion ||
            this.#credentials().proactiveStatus !== "ready"
          ) return;
          const latest = this.#messages(pending.groupId, pending.observedToSeq, 13);
          const omitted = latest.length > 12;
          const omittedThroughSeq = omitted ? latest[latest.length - 13]!.groupSeq : undefined;
          if (
            omittedThroughSeq !== undefined &&
            (context.summaryIncomplete || context.summary === undefined ||
              context.summary.throughSeq < omittedThroughSeq)
          ) {
            this.#log("proactive.result.stale", {
              proactiveId: result.proactiveId,
              targetAgentId: pending.target.agentId,
              promptVersion: FRESHNESS_PROMPT_VERSION,
              reason: "summary_incomplete",
            });
            return;
          }
          const fresh = await this.#scheduler.schedule("freshness", (signal) =>
            withProactiveRetry(() => {
              const current = this.#messages(pending.groupId, pending.observedToSeq, 13);
              const currentOmitted = current.length > 12;
              const currentOmittedThrough = currentOmitted ? current[0]!.groupSeq : undefined;
              if (
                currentOmittedThrough !== undefined &&
                (context.summaryIncomplete || context.summary === undefined ||
                  context.summary.throughSeq < currentOmittedThrough)
              ) {
                throw new ProactiveProviderError(
                  "invalid_response",
                  "Freshness 缺少被省略新增消息的摘要",
                );
              }
              return this.#provider.isFresh(
                credentials.apiKey!,
                {
                  triggerMessages: pending.triggerMessages.map(toObservation),
                  answer: result.text,
                  observedToSeq: pending.observedToSeq,
                  ...(context.summary === undefined ? {} : { summary: context.summary }),
                  newMessages: current.slice(-12).map(toObservation),
                  omitted: currentOmitted,
                },
                signal,
              );
            })
          );
          if (!fresh.publish || credentials.configVersion !== this.#credentials().configVersion) {
            this.#log("proactive.result.stale", {
              proactiveId: result.proactiveId,
              targetAgentId: pending.target.agentId,
            });
            return;
          }
        } catch (error) {
          if (credentials.configVersion === this.#credentials().configVersion) {
            this.#handleProviderError(error);
          }
          this.#log("proactive.result.stale", {
            proactiveId: result.proactiveId,
            targetAgentId: pending.target.agentId,
          });
          return;
        }
      }
      await this.#publish(pending, result.text);
      this.#log("proactive.result.published", {
        proactiveId: result.proactiveId,
        targetAgentId: pending.target.agentId,
      });
    });
    return this.#resultQueue.then(() => accepted);
  }

  cancelForClient(clientId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.target.clientId === clientId) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
    }
  }

  clear(): void {
    for (const batch of this.#batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
    }
    this.#batches.clear();
    this.#routerQueue.length = 0;
    this.#queuedGroups.clear();
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
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
      const context = await this.#context(
        batch.groupId,
        this.#latestSeq(batch.groupId),
        credentials.apiKey,
      );
      if (
        credentials.configVersion !== this.#credentials().configVersion ||
        this.#credentials().proactiveStatus !== "ready"
      ) return;
      const selected = await this.#scheduler.schedule("router", (signal) =>
        withProactiveRetry(async () => {
          this.#mergeLatestBatch(batch);
          const current = this.eligibleCandidates(batch.groupId);
          if (current.length === 0) return { targetAgentIds: [] };
          const routeContext = this.#contextSnapshot?.(
            batch.groupId,
            this.#latestSeq(batch.groupId),
          ) ?? context;
          return this.#provider.select(credentials.apiKey!, {
            groupName,
            ...(routeContext.summary === undefined ? {} : { summary: routeContext.summary }),
            summaryIncomplete: routeContext.summaryIncomplete,
            messages: routeContext.messages.map(toObservation),
            omitted: routeContext.omitted,
            candidates: current.map(({ clientId: _clientId, ...candidate }) => candidate),
            eligibleAgentIds: current.map((candidate) => candidate.agentId),
            participants: this.#participants(batch.groupId),
          }, signal);
        })
      );
      if (credentials.configVersion !== this.#credentials().configVersion) return;
      const selectedIds = selected.targetAgentIds ?? (selected.targetAgentId == null ? [] : [selected.targetAgentId]);
      if (selectedIds.length === 0) {
        this.#log("proactive.router.none", {
          groupId: batch.groupId,
          promptVersion: ROUTER_PROMPT_VERSION,
          resultType: "none",
          durationMs: this.#now() - requestStartedAt,
        });
        return;
      }
      const targets = selectedIds
        .map((id) => this.eligibleCandidates(batch.groupId).find((candidate) => candidate.agentId === id))
        .filter((target): target is EligibleProactiveAgent => target !== undefined)
        .slice(0, 3);
      const observedToSeq = this.#latestSeq(batch.groupId);
      const triggerMessages = this.#messages(batch.groupId, batch.fromSeq - 1, 12)
        .filter((message) => message.groupSeq <= batch.toSeq);
      const deliveryContext = observedToSeq === context.messages.at(-1)?.groupSeq
        ? context
        : await this.#context(batch.groupId, observedToSeq, credentials.apiKey);
      const recipients = targets.map(({ agentId, name }) => ({ agentId, name }));
      for (const target of targets) {
        const createdAt = this.#now();
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
        participants: this.#participants(batch.groupId),
        coRecipients: recipients.filter(({ agentId }) => agentId !== target.agentId),
        ...(deliveryContext.summary === undefined ? {} : { summary: deliveryContext.summary }),
        summaryIncomplete: deliveryContext.summaryIncomplete,
        messages: deliveryContext.messages.map(toObservation),
        omitted: deliveryContext.omitted,
        createdAt,
        expiresAt: pending.expiresAt,
        });
        if (!delivered) this.#pending.delete(pending.proactiveId);
        const ttlTimer = setTimeout(() => {
          const current = this.#pending.get(pending.proactiveId);
          if (current !== undefined && this.#now() >= current.expiresAt) {
            this.#pending.delete(pending.proactiveId);
            this.#log("proactive.delivery.expired", {
              proactiveId: pending.proactiveId,
              targetAgentId: pending.target.agentId,
            });
          }
        }, this.#deliveryTtlMs);
        ttlTimer.unref?.();
        pending.timer = ttlTimer;
      }
      this.#log("proactive.router.selected", {
        groupId: batch.groupId,
        targetAgentIds: targets.map((target) => target.agentId),
        promptVersion: ROUTER_PROMPT_VERSION,
        resultType: "selected",
        durationMs: this.#now() - requestStartedAt,
      });
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
