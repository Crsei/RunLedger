/**
 * R1:Session Store 首版 structural schema(06 §4.3 冻结)。
 *
 * 冻结对象:schema_meta / store_control / sessions / session_owners /
 * session_events / session_checkpoints / commands / command_attempt_receipts
 * 的 exact SQL。首版冻结后新增 Agent feature 优先扩展 versioned payload,
 * 不随意 DDL;format digest 是 DDL 的 canonical sha256。
 */

import { createHash } from "node:crypto";
import type { SessionDatabase } from "./database.ts";

export const SESSION_STORE_SCHEMA_VERSION = 1 as const;

/** §4.3 首版逻辑 schema 的 exact SQL(版本化 migration 以本常量为唯一 source)。 */
export const SESSION_STORE_SCHEMA_V1_SQL = `
CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  format_digest TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE store_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  admission TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (admission IN ('ready', 'migration_blocked'))
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  head_sequence INTEGER NOT NULL DEFAULT 0,
  current_checkpoint_id TEXT,
  last_driver_client_id TEXT,
  driver_revision INTEGER NOT NULL DEFAULT 0,
  worktree_locator_json TEXT,
  settings_digest TEXT NOT NULL,
  CHECK (status IN ('active', 'recovery_required', 'paused', 'completed', 'failed', 'archived'))
);

CREATE TABLE session_owners (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  runtime_id TEXT,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  port INTEGER,
  auth_token BLOB,
  heartbeat_at_ms INTEGER,
  owner_started_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (state IN ('unowned', 'starting', 'recovery_required', 'running', 'stopping')),
  CHECK (port IS NULL OR (port >= 1 AND port <= 65535))
);

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  owner_generation INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_event_hash TEXT,
  current_event_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE session_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner_generation INTEGER NOT NULL,
  boundary TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (boundary IN ('before_model', 'after_model', 'before_tool', 'after_tool', 'turn_completed', 'paused'))
);

CREATE TABLE commands (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  origin_generation INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, command_id)
);

CREATE TABLE command_attempt_receipts (
  receipt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  origin_generation INTEGER NOT NULL,
  settled_generation INTEGER,
  effect_class TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_json TEXT,
  result_digest TEXT,
  evidence_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id, command_id) REFERENCES commands(session_id, command_id) ON DELETE CASCADE,
  CHECK (outcome IN ('started', 'committed', 'rejected', 'interrupted', 'uncertain', 'verified'))
);

CREATE INDEX idx_session_events_lookup ON session_events(session_id, sequence);
CREATE INDEX idx_session_checkpoints_lookup ON session_checkpoints(session_id, source_sequence);
CREATE INDEX idx_command_receipts_lookup ON command_attempt_receipts(session_id, command_id);
`;

/** 规范化 DDL 文本的 canonical sha256(hex 64 字符),作为 schema format digest。 */
export function sessionStoreSchemaFormatDigest(sql: string = SESSION_STORE_SCHEMA_V1_SQL): string {
	return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** 安装首版 schema;仅当库为空时执行,已存在 schema 时 fail closed。 */
export function installSessionStoreSchema(db: SessionDatabase): void {
	const existing = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('schema_meta', 'store_control', 'sessions', 'session_owners')");
	if (existing && Number(existing.n) > 0) {
		throw new Error("session store schema already installed");
	}
	const formatDigest = sessionStoreSchemaFormatDigest();
	db.withImmediateTransactionSync((tx) => {
		tx.execSync(SESSION_STORE_SCHEMA_V1_SQL);
		tx.runSync("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (?, ?, ?)", [
			SESSION_STORE_SCHEMA_VERSION,
			formatDigest,
			Date.now(),
		]);
		tx.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, updated_at_ms) VALUES (1, 'ready', 0, ?)", [Date.now()]);
	});
}
