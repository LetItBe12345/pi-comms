import type { ProactiveObservationMessage } from "../protocol.js";
import type { GroupParticipantContext } from "../types.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-flash";
export const ROUTER_PROMPT_VERSION = "router-v4";
export const FRESHNESS_PROMPT_VERSION = "freshness-v3";
export const SUMMARY_PROMPT_VERSION = "summary-v1";

export interface ProactiveCandidate {
  agentId: string;
  name: string;
  description: string;
}

export interface ProactiveRouteInput {
  groupName: string;
  summary?: ProactiveContextSummary;
  summaryIncomplete: boolean;
  messages: ProactiveObservationMessage[];
  omitted: boolean;
  candidates: ProactiveCandidate[];
  eligibleAgentIds?: string[];
  participants?: GroupParticipantContext[];
}

export interface ProactiveFreshnessInput {
  triggerMessages: ProactiveObservationMessage[];
  answer: string;
  observedToSeq: number;
  summary?: ProactiveContextSummary;
  newMessages: ProactiveObservationMessage[];
  omitted: boolean;
}

export interface ProactiveContextSummary {
  text: string;
  fromSeq: number;
  throughSeq: number;
  promptVersion: string;
}

export interface ProactiveSummaryInput {
  previousSummary?: ProactiveContextSummary;
  messages: ProactiveObservationMessage[];
}

export interface ProactiveProvider {
  validate(apiKey: string, signal?: AbortSignal): Promise<void>;
  select(
    apiKey: string,
    input: ProactiveRouteInput,
    signal?: AbortSignal,
  ): Promise<{ targetAgentIds?: string[]; targetAgentId?: string | null }>;
  isFresh(
    apiKey: string,
    input: ProactiveFreshnessInput,
    signal?: AbortSignal,
  ): Promise<{ publish: boolean }>;
  summarize(
    apiKey: string,
    input: ProactiveSummaryInput,
    signal?: AbortSignal,
  ): Promise<{ summary: string }>;
}

export type ProactiveProviderErrorKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "invalid_key"
  | "invalid_response";

export class ProactiveProviderError extends Error {
  constructor(
    readonly kind: ProactiveProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === "network" || this.kind === "timeout" ||
      this.kind === "rate_limit" || this.kind === "server";
  }
}

export interface DeepSeekProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  summaryTimeoutMs?: number;
}

export class DeepSeekProactiveProvider implements ProactiveProvider {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #summaryTimeoutMs: number;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    this.#summaryTimeoutMs = options.summaryTimeoutMs ?? 3_000;
  }

  async validate(apiKey: string, signal?: AbortSignal): Promise<void> {
    await this.#complete(apiKey, [
      { role: "system", content: "Reply with json only. Example: {\"ok\":true}" },
      { role: "user", content: "Return {\"ok\":true} as json." },
    ], signal, this.#timeoutMs, 128);
  }

  async select(
    apiKey: string,
    input: ProactiveRouteInput,
    signal?: AbortSignal,
  ): Promise<{ targetAgentIds?: string[]; targetAgentId?: string | null }> {
    const eligible = new Set(
      input.eligibleAgentIds ?? input.candidates.map((candidate) => candidate.agentId),
    );
    const value = await this.#complete(apiKey, [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, this.#timeoutMs, 128);
    if (!("targetAgentIds" in value) && "targetAgentId" in value) {
      const legacy = value.targetAgentId;
      if (legacy === null) return { targetAgentId: null };
      if (typeof legacy !== "string" || !eligible.has(legacy)) throw invalidResponse("Router 返回了未知 Agent ID");
      return { targetAgentId: legacy };
    }
    const raw = value.targetAgentIds;
    if (!Array.isArray(raw) || raw.length > 3 || raw.some((id) => typeof id !== "string")) {
      throw invalidResponse("Router 返回的 targetAgentIds 无效");
    }
    const ids = [...new Set(raw as string[])];
    if (ids.some((id) => !eligible.has(id))) throw invalidResponse("Router 返回了未知 Agent ID");
    return { targetAgentIds: ids };
  }

  async isFresh(
    apiKey: string,
    input: ProactiveFreshnessInput,
    signal?: AbortSignal,
  ): Promise<{ publish: boolean }> {
    const value = await this.#complete(apiKey, [
      { role: "system", content: FRESHNESS_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, this.#timeoutMs, 128);
    if (typeof value.publish !== "boolean") {
      throw invalidResponse("Freshness publish 必须是 JSON 布尔值");
    }
    return { publish: value.publish };
  }

  async summarize(
    apiKey: string,
    input: ProactiveSummaryInput,
    signal?: AbortSignal,
  ): Promise<{ summary: string }> {
    const value = await this.#complete(apiKey, [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, this.#summaryTimeoutMs, 1_024);
    if (typeof value.summary !== "string" || !value.summary.trim()) {
      throw invalidResponse("Summary summary 必须是非空字符串");
    }
    return { summary: value.summary.trim() };
  }

  async #complete(
    apiKey: string,
    messages: Array<{ role: "system" | "user"; content: string }>,
    outerSignal?: AbortSignal,
    timeoutMs = this.#timeoutMs,
    maxTokens = 128,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal === undefined
      ? timeout
      : AbortSignal.any([outerSignal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted && !outerSignal?.aborted) {
        throw new ProactiveProviderError("timeout", "DeepSeek 请求超时");
      }
      if (outerSignal?.aborted) throw error;
      throw new ProactiveProviderError("network", "无法连接 DeepSeek API");
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 401 || response.status === 403) {
        throw new ProactiveProviderError("invalid_key", "DeepSeek API Key 无效", response.status);
      }
      if (response.status === 429) {
        throw new ProactiveProviderError(
          "rate_limit",
          "DeepSeek 请求受到限流",
          response.status,
          retryAfterMs,
        );
      }
      if (response.status >= 500) {
        throw new ProactiveProviderError("server", "DeepSeek 服务暂时不可用", response.status);
      }
      throw new ProactiveProviderError("bad_request", "DeepSeek 请求被拒绝", response.status);
    }
    const body = await response.json().catch(() => undefined) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | undefined;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw invalidResponse("DeepSeek 返回空内容");
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not object");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw invalidResponse("DeepSeek 返回的内容不是纯 JSON 对象");
    }
  }
}

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export async function withProactiveRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProactiveProviderError) || !error.retryable || attempt === 2) {
        throw error;
      }
      const jitterCap = attempt === 0 ? 500 : 1_000;
      const delay = error.kind === "rate_limit" && error.retryAfterMs !== undefined
        ? Math.min(error.retryAfterMs, 5_000)
        : Math.floor(random() * (jitterCap + 1));
      await sleep(delay);
    }
  }
  throw lastError;
}

