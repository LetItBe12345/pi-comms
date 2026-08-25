import { describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_MODEL,
  DeepSeekProactiveProvider,
  ProactiveProviderError,
  withProactiveRetry,
} from "../src/broker/proactive-provider.js";

function response(content: string, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("DeepSeek Proactive Provider", () => {
  it("发送固定非思考 JSON Output 参数并严格解析 Router", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response('{"targetAgentId":"agent:a","reason":"ignored"}'),
    );
    const provider = new DeepSeekProactiveProvider({ fetch: fetchMock });
    await expect(provider.select("secret", {
      groupName: "开发组",
      messages: [],
      omitted: false,
      candidates: [{ agentId: "agent:a", name: "A", description: "后端" }],
    })).resolves.toEqual({ targetAgentId: "agent:a" });
    const init = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 128,
      stream: false,
    });
    expect(JSON.stringify(body.messages)).toContain("json");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
  });

  it("拒绝 Markdown、未知 Agent 和非布尔 Freshness", async () => {
    const markdown = new DeepSeekProactiveProvider({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response('```json\n{"targetAgentId":null}\n```')),
    });
    await expect(markdown.select("key", {
      groupName: "g", messages: [], omitted: false, candidates: [],
    })).rejects.toMatchObject({ kind: "invalid_response" });

    const unknown = new DeepSeekProactiveProvider({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response('{"targetAgentId":"agent:x"}')),
    });
    await expect(unknown.select("key", {
      groupName: "g", messages: [], omitted: false,
      candidates: [{ agentId: "agent:a", name: "A", description: "A" }],
    })).rejects.toMatchObject({ kind: "invalid_response" });

    const stringBoolean = new DeepSeekProactiveProvider({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response('{"publish":"true"}')),
    });
    await expect(stringBoolean.isFresh("key", {
      triggerMessages: [], answer: "answer", newMessages: [], omitted: false,
    })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("只重试临时错误并使用 full jitter 和 Retry-After", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new ProactiveProviderError("network", "network"))
      .mockRejectedValueOnce(new ProactiveProviderError("rate_limit", "429", 429, 8_000))
      .mockResolvedValue("ok");
    const sleep = vi.fn(async () => undefined);
    await expect(withProactiveRetry(operation, { sleep, random: () => 0.5 })).resolves.toBe("ok");
    expect(sleep.mock.calls).toEqual([[250], [5_000]]);
    expect(operation).toHaveBeenCalledTimes(3);

    const invalid = vi.fn().mockRejectedValue(
      new ProactiveProviderError("invalid_response", "bad json"),
    );
    await expect(withProactiveRetry(invalid, { sleep })).rejects.toThrow("bad json");
    expect(invalid).toHaveBeenCalledOnce();
  });

  it("把 401/403 和 3 秒超时分类为不同错误", async () => {
    const unauthorized = new DeepSeekProactiveProvider({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response("{}", 401)),
    });
    await expect(unauthorized.validate("bad-key")).rejects.toMatchObject({
      kind: "invalid_key",
      status: 401,
    });

    const timeout = new DeepSeekProactiveProvider({
      timeoutMs: 5,
      fetch: vi.fn<typeof fetch>().mockImplementation((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        })
      ),
    });
    await expect(timeout.validate("key")).rejects.toMatchObject({ kind: "timeout" });
  });
});
