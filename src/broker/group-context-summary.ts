import type { HistoryMessage } from "../protocol.js";
import {
  SUMMARY_PROMPT_VERSION,
  type ProactiveContextSummary,
  type ProactiveProvider,
  type ProactiveProviderError,
  withProactiveRetry,
} from "./proactive-provider.js";
import { ProactiveCallScheduler } from "./proactive-scheduler.js";
import type { BrokerDatabase, StoredGroupSummary } from "./database.js";

export const GROUP_CONTEXT_WINDOW = 12;

export interface ProactiveGroupContext {
  summary?: ProactiveContextSummary;
  messages: HistoryMessage[];
  omitted: boolean;
  summaryIncomplete: boolean;
}

export interface GroupContextSummaryOptions {
  database(): BrokerDatabase;
  provider: ProactiveProvider;
  scheduler: ProactiveCallScheduler;
  log?(event: string, fields?: Record<string, unknown>): void;
  now?: () => number;
}

export class GroupContextSummary {
  readonly #database: () => BrokerDatabase;
  readonly #provider: ProactiveProvider;
  readonly #scheduler: ProactiveCallScheduler;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  readonly #now: () => number;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(options: GroupContextSummaryOptions) {
    this.#database = options.database;
    this.#provider = options.provider;
    this.#scheduler = options.scheduler;
    this.#log = options.log ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  async prepare(groupId: string, apiKey: string, throughSeq: number): Promise<ProactiveGroupContext> {
    const before = this.snapshot(groupId, throughSeq);
    if (!before.summaryIncomplete) return before;
    let running = this.#inFlight.get(groupId);
    if (running === undefined) {
      running = this.#update(groupId, apiKey, throughSeq).finally(() => {
        if (this.#inFlight.get(groupId) === running) this.#inFlight.delete(groupId);
      });
      this.#inFlight.set(groupId, running);
    }
    await running;
    return this.snapshot(groupId, throughSeq);
  }

  snapshot(groupId: string, throughSeq: number): ProactiveGroupContext {
    const database = this.#database();
    const probe = database.publicMessages(groupId, {
      throughSeq,
      limit: GROUP_CONTEXT_WINDOW + 1,
    });
    const messages = probe.slice(-GROUP_CONTEXT_WINDOW);
    const omitted = probe.length > GROUP_CONTEXT_WINDOW;
    if (!omitted) return { messages, omitted: false, summaryIncomplete: false };
    const requiredThroughSeq = probe[probe.length - GROUP_CONTEXT_WINDOW - 1]!.groupSeq;
    const stored = this.#validStoredSummary(groupId);
    const summary = stored === undefined ? undefined : toContextSummary(stored);
    return {
      summary,
      messages,
      omitted: true,
      summaryIncomplete: stored === undefined || stored.throughSeq < requiredThroughSeq,
    };
  }

  async #update(groupId: string, apiKey: string, throughSeq: number): Promise<void> {
    const startedAt = this.#now();
    const database = this.#database();
    const probe = database.publicMessages(groupId, {
      throughSeq,
      limit: GROUP_CONTEXT_WINDOW + 1,
    });
    if (probe.length <= GROUP_CONTEXT_WINDOW) return;
    const targetThroughSeq = probe[probe.length - GROUP_CONTEXT_WINDOW - 1]!.groupSeq;
    const previous = this.#validStoredSummary(groupId);
    if (previous !== undefined && previous.throughSeq >= targetThroughSeq) return;
    const messages = database.publicMessagesRange(
      groupId,
      previous?.throughSeq ?? 0,
      targetThroughSeq,
    );
    if (messages.length === 0) return;
    const fromSeq = previous?.fromSeq ?? messages[0]!.groupSeq;
    try {
      const result = await this.#scheduler.schedule("summary", (signal) =>
        withProactiveRetry(() => this.#provider.summarize(apiKey, {
          ...(previous === undefined ? {} : { previousSummary: toContextSummary(previous) }),
          messages: messages.map((message) => ({
            groupSeq: message.groupSeq,
            senderName: message.senderName,
            senderType: message.senderType,
            text: message.text,
          })),
        }, signal))
      );
      database.saveGroupSummary({
        groupId,
        summary: result.summary,
        fromSeq,
        throughSeq: messages.at(-1)!.groupSeq,
        promptVersion: SUMMARY_PROMPT_VERSION,
        updatedAt: this.#now(),
      });
      this.#log("proactive.summary.updated", {
        groupId,
        fromSeq,
        throughSeq: messages.at(-1)!.groupSeq,
        promptVersion: SUMMARY_PROMPT_VERSION,
        resultType: "updated",
        durationMs: this.#now() - startedAt,
      });
    } catch (error) {
      this.#log("proactive.summary.error", {
        groupId,
        fromSeq,
        throughSeq: targetThroughSeq,
        promptVersion: SUMMARY_PROMPT_VERSION,
        resultType: "error",
        kind: (error as ProactiveProviderError | undefined)?.kind ?? "unknown",
        durationMs: this.#now() - startedAt,
      });
    }
  }

  #validStoredSummary(groupId: string): StoredGroupSummary | undefined {
    const database = this.#database();
    const stored = database.groupSummary(groupId);
    if (stored === undefined) return undefined;
    const firstSeq = database.firstPublicMessageSeq(groupId);
    const fromExists = database.publicMessagesRange(groupId, stored.fromSeq - 1, stored.fromSeq)
      .some((message) => message.groupSeq === stored.fromSeq);
    const throughExists = database.publicMessagesRange(
      groupId,
      stored.throughSeq - 1,
      stored.throughSeq,
    ).some((message) => message.groupSeq === stored.throughSeq);
    if (
      firstSeq === undefined || stored.fromSeq !== firstSeq ||
      stored.throughSeq < stored.fromSeq || !fromExists || !throughExists ||
      stored.promptVersion !== SUMMARY_PROMPT_VERSION
    ) {
      this.#log("proactive.summary.invalid", {
        groupId,
        fromSeq: stored.fromSeq,
        throughSeq: stored.throughSeq,
        promptVersion: stored.promptVersion,
        resultType: "invalid",
      });
      return undefined;
    }
    return stored;
  }
}

function toContextSummary(summary: StoredGroupSummary): ProactiveContextSummary {
  return {
    text: summary.summary,
    fromSeq: summary.fromSeq,
    throughSeq: summary.throughSeq,
    promptVersion: summary.promptVersion,
  };
}
