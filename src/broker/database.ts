import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AgentFailureReason,
  AgentRequestPayload,
  ChatMessagePayload,
  HistoryMessage,
  MessageFailureReason,
  MessageStatus,
  PausedChainPayload,
} from "../protocol.js";
import type { Group, GroupSettings, GroupVisibility } from "../types.js";
import { createSessionKey, type SessionKey } from "../session-key.js";
import { loadOrCreateDeviceId } from "../device-identity.js";

export type AgentRequestStatus =
  | "awaiting_approval"
  | "pending"
  | "delivered"
  | "completed"
  | "failed"
  | "interrupted"
  | "rejected"
  | "blocked"
  | "invalid";

export interface FailedAgentRequest {
  initiatorSessionKey: SessionKey;
  requestId: string;
  groupId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  targetAgentId?: string;
  targetAgentName: string;
  ownerUserName?: string;
  text: string;
  chainId: string;
  round: number;
  failureReason: MessageFailureReason;
}

export interface AgentChainContext {
  initiatorSessionKey: SessionKey;
  initiatorName: string;
  participants: string[];
  roundLimit: number;
}

export interface StoredPausedChain extends PausedChainPayload {
  messageId: string;
  initiatorSessionKey: SessionKey;
  targetAgentId: string;
}

export interface StoredGroup extends GroupSettings {
  ownerSessionKey: string;
  ownerCredentialHash: string;
  inviteCodeHash?: string;
}

export interface StoredMembership {
  groupId: string;
  sessionKey: SessionKey;
  userName: string;
  agentName: string;
  credentialHash: string;
  status: "active" | "removed";
  createdAt: number;
  lastActiveAt: number;
}

export class BrokerDatabase {
  readonly #db: Database.Database;

  constructor(
    readonly path: string,
    readonly migrationDeviceId: string = loadOrCreateDeviceId(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    try {
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = FULL");
      this.#db.pragma("foreign_keys = ON");
      this.#migrate();
      this.#interruptActiveRequests();
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // 没有活动事务时无需处理。
      }
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  configuration(): { journalMode: string; synchronous: number } {
    return {
      journalMode: this.#db.pragma("journal_mode", { simple: true }) as string,
      synchronous: this.#db.pragma("synchronous", { simple: true }) as number,
    };
  }

  brokerId(): string {
    const row = this.#db
      .prepare("SELECT value FROM broker_metadata WHERE key = 'broker_id'")
      .get() as { value: string } | undefined;
    if (row !== undefined) return row.value;
    const brokerId = randomUUID();
    this.#db
      .prepare("INSERT INTO broker_metadata (key, value) VALUES ('broker_id', ?)")
      .run(brokerId);
    return brokerId;
  }

  groups(): Group[] {
    return this.#db
      .prepare(
        "SELECT group_id AS groupId, group_name AS groupName FROM groups ORDER BY created_at",
      )
      .all() as Group[];
  }

  storedGroups(): StoredGroup[] {
    return this.#db.prepare(
      `SELECT group_id AS groupId, group_name AS groupName,
              owner_session_key AS ownerSessionKey,
              owner_credential_hash AS ownerCredentialHash,
              invite_code_hash AS inviteCodeHash,
              visibility,
              keep_available_when_empty AS keepAvailableWhenEmpty,
              open_at_login AS openAtLogin
         FROM groups
        ORDER BY created_at`,
    ).all().map((row) => mapStoredGroup(row as StoredGroupRow));
  }

  storedGroup(groupId: string): StoredGroup | undefined {
    const row = this.#db.prepare(
      `SELECT group_id AS groupId, group_name AS groupName,
              owner_session_key AS ownerSessionKey,
              owner_credential_hash AS ownerCredentialHash,
              invite_code_hash AS inviteCodeHash,
              visibility,
              keep_available_when_empty AS keepAvailableWhenEmpty,
              open_at_login AS openAtLogin
         FROM groups
        WHERE group_id = ?`,
    ).get(groupId) as StoredGroupRow | undefined;
    return row === undefined ? undefined : mapStoredGroup(row);
  }

