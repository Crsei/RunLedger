/**
 * R1:Session Store structural schema(06 §4.3 冻结)。
 *
 * 冻结对象:schema_meta / store_control / sessions / session_owners /
 * session_events / session_checkpoints / commands / command_attempt_receipts
 * 的 exact SQL。首版冻结后新增 Agent feature 优先扩展 versioned payload,
 * 不随意 DDL;format digest 是 DDL 的 canonical sha256。
 */

import { createHash } from "node:crypto";
import type { SessionDatabase } from "./database.ts";

export const SESSION_STORE_SCHEMA_VERSION = 5 as const;

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

/** 当前 title schema 之前的完整 DDL；旧 store 先升级到此结构。 */
export const SESSION_STORE_SCHEMA_V2_SQL = `
CREATE TABLE schema_meta (
  schema_version INTEGER PRIMARY KEY,
  format_digest TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE store_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  admission TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL,
  catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
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
  title TEXT NULL,
  title_source TEXT NULL,
  title_updated_at_ms INTEGER NULL,
  CHECK (status IN ('active', 'recovery_required', 'paused', 'completed', 'failed', 'archived')),
  CHECK (title IS NULL OR (length(CAST(title AS BLOB)) BETWEEN 1 AND 160)),
  CHECK (title_source IS NULL OR title_source IN ('auto', 'user')),
  CHECK (title_updated_at_ms IS NULL OR (typeof(title_updated_at_ms) = 'integer' AND title_updated_at_ms >= 0)),
  CHECK (
    (title IS NULL AND title_source IS NULL AND title_updated_at_ms IS NULL)
    OR (title IS NOT NULL AND title_source IS NOT NULL AND title_updated_at_ms IS NOT NULL)
  )
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
CREATE INDEX idx_sessions_title_updated ON sessions(title_updated_at_ms, session_id);

CREATE TRIGGER sessions_title_invariant_insert
BEFORE INSERT ON sessions
WHEN NOT ((NEW.title IS NULL AND NEW.title_source IS NULL AND NEW.title_updated_at_ms IS NULL)
       OR (NEW.title IS NOT NULL AND NEW.title_source IS NOT NULL AND NEW.title_updated_at_ms IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'sessions title state is incomplete');
END;

CREATE TRIGGER sessions_title_invariant_update
BEFORE UPDATE OF title, title_source, title_updated_at_ms ON sessions
WHEN NOT ((NEW.title IS NULL AND NEW.title_source IS NULL AND NEW.title_updated_at_ms IS NULL)
       OR (NEW.title IS NOT NULL AND NEW.title_source IS NOT NULL AND NEW.title_updated_at_ms IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'sessions title state is incomplete');
END;
`;

/** 当前 schema 为普通 Session 保存 source workspace binding；不再只依赖启动 cwd。 */
export const SESSION_STORE_SCHEMA_V3_SQL = SESSION_STORE_SCHEMA_V2_SQL + `
ALTER TABLE sessions ADD COLUMN source_workspace_locator_json TEXT;
`;

/** Harness Profile durable identity；DEFAULT 只服务旧 row 回填与兼容窗口。 */
export const SESSION_STORE_SCHEMA_V3_TO_V4_SQL = `
ALTER TABLE sessions ADD COLUMN harness_profile_id TEXT NOT NULL DEFAULT 'standard'
  CHECK (harness_profile_id IN ('standard', 'minimal'));
ALTER TABLE sessions ADD COLUMN harness_profile_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(harness_profile_version) = 'integer' AND harness_profile_version = 1);
ALTER TABLE sessions ADD COLUMN harness_profile_digest TEXT NOT NULL DEFAULT '377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238'
  CHECK (length(harness_profile_digest) = 64 AND harness_profile_digest NOT GLOB '*[^0-9a-f]*');
CREATE TRIGGER sessions_harness_profile_invariant_insert
BEFORE INSERT ON sessions
WHEN NOT (
  (NEW.harness_profile_id = 'standard' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238')
  OR (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = 'f77ad882678905487fc76b109d8c88dac16622174553ae7bd08772f8a1a15fa7')
)
BEGIN
  SELECT RAISE(ABORT, 'sessions harness profile ref is invalid');
END;
CREATE TRIGGER sessions_harness_profile_invariant_update
BEFORE UPDATE OF harness_profile_id, harness_profile_version, harness_profile_digest ON sessions
WHEN NOT (
  (NEW.harness_profile_id = 'standard' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238')
  OR (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = 'f77ad882678905487fc76b109d8c88dac16622174553ae7bd08772f8a1a15fa7')
)
BEGIN
  SELECT RAISE(ABORT, 'sessions harness profile ref is invalid');
END;
`;

export const SESSION_STORE_SCHEMA_V4_SQL = SESSION_STORE_SCHEMA_V3_SQL + SESSION_STORE_SCHEMA_V3_TO_V4_SQL;

