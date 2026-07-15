import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  parseClientEnvelope,
} from "../src/protocol.js";

describe("JSONL 协议", () => {
  it("编码为单行 JSON", () => {
    const envelope = createEnvelope(
      "chat.send",
      { text: "你好" },
      { id: "message-1", timestamp: 1 },
    );

    const encoded = encodeEnvelope(envelope);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trim()).not.toContain("\n");
    expect(JSON.parse(encoded)).toEqual(envelope);
  });

  it("增量解码被拆开的 UTF-8 消息", () => {
    const decoder = new JsonlDecoder();
    const encoded = Buffer.from(
      encodeEnvelope(
        createEnvelope(
          "chat.send",
          { text: "中文消息" },
          { id: "message-1", timestamp: 1 },
        ),
      ),
    );
    const splitAt = encoded.indexOf(Buffer.from("中")) + 1;

    expect(decoder.push(encoded.subarray(0, splitAt))).toEqual([]);
    expect(decoder.push(encoded.subarray(splitAt))).toEqual([
      {
        ok: true,
        value: {
          id: "message-1",
          type: "chat.send",
          timestamp: 1,
          payload: { text: "中文消息" },
        },
      },
    ]);
  });

  it("一次解码粘在一起的多条消息", () => {
    const decoder = new JsonlDecoder();
    const first = createEnvelope("chat.send", { text: "一" });
    const second = createEnvelope("chat.send", { text: "二" });

    expect(decoder.push(encodeEnvelope(first) + encodeEnvelope(second))).toEqual([
      { ok: true, value: first },
      { ok: true, value: second },
    ]);
  });

  it("坏 JSON 不影响后续消息", () => {
    const decoder = new JsonlDecoder();
    const valid = createEnvelope("chat.send", { text: "继续" });

    expect(decoder.push(`{bad json}\n${encodeEnvelope(valid)}`)).toEqual([
      { ok: false, error: "消息不是合法的 JSON" },
      { ok: true, value: valid },
    ]);
  });
});

describe("客户端消息校验", () => {
  it("接受群聊消息", () => {
    const broadcast = createEnvelope("chat.send", { text: "公开消息" });

    expect(parseClientEnvelope(broadcast).ok).toBe(true);
  });

  it("拒绝空消息和未知类型", () => {
    const empty = parseClientEnvelope(
      createEnvelope("chat.send", { text: "  " }, { id: "empty" }),
    );
    const unknown = parseClientEnvelope(
      createEnvelope("unknown", {}, { id: "unknown" }),
    );

    expect(empty).toMatchObject({
      ok: false,
      code: "invalid_payload",
      requestId: "empty",
    });
    expect(unknown).toMatchObject({
      ok: false,
      code: "unsupported_type",
      requestId: "unknown",
    });
  });

  it("接受成功和失败的 agent.result", () => {
    const success = createEnvelope("agent.result", {
      requestId: "request-1",
      ok: true,
      text: "最终回答",
    });
    const failure = createEnvelope("agent.result", {
      requestId: "request-2",
      ok: false,
      reason: "agent_busy",
    });

    expect(parseClientEnvelope(success).ok).toBe(true);
    expect(parseClientEnvelope(failure).ok).toBe(true);
  });

  it("接受连接握手、正常关闭和投递确认", () => {
    expect(
      parseClientEnvelope(
        createEnvelope("client.hello", {
          sessionId: "session-a",
          permission: "auto",
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(
        createEnvelope("client.goodbye", { sessionId: "session-a" }),
      ).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(
        createEnvelope("agent.deliver.ack", { requestId: "request-a" }),
      ).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(createEnvelope("agent.status", { status: "busy" })).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(createEnvelope("agent.status", { status: "unknown" })).ok,
    ).toBe(false);
    expect(
      parseClientEnvelope(createEnvelope("permission.update", { permission: "approval" })).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(createEnvelope("request.approve", { requestId: "request-a" })).ok,
    ).toBe(true);
  });

  it("接受创建、加入和离开群组", () => {
    expect(
      parseClientEnvelope(
        createEnvelope("group.create", {
          groupName: "开发组",
          userName: "Alice",
          agentName: "Alice-Pi",
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseClientEnvelope(
        createEnvelope("group.join", {
          groupId: "group-a",
          userName: "Bob",
          agentName: "Bob-Pi",
        }),
      ).ok,
    ).toBe(true);
    expect(parseClientEnvelope(createEnvelope("group.leave", {})).ok).toBe(
      true,
    );
  });
});
