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
}

export interface OnlineMember {
  displayName: string;
  type: MemberType;
}