  insertGroup(group: Group): void {
    this.#db
      .prepare(
        `INSERT INTO groups (group_id, group_name, normalized_name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        group.groupId,
        group.groupName,
        normalizeName(group.groupName),
        Date.now(),
      );
  }

  insertOwnedGroup(
    group: Group,
    options: {
      ownerSessionKey: SessionKey;
      ownerCredentialHash: string;
      visibility: GroupVisibility;
      inviteCodeHash?: string;
      userName: string;
      agentName: string;
      membershipCredentialHash: string;
    },
  ): void {
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db.prepare(
        `INSERT INTO groups (
           group_id, group_name, normalized_name, owner_session_key,
           owner_credential_hash, invite_code_hash, visibility,
           keep_available_when_empty, open_at_login, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      ).run(
        group.groupId,
        group.groupName,
        normalizeName(group.groupName),
        options.ownerSessionKey,
        options.ownerCredentialHash,
        options.inviteCodeHash ?? null,
        options.visibility,
        now,
        now,
      );
      this.#insertMembership({
        groupId: group.groupId,
        sessionKey: options.ownerSessionKey,
        userName: options.userName,
        agentName: options.agentName,
        credentialHash: options.membershipCredentialHash,
        status: "active",
        createdAt: now,
        lastActiveAt: now,
      });
    })();
  }

  membership(groupId: string, sessionKey: SessionKey): StoredMembership | undefined {
    const row = this.#db.prepare(
      `SELECT group_id AS groupId, session_key AS sessionKey,
              user_name AS userName, agent_name AS agentName,
              credential_hash AS credentialHash, status,
              created_at AS createdAt, last_active_at AS lastActiveAt
         FROM group_memberships
        WHERE group_id = ? AND session_key = ?`,
    ).get(groupId, sessionKey) as StoredMembership | undefined;
    return row;
  }

  membershipByCredential(
    groupId: string,
    credentialHash: string,
  ): StoredMembership | undefined {
    return this.#db.prepare(
      `SELECT group_id AS groupId, session_key AS sessionKey,
              user_name AS userName, agent_name AS agentName,
              credential_hash AS credentialHash, status,
              created_at AS createdAt, last_active_at AS lastActiveAt
         FROM group_memberships
        WHERE group_id = ? AND credential_hash = ?`,
    ).get(groupId, credentialHash) as StoredMembership | undefined;
  }

  memberships(groupId: string): StoredMembership[] {
    return this.#db.prepare(
      `SELECT group_id AS groupId, session_key AS sessionKey,
              user_name AS userName, agent_name AS agentName,
              credential_hash AS credentialHash, status,
              created_at AS createdAt, last_active_at AS lastActiveAt
         FROM group_memberships
        WHERE group_id = ?
        ORDER BY created_at`,
    ).all(groupId) as StoredMembership[];
  }

  insertMembership(
    membership: Omit<StoredMembership, "createdAt" | "lastActiveAt" | "status">,
  ): void {
    const now = Date.now();
    this.#insertMembership({
      ...membership,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    });
  }

  touchMembership(groupId: string, sessionKey: SessionKey): void {
    this.#db.prepare(
      `UPDATE group_memberships
          SET last_active_at = ?
        WHERE group_id = ? AND session_key = ? AND status = 'active'`,
    ).run(Date.now(), groupId, sessionKey);
  }

  deleteMembership(groupId: string, sessionKey: SessionKey): void {
    this.#db.prepare(
      "DELETE FROM group_memberships WHERE group_id = ? AND session_key = ?",
    ).run(groupId, sessionKey);
  }

  setMembershipStatus(
    groupId: string,
    sessionKey: SessionKey,
    status: "active" | "removed",
  ): void {
    this.#db.prepare(
      "UPDATE group_memberships SET status = ?, last_active_at = ? WHERE group_id = ? AND session_key = ?",
    ).run(status, Date.now(), groupId, sessionKey);
  }

  isMemberNameAvailable(
    groupId: string,
    userName: string,
    agentName: string,
    exceptSessionKey?: SessionKey,
  ): boolean {
    const names = [normalizeName(userName), normalizeName(agentName)];
    const row = this.#db.prepare(
      `SELECT 1
         FROM group_memberships
        WHERE group_id = ?
          AND status = 'active'
          AND session_key <> ?
          AND (
            normalized_user_name IN (?, ?)
            OR normalized_agent_name IN (?, ?)
          )
        LIMIT 1`,
    ).get(groupId, exceptSessionKey ?? "", ...names, ...names);
    return row === undefined;
  }

  updateGroupInvite(
    groupId: string,
    visibility: GroupVisibility,
    inviteCodeHash?: string,
  ): void {
    this.#db.prepare(
      `UPDATE groups
          SET visibility = ?, invite_code_hash = ?,
              keep_available_when_empty = CASE WHEN ? = 'local' THEN 0 ELSE keep_available_when_empty END,
              open_at_login = CASE WHEN ? = 'local' THEN 0 ELSE open_at_login END,
              updated_at = ?
        WHERE group_id = ?`,
    ).run(
      visibility,
      inviteCodeHash ?? null,
      visibility,
      visibility,
      Date.now(),
      groupId,
    );
  }

  updateGroupAvailability(
    groupId: string,
    keepAvailableWhenEmpty: boolean,
    openAtLogin: boolean,
  ): void {
    this.#db.prepare(
      `UPDATE groups
          SET keep_available_when_empty = ?, open_at_login = ?, updated_at = ?
        WHERE group_id = ?`,
    ).run(
      keepAvailableWhenEmpty ? 1 : 0,
      openAtLogin ? 1 : 0,
      Date.now(),
      groupId,
    );
  }

  updateGroupName(groupId: string, groupName: string): void {
    this.#db.prepare(
      "UPDATE groups SET group_name = ?, normalized_name = ?, updated_at = ? WHERE group_id = ?",
    ).run(groupName, normalizeName(groupName), Date.now(), groupId);
  }

  updateOwner(
    groupId: string,
    ownerSessionKey: SessionKey,
    ownerCredentialHash: string,
  ): void {
    this.#db.prepare(
      `UPDATE groups
          SET owner_session_key = ?, owner_credential_hash = ?, updated_at = ?
        WHERE group_id = ?`,
    ).run(ownerSessionKey, ownerCredentialHash, Date.now(), groupId);
  }

  deleteGroup(groupId: string): void {
    this.#db.transaction(() => {
      const group = this.#db.prepare(
        "SELECT group_name AS groupName FROM groups WHERE group_id = ?",
      ).get(groupId) as { groupName: string } | undefined;
      if (group !== undefined) {
        this.#db.prepare(
          `INSERT OR REPLACE INTO group_tombstones
             (group_id, session_key, group_name, created_at)
           SELECT group_id, session_key, ?, ?
             FROM group_memberships
            WHERE group_id = ?`,
        ).run(group.groupName, Date.now(), groupId);
      }
      this.#db.prepare("DELETE FROM paused_chains WHERE group_id = ?").run(groupId);
      this.#db.prepare("DELETE FROM agent_requests WHERE group_id = ?").run(groupId);
      this.#db.prepare("DELETE FROM messages WHERE group_id = ?").run(groupId);
      this.#db.prepare("DELETE FROM group_memberships WHERE group_id = ?").run(groupId);
      this.#db.prepare("DELETE FROM groups WHERE group_id = ?").run(groupId);
    })();
  }

  consumeGroupTombstone(
    groupId: string,
    sessionKey: SessionKey,
  ): string | undefined {
    return this.#db.transaction(() => {
      const row = this.#db.prepare(
        `SELECT group_name AS groupName
           FROM group_tombstones
          WHERE group_id = ? AND session_key = ?`,
      ).get(groupId, sessionKey) as { groupName: string } | undefined;
      if (row !== undefined) {
        this.#db.prepare(
          "DELETE FROM group_tombstones WHERE group_id = ? AND session_key = ?",
        ).run(groupId, sessionKey);
      }
      return row?.groupName;
    })();
  }

  #insertMembership(membership: StoredMembership): void {
    this.#db.prepare(
      `INSERT INTO group_memberships (
         group_id, session_key, user_name, normalized_user_name,
         agent_name, normalized_agent_name, credential_hash, status,
         created_at, last_active_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      membership.groupId,
      membership.sessionKey,
      membership.userName,
      normalizeName(membership.userName),
      membership.agentName,
      normalizeName(membership.agentName),
      membership.credentialHash,
      membership.status,
      membership.createdAt,
      membership.lastActiveAt,
    );
  }

  hasMessage(messageId: string): boolean {
    return this.#db
      .prepare("SELECT 1 FROM messages WHERE message_id = ?")
      .get(messageId) !== undefined;
  }

  requestStatus(requestId: string): AgentRequestStatus | undefined {
    const row = this.#db
      .prepare("SELECT status FROM agent_requests WHERE request_id = ?")
      .get(requestId) as { status: AgentRequestStatus } | undefined;
    return row?.status;
  }

  insertMessage(message: HistoryMessage): void {
    this.#insertMessage(message);
  }

  insertAgentRequest(
    message: HistoryMessage,
    request: AgentRequestPayload,
    awaitingApproval = false,
    context?: AgentChainContext,
  ): void {
    this.#db.transaction(() => {
      this.#insertMessage(message);
      this.#db
        .prepare(
          `INSERT INTO agent_requests (
             request_id, group_id, message_id, sender_id, sender_name,
             target_agent_id, target_agent_name, owner_user_name,
             sender_type, sender_owner_user_name, online_members, text,
             chain_id, round, status, initiator_session_key, initiator_name,
             participants, round_limit, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          request.groupId,
          message.messageId,
          request.senderId,
          request.senderName,
          request.targetAgentId,
          request.targetAgentName,
          request.ownerUserName,
          request.senderType ?? "user",
          request.senderOwnerUserName ?? null,
          JSON.stringify(request.onlineMembers),
          request.text,
          request.chainId,
          request.round,
          awaitingApproval ? "awaiting_approval" : "pending",
          context?.initiatorSessionKey ?? createSessionKey(this.migrationDeviceId, request.requestId),
          context?.initiatorName ?? request.senderName,
          JSON.stringify(context?.participants ?? [request.targetAgentName]),
          context?.roundLimit ?? 10,
          message.timestamp,
          message.timestamp,
        );
    })();
  }

  completeAndRoute(
    requestId: string,
    answer: HistoryMessage,
    next:
      | {
          request: AgentRequestPayload;
          awaitingApproval: boolean;
          context: AgentChainContext;
        }
      | { paused: StoredPausedChain }
      | undefined,
  ): void {
    this.#db.transaction(() => {
      this.#completeRequest(requestId, answer);
      if (next === undefined) return;
      if ("paused" in next) {
        const paused = next.paused;
        this.#db.prepare(
          `INSERT INTO paused_chains (
             chain_id, group_id, message_id, initiator_session_key,
             initiator_name, source_agent_name, target_agent_id,
             source_owner_user_name, target_agent_name, text, next_round, round_limit,
             participants, paused_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          paused.chainId,
          paused.groupId,
          paused.messageId,
          paused.initiatorSessionKey,
          paused.initiatorName,
          paused.sourceAgentName,
          paused.targetAgentId,
          paused.sourceOwnerUserName,
          paused.targetAgentName,
          paused.text,
          paused.nextRound,
          paused.roundLimit,
          JSON.stringify(paused.participants),
          paused.pausedAt,
        );
        return;
      }
      this.#insertRequest(next.request, answer.messageId, answer.timestamp,
        next.awaitingApproval, next.context);
    })();
  }

  pausedChains(sessionKey: SessionKey, groupId: string): StoredPausedChain[] {
    const rows = this.#db.prepare(
      `SELECT chain_id AS chainId, group_id AS groupId, message_id AS messageId,
              initiator_session_key AS initiatorSessionKey,
              initiator_name AS initiatorName, source_agent_name AS sourceAgentName,
              source_owner_user_name AS sourceOwnerUserName,
              target_agent_id AS targetAgentId, target_agent_name AS targetAgentName,
              text, next_round AS nextRound, round_limit AS roundLimit,
              participants, paused_at AS pausedAt
       FROM paused_chains
       WHERE initiator_session_key = ? AND group_id = ?
       ORDER BY paused_at DESC`,
    ).all(sessionKey, groupId) as Array<Omit<StoredPausedChain, "participants"> & { participants: string }>;
    return rows.map((row) => ({ ...row, participants: JSON.parse(row.participants) as string[] }));
  }

  pausedChain(chainId: string): StoredPausedChain | undefined {
    const row = this.#db.prepare(
      `SELECT chain_id AS chainId, group_id AS groupId, message_id AS messageId,
              initiator_session_key AS initiatorSessionKey,
              initiator_name AS initiatorName, source_agent_name AS sourceAgentName,
              source_owner_user_name AS sourceOwnerUserName,
              target_agent_id AS targetAgentId, target_agent_name AS targetAgentName,
              text, next_round AS nextRound, round_limit AS roundLimit,
              participants, paused_at AS pausedAt
       FROM paused_chains WHERE chain_id = ?`,
    ).get(chainId) as (Omit<StoredPausedChain, "participants"> & { participants: string }) | undefined;
    return row === undefined ? undefined : { ...row, participants: JSON.parse(row.participants) as string[] };
  }

  resumePausedChain(
    paused: StoredPausedChain,
    request: AgentRequestPayload,
    awaitingApproval: boolean,
    context: AgentChainContext,
    message: HistoryMessage,
  ): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM paused_chains WHERE chain_id = ?").run(paused.chainId);
      this.#updateMessageRoute(message);
      this.#insertRequest(request, paused.messageId, Date.now(), awaitingApproval, context);
    })();
  }

  resolvePausedChain(chainId: string, message: HistoryMessage): boolean {
    return this.#db.transaction(() => {
      const removed = this.#db.prepare("DELETE FROM paused_chains WHERE chain_id = ?").run(chainId);
      if (removed.changes !== 1) return false;
      this.#updateMessageRoute(message);
      return true;
    })();
  }

  message(messageId: string): HistoryMessage | undefined {
    return this.#readMessages("WHERE message_id = ?", [messageId])[0];
  }

  insertFailedAgentRequest(
    message: HistoryMessage,
    request: FailedAgentRequest,
  ): void {
    const status =
      request.failureReason === "target_blocked" ? "blocked" :
      request.failureReason === "request_rejected" ? "rejected" :
      request.failureReason === "request_invalid" ? "invalid" : "failed";
    this.#db.transaction(() => {
      this.#insertMessage(message);
      this.#db
        .prepare(
          `INSERT INTO agent_requests (
             request_id, group_id, message_id, sender_id, sender_name,
             target_agent_id, target_agent_name, owner_user_name,
             online_members, text, chain_id, round, status, failure_reason,
             initiator_session_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          request.groupId,
          request.messageId,
          request.senderId,
          request.senderName,
          request.targetAgentId ?? null,
          request.targetAgentName,
          request.ownerUserName ?? null,
          request.text,
          request.chainId,
          request.round,
          status,
          request.failureReason,
          request.initiatorSessionKey,
          message.timestamp,
          message.timestamp,
        );
    })();
  }

  markDelivered(requestId: string): void {
    this.#db
      .prepare(
        `UPDATE agent_requests
         SET status = 'delivered', updated_at = ?
         WHERE request_id = ? AND status = 'pending'`,
      )
      .run(Date.now(), requestId);
  }

  approveRequest(requestId: string): boolean {
    return this.#db.transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = 'pending', updated_at = ?
           WHERE request_id = ? AND status = 'awaiting_approval'`,
        )
        .run(Date.now(), requestId);
      if (changed.changes !== 1) return false;
      this.#db
        .prepare(
          `UPDATE messages
           SET status = CASE WHEN kind IS NULL THEN 'queued' ELSE status END,
               route_status = CASE WHEN kind = 'agent' THEN 'queued' ELSE route_status END
           WHERE message_id = (SELECT message_id FROM agent_requests WHERE request_id = ?)`,
        )
        .run(requestId);
      return true;
    })();
  }

  rejectRequest(requestId: string): boolean {
    return this.#finishRequest(requestId, "rejected", "request_rejected", [
      "awaiting_approval",
    ]);
  }

  completeRequest(requestId: string, answer: HistoryMessage): void {
    this.#db.transaction(() => this.#completeRequest(requestId, answer))();
  }

  failRequest(
    requestId: string,
    reason: MessageFailureReason | AgentFailureReason,
  ): boolean {
    const status =
      reason === "target_blocked" ? "blocked" :
      reason === "request_rejected" ? "rejected" :
      reason === "request_invalid" ? "invalid" : "failed";
    return this.#finishRequest(requestId, status, reason, [
      "awaiting_approval",
      "pending",
      "delivered",
    ]);
  }

  #finishRequest(
    requestId: string,
    status: AgentRequestStatus,
    reason: MessageFailureReason | AgentFailureReason,
    from: AgentRequestStatus[],
  ): boolean {
    return this.#db.transaction(() => {
      const placeholders = from.map(() => "?").join(", ");
      const changed = this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = ?, failure_reason = ?, updated_at = ?
           WHERE request_id = ? AND status IN (${placeholders})`,
        )
        .run(status, reason, Date.now(), requestId, ...from);
      if (changed.changes !== 1) return false;
      this.#db
        .prepare(
          `UPDATE messages
           SET status = CASE WHEN kind IS NULL THEN 'failed' ELSE status END,
               failure_reason = CASE WHEN kind IS NULL THEN ? ELSE failure_reason END,
               route_status = CASE WHEN kind = 'agent' THEN 'failed' ELSE route_status END,
               route_failure_reason = CASE WHEN kind = 'agent' THEN ? ELSE route_failure_reason END
           WHERE message_id = (SELECT message_id FROM agent_requests WHERE request_id = ?)`,
        )
        .run(reason, reason, requestId);
      return true;
    })();
  }

  recentMessages(groupId: string, limit = 100): HistoryMessage[] {
    return this.#readMessages(
      `WHERE message_id IN (
         SELECT message_id FROM (
           SELECT
             message_id
           FROM messages
           WHERE group_id = ?
           ORDER BY timestamp DESC, rowid DESC
           LIMIT ?
         )
       ) ORDER BY timestamp ASC, rowid ASC`,
      [groupId, limit],
    );
  }

  #insertRequest(
    request: AgentRequestPayload,
    messageId: string,
    timestamp: number,
    awaitingApproval: boolean,
    context: AgentChainContext,
  ): void {
    this.#db.prepare(
      `INSERT INTO agent_requests (
         request_id, group_id, message_id, sender_id, sender_name,
         target_agent_id, target_agent_name, owner_user_name,
         sender_type, sender_owner_user_name, online_members, text,
         chain_id, round, status, initiator_session_key, initiator_name,
         participants, round_limit, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      request.requestId, request.groupId, messageId, request.senderId,
      request.senderName, request.targetAgentId, request.targetAgentName,
      request.ownerUserName, request.senderType ?? "user",
      request.senderOwnerUserName ?? null, JSON.stringify(request.onlineMembers),
      request.text, request.chainId, request.round,
      awaitingApproval ? "awaiting_approval" : "pending",
      context.initiatorSessionKey, context.initiatorName,
      JSON.stringify(context.participants), context.roundLimit,
      timestamp, timestamp,
    );
  }

  #completeRequest(requestId: string, answer: HistoryMessage): void {
    const changed = this.#db.prepare(
      `UPDATE agent_requests
       SET status = 'completed', result_text = ?, updated_at = ?
       WHERE request_id = ? AND status IN ('pending', 'delivered')`,
    ).run(answer.text, answer.timestamp, requestId);
    if (changed.changes !== 1) throw new Error(`Agent 请求不可完成：${requestId}`);
    this.#db.prepare(
      `UPDATE messages
       SET status = CASE WHEN request_id = ? AND kind IS NULL THEN 'completed' ELSE status END,
           route_status = CASE WHEN route_request_id = ? THEN 'completed' ELSE route_status END
       WHERE request_id = ? OR route_request_id = ?`,
    ).run(requestId, requestId, requestId, requestId);
    this.#insertMessage(answer);
  }

  #updateMessageRoute(message: HistoryMessage): void {
    this.#db.prepare(
      `UPDATE messages SET route_request_id = ?, route_status = ?,
         route_failure_reason = ?, route_target_name = ?, next_round = ?
       WHERE message_id = ?`,
    ).run(
      message.routeRequestId ?? null,
      message.routeStatus ?? null,
      message.routeFailureReason ?? null,
      message.routeTargetName ?? null,
      message.nextRound ?? null,
      message.messageId,
    );
  }

  #readMessages(where: string, params: unknown[]): HistoryMessage[] {
    const rows = this.#db.prepare(
      `SELECT message_id AS messageId, group_id AS groupId,
              sender_id AS senderId, sender_name AS senderName,
              sender_type AS senderType, text, mention_ids AS mentionIds,
              timestamp, status, request_id AS requestId, chain_id AS chainId,
              round, failure_reason AS failureReason, kind,
              route_request_id AS routeRequestId, route_status AS routeStatus,
              route_failure_reason AS routeFailureReason,
              route_target_name AS routeTargetName, next_round AS nextRound
       FROM messages ${where}`,
    ).all(...params) as Array<Omit<HistoryMessage, "mentionIds"> & { mentionIds: string }>;
    return rows.map((row) => {
      const result = { ...row, mentionIds: JSON.parse(row.mentionIds) as string[] } as HistoryMessage;
      for (const key of ["requestId", "chainId", "round", "failureReason", "kind",
        "routeRequestId", "routeStatus", "routeFailureReason", "routeTargetName", "nextRound"] as const) {
        if (result[key] === null) delete result[key];
      }
      return result;
    });
  }

  #insertMessage(message: HistoryMessage): void {
    this.#db
      .prepare(
        `INSERT INTO messages (
           message_id, group_id, sender_id, sender_name, sender_type, text,
           mention_ids, timestamp, status, request_id, chain_id, round,
           failure_reason, kind, route_request_id, route_status,
           route_failure_reason, route_target_name, next_round
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        message.groupId,
        message.senderId,
        message.senderName,
        message.senderType,
        message.text,
        JSON.stringify(message.mentionIds),
        message.timestamp,
        message.status,
        message.requestId ?? null,
        message.chainId ?? null,
        message.round ?? null,
        message.failureReason ?? null,
        message.kind ?? null,
        message.routeRequestId ?? null,
        message.routeStatus ?? null,
        message.routeFailureReason ?? null,
        message.routeTargetName ?? null,
        message.nextRound ?? null,
      );
  }

  #interruptActiveRequests(): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE messages
           SET status = 'failed', failure_reason = 'request_invalid'
           WHERE request_id IN (
             SELECT request_id FROM agent_requests
             WHERE status = 'awaiting_approval'
           ) AND kind IS NULL`,
        )
        .run();
      this.#db.prepare(
        `UPDATE messages SET route_status = 'failed', route_failure_reason = 'request_invalid'
         WHERE message_id IN (
           SELECT message_id FROM agent_requests WHERE status = 'awaiting_approval'
         ) AND kind = 'agent'`,
      ).run();
      this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = 'invalid', failure_reason = 'request_invalid', updated_at = ?
           WHERE status = 'awaiting_approval'`,
        )
        .run(Date.now());
      this.#db
        .prepare(
          `UPDATE messages
           SET status = 'interrupted', failure_reason = 'broker_restarted'
           WHERE request_id IN (
             SELECT request_id FROM agent_requests
             WHERE status IN ('pending', 'delivered')
           ) AND kind IS NULL`,
        )
        .run();
      this.#db.prepare(
        `UPDATE messages SET route_status = 'failed', route_failure_reason = 'broker_restarted'
         WHERE message_id IN (
           SELECT message_id FROM agent_requests WHERE status IN ('pending', 'delivered')
         ) AND kind = 'agent'`,
      ).run();
      this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = 'interrupted', failure_reason = 'broker_restarted', updated_at = ?
           WHERE status IN ('pending', 'delivered')`,
        )
        .run(Date.now());
    })();
  }

  #migrate(): void {
    const version = this.#db.pragma("user_version", { simple: true }) as number;
    if (version > 7) {
      throw new Error(`数据库版本不受支持：${version}`);
    }
    if (version === 7) {
      return;
    }
    if (version === 6) {
      this.#db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS group_tombstones (
          group_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          group_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (group_id, session_key)
        );
        PRAGMA user_version = 7;
        COMMIT;
      `);
      return;
    }
    if (version === 5) {
      const groupColumns = this.#db.prepare("PRAGMA table_info(groups)").all() as Array<{
        name: string;
      }>;
      if (groupColumns.some((column) => column.name === "owner_session_key")) {
        this.#db.pragma("user_version = 6");
        this.#migrate();
        return;
      }
      this.#db.exec(`
        BEGIN;
        ALTER TABLE groups ADD COLUMN owner_session_key TEXT NOT NULL DEFAULT '';
        ALTER TABLE groups ADD COLUMN owner_credential_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE groups ADD COLUMN invite_code_hash TEXT;
        ALTER TABLE groups ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local'
          CHECK (visibility IN ('local', 'nearby'));
        ALTER TABLE groups ADD COLUMN keep_available_when_empty INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE groups ADD COLUMN open_at_login INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE groups ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE group_memberships (
          group_id TEXT NOT NULL REFERENCES groups(group_id),
          session_key TEXT NOT NULL,
          user_name TEXT NOT NULL,
          normalized_user_name TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          normalized_agent_name TEXT NOT NULL,
          credential_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          PRIMARY KEY (group_id, session_key)
        );
        CREATE INDEX group_memberships_group_status_idx
          ON group_memberships(group_id, status, last_active_at DESC);
        PRAGMA user_version = 6;
        COMMIT;
      `);
      this.#migrate();
      return;
    }
    if (version === 4) {
      this.#db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS broker_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 5;
        COMMIT;
      `);
      this.#migrate();
      return;
    }
    if (version === 3) {
      this.#db.transaction(() => {
        this.#db.exec(`
          DROP INDEX paused_chains_owner_group_idx;
          ALTER TABLE agent_requests
            RENAME COLUMN initiator_session_id TO initiator_session_key;
          ALTER TABLE paused_chains
            RENAME COLUMN initiator_session_id TO initiator_session_key;
          CREATE INDEX paused_chains_owner_group_idx
            ON paused_chains(initiator_session_key, group_id, paused_at DESC);
        `);
        const requestRows = this.#db.prepare(
          "SELECT request_id AS id, initiator_session_key AS sessionId FROM agent_requests",
        ).all() as Array<{ id: string; sessionId: string }>;
        const updateRequest = this.#db.prepare(
          "UPDATE agent_requests SET initiator_session_key = ? WHERE request_id = ?",
        );
        for (const row of requestRows) {
          updateRequest.run(createSessionKey(this.migrationDeviceId, row.sessionId || row.id), row.id);
        }
        const pausedRows = this.#db.prepare(
          "SELECT chain_id AS id, initiator_session_key AS sessionId FROM paused_chains",
        ).all() as Array<{ id: string; sessionId: string }>;
        const updatePaused = this.#db.prepare(
          "UPDATE paused_chains SET initiator_session_key = ? WHERE chain_id = ?",
        );
        for (const row of pausedRows) {
          updatePaused.run(createSessionKey(this.migrationDeviceId, row.sessionId), row.id);
        }
        this.#db.pragma("user_version = 4");
      })();
      this.#migrate();
      return;
    }
    if (version === 2) {
      this.#db.exec(`
        BEGIN;
        ALTER TABLE messages ADD COLUMN route_request_id TEXT;
        ALTER TABLE messages ADD COLUMN route_status TEXT;
        ALTER TABLE messages ADD COLUMN route_failure_reason TEXT;
        ALTER TABLE messages ADD COLUMN route_target_name TEXT;
        ALTER TABLE messages ADD COLUMN next_round INTEGER;
        ALTER TABLE agent_requests ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE agent_requests ADD COLUMN sender_owner_user_name TEXT;
        ALTER TABLE agent_requests ADD COLUMN initiator_session_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE agent_requests ADD COLUMN initiator_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE agent_requests ADD COLUMN participants TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE agent_requests ADD COLUMN round_limit INTEGER NOT NULL DEFAULT 10;
        CREATE TABLE paused_chains (
          chain_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(group_id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
          initiator_session_id TEXT NOT NULL,
          initiator_name TEXT NOT NULL,
          source_agent_name TEXT NOT NULL,
          source_owner_user_name TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          target_agent_name TEXT NOT NULL,
          text TEXT NOT NULL,
          next_round INTEGER NOT NULL,
          round_limit INTEGER NOT NULL,
          participants TEXT NOT NULL,
          paused_at INTEGER NOT NULL
        );
        CREATE INDEX paused_chains_owner_group_idx
          ON paused_chains(initiator_session_id, group_id, paused_at DESC);
        PRAGMA user_version = 3;
        COMMIT;
      `);
      this.#migrate();
      return;
    }
    if (version === 1) {
      this.#db.pragma("foreign_keys = OFF");
      this.#db.exec(`
        BEGIN;
        ALTER TABLE messages RENAME TO messages_v1;
        ALTER TABLE agent_requests RENAME TO agent_requests_v1;

        CREATE TABLE messages (
          message_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(group_id),
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent')),
          text TEXT NOT NULL,
          mention_ids TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('sent', 'waiting_approval', 'queued', 'processing', 'completed', 'failed', 'interrupted')),
          request_id TEXT,
          chain_id TEXT,
          round INTEGER,
          failure_reason TEXT,
          kind TEXT CHECK (kind IS NULL OR kind = 'agent')
        );

        CREATE TABLE agent_requests (
          request_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(group_id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          target_agent_id TEXT,
          target_agent_name TEXT NOT NULL,
          owner_user_name TEXT,
          online_members TEXT NOT NULL,
          text TEXT NOT NULL,
          chain_id TEXT NOT NULL,
          round INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'pending', 'delivered', 'completed', 'failed', 'interrupted', 'rejected', 'blocked', 'invalid')),
          result_text TEXT,
          failure_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO messages SELECT * FROM messages_v1;
        INSERT INTO agent_requests SELECT * FROM agent_requests_v1;
        DROP TABLE agent_requests_v1;
        DROP TABLE messages_v1;
        CREATE INDEX messages_group_time_idx ON messages(group_id, timestamp DESC);
        CREATE INDEX agent_requests_group_status_idx ON agent_requests(group_id, status, updated_at DESC);
        CREATE INDEX agent_requests_chain_round_idx ON agent_requests(chain_id, round);
        PRAGMA user_version = 2;
        COMMIT;
      `);
      this.#db.pragma("foreign_keys = ON");
      this.#migrate();
      return;
    }
    this.#db.exec(`
      BEGIN;
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        owner_session_key TEXT NOT NULL DEFAULT '',
        owner_credential_hash TEXT NOT NULL DEFAULT '',
        invite_code_hash TEXT,
        visibility TEXT NOT NULL DEFAULT 'local'
          CHECK (visibility IN ('local', 'nearby')),
        keep_available_when_empty INTEGER NOT NULL DEFAULT 0,
        open_at_login INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE group_memberships (
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        session_key TEXT NOT NULL,
        user_name TEXT NOT NULL,
        normalized_user_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        normalized_agent_name TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_key)
      );

      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent')),
        text TEXT NOT NULL,
        mention_ids TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'waiting_approval', 'queued', 'processing', 'completed', 'failed', 'interrupted')),
        request_id TEXT,
        chain_id TEXT,
        round INTEGER,
        failure_reason TEXT,
        kind TEXT CHECK (kind IS NULL OR kind = 'agent'),
        route_request_id TEXT,
        route_status TEXT,
        route_failure_reason TEXT,
        route_target_name TEXT,
        next_round INTEGER
      );

      CREATE TABLE agent_requests (
        request_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        target_agent_id TEXT,
        target_agent_name TEXT NOT NULL,
          owner_user_name TEXT,
          sender_type TEXT NOT NULL DEFAULT 'user',
          sender_owner_user_name TEXT,
          online_members TEXT NOT NULL,
        text TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        round INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'pending', 'delivered', 'completed', 'failed', 'interrupted', 'rejected', 'blocked', 'invalid')),
          initiator_session_key TEXT NOT NULL DEFAULT '',
          initiator_name TEXT NOT NULL DEFAULT '',
          participants TEXT NOT NULL DEFAULT '[]',
          round_limit INTEGER NOT NULL DEFAULT 10,
          result_text TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE paused_chains (
        chain_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(group_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        initiator_session_key TEXT NOT NULL,
        initiator_name TEXT NOT NULL,
        source_agent_name TEXT NOT NULL,
        source_owner_user_name TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        target_agent_name TEXT NOT NULL,
        text TEXT NOT NULL,
        next_round INTEGER NOT NULL,
        round_limit INTEGER NOT NULL,
        participants TEXT NOT NULL,
        paused_at INTEGER NOT NULL
      );

      CREATE TABLE broker_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE group_tombstones (
        group_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        group_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_key)
      );

      CREATE INDEX messages_group_time_idx
        ON messages(group_id, timestamp DESC);
      CREATE INDEX agent_requests_group_status_idx
        ON agent_requests(group_id, status, updated_at DESC);
      CREATE INDEX agent_requests_chain_round_idx
        ON agent_requests(chain_id, round);
      CREATE INDEX paused_chains_owner_group_idx
        ON paused_chains(initiator_session_key, group_id, paused_at DESC);
      CREATE INDEX group_memberships_group_status_idx
        ON group_memberships(group_id, status, last_active_at DESC);
      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
}

export function historyMessage(
  messageId: string,
  timestamp: number,
  payload: ChatMessagePayload,
  status: MessageStatus,
  failureReason?: MessageFailureReason,
): HistoryMessage {
  return {
    messageId,
    timestamp,
    ...payload,
    status,
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

function normalizeName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

interface StoredGroupRow {
  groupId: string;
  groupName: string;
  ownerSessionKey: string;
  ownerCredentialHash: string;
  inviteCodeHash: string | null;
  visibility: GroupVisibility;
  keepAvailableWhenEmpty: number;
  openAtLogin: number;
}

function mapStoredGroup(row: StoredGroupRow): StoredGroup {
  return {
    groupId: row.groupId,
    groupName: row.groupName,
    ownerSessionKey: row.ownerSessionKey,
    ownerCredentialHash: row.ownerCredentialHash,
    ...(row.inviteCodeHash === null ? {} : { inviteCodeHash: row.inviteCodeHash }),
    visibility: row.visibility,
    inviteRequired: row.inviteCodeHash !== null,
    keepAvailableWhenEmpty: row.keepAvailableWhenEmpty === 1,
    openAtLogin: row.openAtLogin === 1,
  };
}