/** 版本化模式扩展；保留旧 ref，只放宽 identity 列并替换 exact triggers。 */
export const SESSION_STORE_SCHEMA_V4_TO_V5_SQL = `
DROP TRIGGER sessions_harness_profile_invariant_insert;
DROP TRIGGER sessions_harness_profile_invariant_update;
ALTER TABLE sessions ADD COLUMN harness_profile_id_v5 TEXT NOT NULL DEFAULT 'standard' CHECK (harness_profile_id_v5 IN ('standard', 'minimal', 'plan'));
ALTER TABLE sessions ADD COLUMN harness_profile_version_v5 INTEGER NOT NULL DEFAULT 1 CHECK (typeof(harness_profile_version_v5) = 'integer' AND harness_profile_version_v5 IN (1, 2));
UPDATE sessions SET harness_profile_id_v5 = harness_profile_id, harness_profile_version_v5 = harness_profile_version;
ALTER TABLE sessions DROP COLUMN harness_profile_id;
ALTER TABLE sessions DROP COLUMN harness_profile_version;
ALTER TABLE sessions RENAME COLUMN harness_profile_id_v5 TO harness_profile_id;
ALTER TABLE sessions RENAME COLUMN harness_profile_version_v5 TO harness_profile_version;
CREATE TRIGGER sessions_harness_profile_invariant_insert
BEFORE INSERT ON sessions
WHEN NOT (
  (NEW.harness_profile_id = 'standard' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238')
  OR   (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = 'f77ad882678905487fc76b109d8c88dac16622174553ae7bd08772f8a1a15fa7')
  OR   (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 2 AND NEW.harness_profile_digest = '0d18e14a2e47e0789512a711a1f7f38444660754a45382e10fa97e65bc978908')
  OR   (NEW.harness_profile_id = 'plan' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '3fe1eb82eb0b4f8f111e072a9a62c20960f2e0950e36ecb5b2191544d22de2b2')
)
BEGIN
  SELECT RAISE(ABORT, 'sessions harness profile ref is invalid');
END;
CREATE TRIGGER sessions_harness_profile_invariant_update
BEFORE UPDATE OF harness_profile_id, harness_profile_version, harness_profile_digest ON sessions
WHEN NOT (
  (NEW.harness_profile_id = 'standard' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238')
  OR   (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = 'f77ad882678905487fc76b109d8c88dac16622174553ae7bd08772f8a1a15fa7')
  OR   (NEW.harness_profile_id = 'minimal' AND NEW.harness_profile_version = 2 AND NEW.harness_profile_digest = '0d18e14a2e47e0789512a711a1f7f38444660754a45382e10fa97e65bc978908')
  OR   (NEW.harness_profile_id = 'plan' AND NEW.harness_profile_version = 1 AND NEW.harness_profile_digest = '3fe1eb82eb0b4f8f111e072a9a62c20960f2e0950e36ecb5b2191544d22de2b2')
)
BEGIN
  SELECT RAISE(ABORT, 'sessions harness profile ref is invalid');
END;
`;

export const SESSION_STORE_SCHEMA_V5_SQL = SESSION_STORE_SCHEMA_V4_SQL + SESSION_STORE_SCHEMA_V4_TO_V5_SQL;

/** Exact legacy -> current structural migration; no title data is inferred from legacy events. */
export const SESSION_STORE_SCHEMA_V1_TO_V2_SQL = `
ALTER TABLE store_control ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0);
ALTER TABLE sessions ADD COLUMN title TEXT NULL CHECK (title IS NULL OR (length(CAST(title AS BLOB)) BETWEEN 1 AND 160));
ALTER TABLE sessions ADD COLUMN title_source TEXT NULL CHECK (title_source IS NULL OR title_source IN ('auto', 'user'));
ALTER TABLE sessions ADD COLUMN title_updated_at_ms INTEGER NULL CHECK (title_updated_at_ms IS NULL OR (typeof(title_updated_at_ms) = 'integer' AND title_updated_at_ms >= 0));
CREATE INDEX idx_sessions_title_updated ON sessions(title_updated_at_ms, session_id);
CREATE TRIGGER sessions_title_invariant_insert
BEFORE INSERT ON sessions
WHEN NOT ((NEW.title IS NULL AND NEW.title_source IS NULL AND NEW.title_updated_at_ms IS NULL)
       OR (NEW.title IS NOT NULL AND NEW.title_source IS NOT NULL AND NEW.title_updated_at_ms IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'sessions title state is incomplete');
END;
CREATE TRIGGER sessions_title_invariant_update
BEFORE UPDATE OF title, title_source, title_updated_at_ms ON sessions
WHEN NOT ((NEW.title IS NULL AND NEW.title_source IS NULL AND NEW.title_updated_at_ms IS NULL)
       OR (NEW.title IS NOT NULL AND NEW.title_source IS NOT NULL AND NEW.title_updated_at_ms IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'sessions title state is incomplete');
END;
`;

/** title schema → current:旧 Session 不猜测 source binding，首次 open/resume 必须显式 rebind/migrate。 */
export const SESSION_STORE_SCHEMA_V2_TO_V3_SQL = `
ALTER TABLE sessions ADD COLUMN source_workspace_locator_json TEXT;
`;

/** 规范化 DDL 文本的 canonical sha256(hex 64 字符),作为 schema format digest。 */
export function sessionStoreSchemaFormatDigest(sql: string = SESSION_STORE_SCHEMA_V5_SQL): string {
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
		tx.execSync(SESSION_STORE_SCHEMA_V5_SQL);
		tx.runSync("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (?, ?, ?)", [
			SESSION_STORE_SCHEMA_VERSION,
			formatDigest,
			Date.now(),
		]);
		tx.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 0, ?)", [Date.now()]);
	});
}
