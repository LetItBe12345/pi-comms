/** Test-only deterministic provider; exercises real Pi tool dispatch without model credentials. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, getCurrentTools,
  type AssistantMessage, type Model, type Api, type TranscriptContext, type ToolCall,
} from "@earendil-works/pi-ai";
import { createCommsExtension } from "../../src/extension/index.js";

const calls: Array<Pick<ToolCall, "name" | "arguments">> = [
  { name: "mcp__pi_comms__get_group_context", arguments: {} },
  { name: "mcp__pi_comms__read_group_messages", arguments: { limit: 50 } },
  { name: "read_mcp_resource", arguments: { server: "pi-comms", uri: "pi-comms://group/current" } },
  { name: "read_mcp_resource", arguments: { server: "pi-comms", uri: "pi-comms://group/context" } },
];

function log(value: unknown) {
  if (process.env.PI_COMMS_E2E_LOG) appendFileSync(process.env.PI_COMMS_E2E_LOG, JSON.stringify(value) + "\n");
}

function streamProof(model: Model<Api>, context: TranscriptContext) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: output });
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      const results = context.messages.filter((m) => m.role === "toolResult").slice(-4);
      const success = results.length === 4 && results.every((m) => m.role === "toolResult" && !m.isError);
      const text = success ? "MCP_E2E_PASS: 两个 direct Tool 和两个 Resource 读取成功。" : "MCP_E2E_FAIL";
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      log({ type: "proof", success });
      stream.push({ type: "done", reason: "stop", message: output });
    } else {
      const declared = getCurrentTools(context.messages).map((tool) => tool.name);
      log({ type: "declarations", tools: declared });
      for (const [index, call] of calls.entries()) {
        const toolCall = { type: "toolCall" as const, id: `mcp-proof-${Date.now()}-${index}`, ...call };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
      }
      output.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message: output });
    }
    stream.end();
  });
  return stream;
}

export default function (pi: ExtensionAPI) {
  createCommsExtension({
    endpoint: { host: process.env.PI_COMMS_E2E_HOST ?? "127.0.0.1", port: Number(process.env.PI_COMMS_E2E_PORT) },
    dbPath: process.env.PI_COMMS_E2E_DB,
    ...(process.env.PI_COMMS_E2E_MODE === "lan" ? { connectionConfig: { mode: "lan-host" as const } } : {}),
    registerTestCommands: true,
    startBroker: () => {},
  })(pi);
  pi.registerProvider("mcp-e2e", {
    api: "mcp-e2e-api", apiKey: "test-only", baseUrl: "http://unused.invalid",
    models: [{ id: "proof", name: "MCP deterministic test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple: streamProof,
  });
  pi.on("tool_result", (event) => {
    log({ type: "tool_result", toolName: event.toolName, input: event.input,
      isError: event.isError, content: event.content });
  });
}
