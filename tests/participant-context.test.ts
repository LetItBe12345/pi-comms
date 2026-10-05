import { describe, expect, it } from "vitest";
import { participantContext } from "../src/participant-context.js";
import type { Member } from "../src/types.js";

describe("群组角色目录", () => {
  it("纯人类 Web 用户保留在目录中", () => {
    expect(participantContext([user("web", "Bob", true)])).toEqual([{ user: { name: "Bob", isOwner: false, online: true } }]);
  });
  it("配对用户与 Agent，保留角色状态并排除 removed", () => {
    const members: Member[] = [
      user("owner", "Alice", true, true),
      agent("owner", "Alice-Pi", "后端", true, "idle", "auto", true),
      user("busy", "Bob", true),
      agent("busy", "Bob-Pi", "数据库", true, "busy", "auto"),
      user("approval", "Carol", true),
      agent("approval", "Carol-Pi", "测试", true, "idle", "approval"),
      user("blocked", "Dave", true),
      agent("blocked", "Dave-Pi", "安全", true, "idle", "blocked", false),
      user("offline", "Eve", false),
      agent("offline", "Eve-Pi", "文档", false, "idle", "auto"),
      { ...user("removed", "Removed", false), removed: true },
      { ...agent("removed", "Removed-Pi", "已移出", false, "idle", "auto"), removed: true },
    ];

    const directory = participantContext(members);
    expect(directory.map((entry) => entry.user.name)).toEqual([
      "Alice", "Bob", "Carol", "Dave", "Eve",
    ]);
    expect(directory.map((entry) => entry.agent!.availability)).toEqual([
      "available", "busy", "approval_required", "unavailable", "offline",
    ]);
    expect(directory[0]).toMatchObject({
      user: { name: "Alice", isOwner: true, online: true },
      agent: {
        name: "Alice-Pi",
        description: "后端",
        activity: "idle",
        availability: "available",
      },
    });
    expect(JSON.stringify(directory)).not.toContain("proactive");
    expect(JSON.stringify(directory)).not.toContain("Removed");
  });
});

function user(key: string, name: string, online: boolean, isOwner = false): Member {
  return {
    memberId: `user:${key}`,
    clientId: key,
    stableSessionKey: key,
    type: "user",
    displayName: name,
    groupId: "g",
    online,
    isOwner,
  };
}

function agent(
  key: string,
  name: string,
  description: string,
  online: boolean,
  agentStatus: "idle" | "busy",
  agentPermission: "auto" | "approval" | "blocked",
  proactiveEnabled?: boolean,
): Member {
  return {
    memberId: `agent:${key}`,
    clientId: key,
    stableSessionKey: key,
    type: "agent",
    displayName: name,
    groupId: "g",
    online,
    agentStatus,
    agentPermission,
    agentDescription: description,
    proactiveEnabled,
  };
}
