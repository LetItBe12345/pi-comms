import type { ProactiveObservationMessage } from "../protocol.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
export const ROUTER_PROMPT_VERSION = "router-v1";
export const FRESHNESS_PROMPT_VERSION = "freshness-v1";

export interface ProactiveCandidate {
  agentId: string;
  name: string;
  description: string;
}

export interface ProactiveRouteInput {
  groupName: string;
  messages: ProactiveObservationMessage[];
  omitted: boolean;
  candidates: ProactiveCandidate[];
}

export interface ProactiveFreshnessInput {
  triggerMessages: ProactiveObservationMessage[];
  answer: string;
  newMessages: ProactiveObservationMessage[];
  omitted: boolean;
}

export interface ProactiveProvider {
  validate(apiKey: string, signal?: AbortSignal): Promise<void>;
  select(
    apiKey: string,
    input: ProactiveRouteInput,
    signal?: AbortSignal,
  ): Promise<{ targetAgentId: string | null }>;
  isFresh(
    apiKey: string,
    input: ProactiveFreshnessInput,
    signal?: AbortSignal,
  ): Promise<{ publish: boolean }>;
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
}

export class DeepSeekProactiveProvider implements ProactiveProvider {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
  }

  async validate(apiKey: string, signal?: AbortSignal): Promise<void> {
    await this.#complete(apiKey, [
      { role: "system", content: "Reply with json only. Example: {\"ok\":true}" },
      { role: "user", content: "Return {\"ok\":true} as json." },
    ], signal);
  }

  async select(
    apiKey: string,
    input: ProactiveRouteInput,
    signal?: AbortSignal,
  ): Promise<{ targetAgentId: string | null }> {
    const eligible = new Set(input.candidates.map((candidate) => candidate.agentId));
    const value = await this.#complete(apiKey, [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal);
    if (!("targetAgentId" in value)) throw invalidResponse("缺少 targetAgentId");
    const targetAgentId = value.targetAgentId;
    if (targetAgentId === null) return { targetAgentId: null };
    if (typeof targetAgentId !== "string" || !eligible.has(targetAgentId)) {
      throw invalidResponse("Router 返回了未知 Agent ID");
    }
    return { targetAgentId };
  }

  async isFresh(
    apiKey: string,
    input: ProactiveFreshnessInput,
    signal?: AbortSignal,
  ): Promise<{ publish: boolean }> {
    const value = await this.#complete(apiKey, [
      { role: "system", content: FRESHNESS_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal);
    if (typeof value.publish !== "boolean") {
      throw invalidResponse("Freshness publish 必须是 JSON 布尔值");
    }
    return { publish: value.publish };
  }

  async #complete(
    apiKey: string,
    messages: Array<{ role: "system" | "user"; content: string }>,
    outerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
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
          max_tokens: 128,
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
  "Select at most one eligible agent only when it can answer an unresolved question, " +
  "correct an important error, add missing expertise, or materially advance the discussion. " +
  "For greetings, agreement, repetition, or no useful contribution, select null. " +
  "Return pure json only. Example json: {\"targetAgentId\":null}.";

const FRESHNESS_SYSTEM_PROMPT = `${FRESHNESS_PROMPT_VERSION}\n` +
  "Decide whether the complete candidate answer is still useful after the newer messages. " +
  "Return pure json only. Example json: {\"publish\":true}.";

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
    readonly route: (input: ProactiveRouteInput) => string | null = () => null,
    readonly freshness: (input: ProactiveFreshnessInput) => boolean = () => true,
  ) {}

  async validate(): Promise<void> {}

  async select(
    _apiKey: string,
    input: ProactiveRouteInput,
  ): Promise<{ targetAgentId: string | null }> {
    return { targetAgentId: this.route(input) };
  }

  async isFresh(
    _apiKey: string,
    input: ProactiveFreshnessInput,
  ): Promise<{ publish: boolean }> {
    return { publish: this.freshness(input) };
  }
}
