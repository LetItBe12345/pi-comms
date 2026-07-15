import { describe, expect, it } from "vitest";
import {
  GroupState,
  GroupStateError,
  validateDisplayName,
} from "../src/broker/group-state.js";

describe("GroupState", () => {
  it("按 Unicode 字符校验名称", () => {
    expect(() => validateDisplayName("中文_Name-24")).not.toThrow();
    expect(() => validateDisplayName("有 空格")).toThrow(GroupStateError);
    expect(() => validateDisplayName("a".repeat(25))).toThrow(GroupStateError);
  });

  it("离线期间保留名称，移除后释放名称", () => {
    const state = new GroupState();
    const first = state.createGroup("a", "群组", "Alice", "Alice-Pi");
    state.setOnline("a", false);
    expect(() => state.joinGroup("b", first.groupId, "alice", "Bob-Pi")).toThrow(
      "用户名称已被使用",
    );
    state.leaveGroup("a");
    expect(() => state.joinGroup("b", first.groupId, "alice", "Bob-Pi")).not.toThrow();
  });

  it("同一连接生成用户和 Agent 两个稳定 ID", () => {
    const state = new GroupState();
    const membership = state.createGroup("client-a", "群组", "用户", "助手");
    expect(membership.user.memberId).toBe("user:client-a");
    expect(membership.agent.memberId).toBe("agent:client-a");
    expect(state.onlineMembers(membership.groupId)).toHaveLength(2);
  });
});
