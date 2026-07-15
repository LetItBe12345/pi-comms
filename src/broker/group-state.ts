import { randomUUID } from "node:crypto";
import type { Group, GroupSummary, Member } from "../types.js";

export type GroupStateErrorCode =
  | "group_not_found"
  | "group_name_conflict"
  | "member_name_conflict"
  | "invalid_name"
  | "already_in_group"
  | "not_in_group";

export class GroupStateError extends Error {
  constructor(
    readonly code: GroupStateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Membership {
  groupId: string;
  user: Member;
  agent: Member;
}

interface GroupRecord extends Group {
  memberships: Map<string, Membership>;
}

export class GroupState {
  readonly #groups = new Map<string, GroupRecord>();
  readonly #memberships = new Map<string, Membership>();

  constructor(initialGroups: Group[] = []) {
    for (const group of initialGroups) {
      this.#groups.set(group.groupId, { ...group, memberships: new Map() });
    }
  }

  createGroup(
    clientId: string,
    groupName: string,
    userName: string,
    agentName: string,
    groupId = randomUUID(),
  ): Membership {
    this.#ensureNotJoined(clientId);
    validateDisplayName(groupName);
    this.#validateMemberNames(userName, agentName);
    if (
      [...this.#groups.values()].some(
        (group) => normalizeName(group.groupName) === normalizeName(groupName),
      )
    ) {
      throw new GroupStateError("group_name_conflict", "群组名称已存在");
    }

    const group: GroupRecord = {
      groupId,
      groupName,
      memberships: new Map(),
    };
    this.#groups.set(group.groupId, group);
    return this.#join(group, clientId, userName, agentName);
  }

  removeGroup(groupId: string): void {
    const group = this.#groups.get(groupId);
    if (group !== undefined && group.memberships.size === 0) {
      this.#groups.delete(groupId);
    }
  }

  joinGroup(
    clientId: string,
    groupId: string,
    userName: string,
    agentName: string,
  ): Membership {
    this.#ensureNotJoined(clientId);
    const group = this.#groups.get(groupId);
    if (group === undefined) {
      throw new GroupStateError("group_not_found", "群组不存在");
    }
    this.#validateMemberNames(userName, agentName);
    const requested = new Set([normalizeName(userName), normalizeName(agentName)]);
    for (const membership of group.memberships.values()) {
      if (
        requested.has(normalizeName(membership.user.displayName)) ||
        requested.has(normalizeName(membership.agent.displayName))
      ) {
        throw new GroupStateError("member_name_conflict", "成员名称已被使用");
      }
    }
    return this.#join(group, clientId, userName, agentName);
  }

  leaveGroup(clientId: string): Membership {
    const membership = this.#memberships.get(clientId);
    if (membership === undefined) {
      throw new GroupStateError("not_in_group", "当前 Session 尚未加入群组");
    }
    this.#memberships.delete(clientId);
    this.#groups.get(membership.groupId)?.memberships.delete(clientId);
    return membership;
  }

  removeIfJoined(clientId: string): Membership | undefined {
    if (!this.#memberships.has(clientId)) {
      return undefined;
    }
    return this.leaveGroup(clientId);
  }

  setOnline(clientId: string, online: boolean): Member[] {
    const membership = this.#memberships.get(clientId);
    if (membership === undefined) {
      return [];
    }
    membership.user.online = online;
    membership.agent.online = online;
    return [membership.user, membership.agent];
  }

  groupForClient(clientId: string): Group | undefined {
    const membership = this.#memberships.get(clientId);
    const group =
      membership === undefined ? undefined : this.#groups.get(membership.groupId);
    return group === undefined
      ? undefined
      : { groupId: group.groupId, groupName: group.groupName };
  }

  membershipForClient(clientId: string): Membership | undefined {
    return this.#memberships.get(clientId);
  }

  onlineMembers(groupId: string): Member[] {
    const group = this.#groups.get(groupId);
    if (group === undefined) {
      return [];
    }
    return [...group.memberships.values()]
      .flatMap((membership) => [membership.user, membership.agent])
      .filter((member) => member.online)
      .map((member) => ({ ...member }));
  }

  onlineClientIds(groupId: string): string[] {
    const group = this.#groups.get(groupId);
    if (group === undefined) {
      return [];
    }
    return [...group.memberships.values()]
      .filter((membership) => membership.user.online)
      .map((membership) => membership.user.clientId);
  }

  findMemberByName(groupId: string, displayName: string): Member | undefined {
    const group = this.#groups.get(groupId);
    if (group === undefined) {
      return undefined;
    }
    const expected = normalizeName(displayName);
    for (const membership of group.memberships.values()) {
      for (const member of [membership.user, membership.agent]) {
        if (normalizeName(member.displayName) === expected) {
          return member;
        }
      }
    }
    return undefined;
  }

  summaries(): GroupSummary[] {
    return [...this.#groups.values()].map((group) => ({
      groupId: group.groupId,
      groupName: group.groupName,
      onlineSessionCount: [...group.memberships.values()].filter(
        (membership) => membership.user.online,
      ).length,
    }));
  }

  #ensureNotJoined(clientId: string): void {
    if (this.#memberships.has(clientId)) {
      throw new GroupStateError("already_in_group", "当前 Session 已加入群组");
    }
  }

  #validateMemberNames(userName: string, agentName: string): void {
    validateDisplayName(userName);
    validateDisplayName(agentName);
    if (normalizeName(userName) === normalizeName(agentName)) {
      throw new GroupStateError(
        "member_name_conflict",
        "用户名称与 Agent 名称不能相同",
      );
    }
  }

  #join(
    group: GroupRecord,
    clientId: string,
    userName: string,
    agentName: string,
  ): Membership {
    const membership: Membership = {
      groupId: group.groupId,
      user: {
        memberId: `user:${clientId}`,
        clientId,
        type: "user",
        displayName: userName,
        groupId: group.groupId,
        online: true,
      },
      agent: {
        memberId: `agent:${clientId}`,
        clientId,
        type: "agent",
        displayName: agentName,
        groupId: group.groupId,
        online: true,
      },
    };
    group.memberships.set(clientId, membership);
    this.#memberships.set(clientId, membership);
    return membership;
  }
}

export function validateDisplayName(name: string): void {
  const length = [...name].length;
  if (
    length < 1 ||
    length > 24 ||
    !/^[\p{Script=Han}A-Za-z0-9_-]+$/u.test(name)
  ) {
    throw new GroupStateError(
      "invalid_name",
      "名称须为 1～24 个中文、英文、数字、_ 或 -",
    );
  }
}

function normalizeName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}
