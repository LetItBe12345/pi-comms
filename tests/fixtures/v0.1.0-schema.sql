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
  initiator_session_id TEXT NOT NULL DEFAULT '',
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

CREATE INDEX messages_group_time_idx
  ON messages(group_id, timestamp DESC);
CREATE INDEX agent_requests_group_status_idx
  ON agent_requests(group_id, status, updated_at DESC);
CREATE INDEX agent_requests_chain_round_idx
  ON agent_requests(chain_id, round);
CREATE INDEX paused_chains_owner_group_idx
  ON paused_chains(initiator_session_id, group_id, paused_at DESC);

INSERT INTO groups VALUES ('release-group', '发行版群组', '发行版群组', 1);
INSERT INTO messages (
  message_id, group_id, sender_id, sender_name, sender_type, text,
  mention_ids, timestamp, status, request_id, chain_id, round
) VALUES (
  'release-message', 'release-group', 'user:alice', 'Alice', 'user',
  '@Bob-Pi 验证升级', '["agent:bob"]', 2, 'completed',
  'release-request', 'release-request', 1
);
INSERT INTO agent_requests (
  request_id, group_id, message_id, sender_id, sender_name,
  target_agent_id, target_agent_name, owner_user_name, sender_type,
  sender_owner_user_name, online_members, text, chain_id, round, status,
  initiator_session_id, initiator_name, participants, round_limit,
  result_text, failure_reason, created_at, updated_at
) VALUES (
  'release-request', 'release-group', 'release-message', 'user:alice', 'Alice',
  'agent:bob', 'Bob-Pi', 'Bob', 'user', NULL, '[]', '验证升级',
  'release-request', 1, 'completed', 'release-session', 'Alice',
  '["Alice-Pi","Bob-Pi"]', 10, 'UPGRADE_OK', NULL, 2, 3
);

PRAGMA user_version = 3;
COMMIT;
