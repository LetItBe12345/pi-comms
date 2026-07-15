export type MemberType = "user" | "agent";

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
}

export interface OnlineMember {
  displayName: string;
  type: MemberType;
}
