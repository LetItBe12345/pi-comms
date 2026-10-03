import type {
  AgentCollaborationAvailability,
  GroupParticipantContext,
  Member,
} from "./types.js";

export function participantContext(members: Iterable<Member>): GroupParticipantContext[] {
  const pairs = new Map<string, { user?: Member; agent?: Member }>();
  for (const member of members) {
    if (member.removed) continue;
    const key = member.stableSessionKey ?? member.clientId;
    const pair = pairs.get(key) ?? {};
    pair[member.type] = member;
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .filter((pair): pair is { user: Member; agent?: Member } =>
      pair.user !== undefined
    )
    .map(({ user, agent }) => ({
      user: {
        name: user.displayName,
        isOwner: user.isOwner === true,
        online: user.online,
      },
      ...(agent === undefined ? {} : { agent: {
        name: agent.displayName,
        description: agent.agentDescription ?? "",
        online: agent.online,
        activity: agent.online
          ? agent.agentStatus ?? "idle" as const
          : "offline" as const,
        availability: availability(agent),
      } }),
    }))
    .sort((left, right) =>
      Number(right.user.isOwner) - Number(left.user.isOwner) ||
      left.user.name.localeCompare(right.user.name, "zh-CN")
    );
}

function availability(member: Member): AgentCollaborationAvailability {
  if (!member.online) return "offline";
  if (member.agentStatus === "busy") return "busy";
  if (member.agentPermission === "approval") return "approval_required";
  if (member.agentPermission === "blocked") return "unavailable";
  return "available";
}
