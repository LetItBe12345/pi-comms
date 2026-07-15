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
} from "../protocol.js";
import type { Group } from "../types.js";

export type AgentRequestStatus =
  | "pending"
  | "delivered"
  | "completed"
  | "failed"
  | "interrupted";

export interface FailedAgentRequest {
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

export class BrokerDatabase {
  readonly #db: Database.Database;

  constructor(readonly path: string) {
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

  groups(): Group[] {
    return this.#db
      .prepare(
        "SELECT group_id AS groupId, group_name AS groupName FROM groups ORDER BY created_at",
      )
      .all() as Group[];
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
  ): void {
    this.#db.transaction(() => {
      this.#insertMessage(message);
      this.#db
        .prepare(
          `INSERT INTO agent_requests (
             request_id, group_id, message_id, sender_id, sender_name,
             target_agent_id, target_agent_name, owner_user_name,
             online_members, text, chain_id, round, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
          JSON.stringify(request.onlineMembers),
          request.text,
          request.chainId,
          request.round,
          message.timestamp,
          message.timestamp,
        );
    })();
  }

  insertFailedAgentRequest(
    message: HistoryMessage,
    request: FailedAgentRequest,
  ): void {
    this.#db.transaction(() => {
      this.#insertMessage(message);
      this.#db
        .prepare(
          `INSERT INTO agent_requests (
             request_id, group_id, message_id, sender_id, sender_name,
             target_agent_id, target_agent_name, owner_user_name,
             online_members, text, chain_id, round, status, failure_reason,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'failed', ?, ?, ?)`,
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
          request.failureReason,
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

  completeRequest(requestId: string, answer: HistoryMessage): void {
    this.#db.transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = 'completed', result_text = ?, updated_at = ?
           WHERE request_id = ? AND status IN ('pending', 'delivered')`,
        )
        .run(answer.text, answer.timestamp, requestId);
      if (changed.changes !== 1) {
        throw new Error(`Agent 请求不可完成：${requestId}`);
      }
      this.#db
        .prepare(
          "UPDATE messages SET status = 'completed' WHERE request_id = ? AND kind IS NULL",
        )
        .run(requestId);
      this.#insertMessage(answer);
    })();
  }

  failRequest(
    requestId: string,
    reason: MessageFailureReason | AgentFailureReason,
  ): boolean {
    return this.#db.transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE agent_requests
           SET status = 'failed', failure_reason = ?, updated_at = ?
           WHERE request_id = ? AND status IN ('pending', 'delivered')`,
        )
        .run(reason, Date.now(), requestId);
      if (changed.changes !== 1) {
        return false;
      }
      this.#db
        .prepare(
          `UPDATE messages
           SET status = 'failed', failure_reason = ?
           WHERE request_id = ? AND kind IS NULL`,
        )
        .run(reason, requestId);
      return true;
    })();
  }

  recentMessages(groupId: string, limit = 100): HistoryMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT
             message_id AS messageId, group_id AS groupId,
             sender_id AS senderId, sender_name AS senderName,
             sender_type AS senderType, text, mention_ids AS mentionIds,
             timestamp, status, request_id AS requestId, chain_id AS chainId,
             round, failure_reason AS failureReason, kind
           FROM messages
           WHERE group_id = ?
           ORDER BY timestamp DESC, rowid DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`,
      )
      .all(groupId, limit) as Array<
      Omit<HistoryMessage, "mentionIds"> & { mentionIds: string }
    >;
    return rows.map((row) => ({
      ...row,
      mentionIds: JSON.parse(row.mentionIds) as string[],
      ...(row.requestId === null ? { requestId: undefined } : {}),
      ...(row.chainId === null ? { chainId: undefined } : {}),
      ...(row.round === null ? { round: undefined } : {}),
      ...(row.failureReason === null ? { failureReason: undefined } : {}),
      ...(row.kind === null ? { kind: undefined } : {}),
    }));
  }

  #insertMessage(message: HistoryMessage): void {
    this.#db
      .prepare(
        `INSERT INTO messages (
           message_id, group_id, sender_id, sender_name, sender_type, text,
           mention_ids, timestamp, status, request_id, chain_id, round,
           failure_reason, kind
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  #interruptActiveRequests(): void {
    this.#db.transaction(() => {
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
    if (version > 1) {
      throw new Error(`数据库版本不受支持：${version}`);
    }
    if (version === 1) {
      return;
    }
    this.#db.exec(`
      BEGIN;
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
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
        status TEXT NOT NULL CHECK (status IN ('sent', 'processing', 'completed', 'failed', 'interrupted')),
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'completed', 'failed', 'interrupted')),
        result_text TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX messages_group_time_idx
        ON messages(group_id, timestamp DESC);
      CREATE INDEX agent_requests_group_status_idx
        ON agent_requests(group_id, status, updated_at DESC);
      CREATE INDEX agent_requests_chain_round_idx
        ON agent_requests(chain_id, round);
      PRAGMA user_version = 1;
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
  return name.toLocaleLowerCase();
}