const ROUTER_SYSTEM_PROMPT = `${ROUTER_PROMPT_VERSION}\n` +
  "Help users get answers and solve problems. Select agents from eligibleAgentIds to answer unresolved human questions or carry out requests for help. " +
  "A short or simple question still deserves an answer; do not require novel expertise or a major contribution. " +
  "For an unanswered question or request, select the best suitable eligible agent by default. " +
  "A general-purpose agent can answer ordinary questions even without a specialized description. " +
  "participants is the full group directory for understanding who works on what; " +
  "questions about group members or agent counts can be answered using this directory. " +
  "never select an agent outside eligibleAgentIds. " +
  "You may also select an agent to correct an important error, add missing expertise, or advance the discussion. " +
  "Select zero for greetings without a question or request, agreement, already answered or resolved requests, or no suitable eligible agent. " +
  "Select one by default; select at most three only when each can provide distinct complementary help. " +
  "Return pure json only with targetAgentIds, an array of eligible IDs; use an empty array for zero agents. " +
  "Example json: {\"targetAgentIds\":[]}.";

const FRESHNESS_SYSTEM_PROMPT = `${FRESHNESS_PROMPT_VERSION}\n` +
  "Decide whether the complete candidate answer is still useful after the newer messages. " +
  "Publish when it reports independent edits, test results, failures or blockers, even if " +
  "another agent already answered; only drop pure duplicates or answers invalidated by newer messages. " +
  "Return pure json only. Example json: {\"publish\":true}.";

const SUMMARY_SYSTEM_PROMPT = `${SUMMARY_PROMPT_VERSION}\n` +
  "Update the rolling summary of a public group chat. Preserve confirmed goals, constraints, " +
  "decisions and later changes, key facts, completed results, active work, unresolved questions, " +
  "speaker attribution, and necessary file names, API names, errors, and message numbers. " +
  "Never turn a plan into a completed result, an agent suggestion into a user decision, invent facts, " +
  "or omit a later change to an earlier decision. Return pure json only. " +
  "Example json: {\"summary\":\"#1-#4: Alice confirmed the API name.\"}.";

function invalidResponse(message: string): ProactiveProviderError {
  return new ProactiveProviderError("invalid_response", message);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

export class FakeProactiveRouter implements ProactiveProvider {
  constructor(
    readonly route: (input: ProactiveRouteInput) => string | string[] | null = () => null,
    readonly freshness: (input: ProactiveFreshnessInput) => boolean = () => true,
    readonly summary: (input: ProactiveSummaryInput) => string = (input) =>
      input.messages.map((message) => `#${message.groupSeq} ${message.senderName}: ${message.text}`).join("\n"),
  ) {}

  async validate(): Promise<void> {}

  async select(
    _apiKey: string,
    input: ProactiveRouteInput,
  ): Promise<{ targetAgentIds: string[] }> {
    const result = this.route(input);
    return { targetAgentIds: result === null ? [] : Array.isArray(result) ? result : [result] };
  }

  async isFresh(
    _apiKey: string,
    input: ProactiveFreshnessInput,
  ): Promise<{ publish: boolean }> {
    return { publish: this.freshness(input) };
  }

  async summarize(
    _apiKey: string,
    input: ProactiveSummaryInput,
  ): Promise<{ summary: string }> {
    return { summary: this.summary(input) };
  }
}
