export type MemberType = "user" | "agent";
export type AgentActivityStatus = "idle" | "busy";
export type AgentPermission = "auto" | "approval" | "blocked";

export interface Group {
  groupId: string;
  groupName: string;
}

export interface GroupSummary extends Group {
  onlineSessionCount: number;
}

export type GroupVisibility = "local" | "nearby";

export interface GroupSettings extends Group {
  visibility: GroupVisibility;
  keepAvailableWhenEmpty: boolean;
  openAtLogin: boolean;
}

export interface GroupMembership {
  groupId: string;
  sessionKey: string;
  userName: string;
  agentName: string;
  isOwner: boolean;
  removed: boolean;
  lastActiveAt: number;
}

export interface Member {
  memberId: string;
  clientId: string;
  type: MemberType;
  displayName: string;
  groupId: string;
  online: boolean;
  agentStatus?: AgentActivityStatus;
  agentPermission?: AgentPermission;
  pendingApprovalCount?: number;
  isOwner?: boolean;
  stableSessionKey?: string;
  removed?: boolean;
}

export interface OnlineMember {
  displayName: string;
  type: MemberType;
}
