/**
 * R1:Session Store 首版 structural schema fixtures(06 §4.3)。
 *
 * 覆盖:exact DDL、format digest 稳定性、CHECK 约束、FK cascade、UNIQUE、
 * 幂等安装守卫。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import {
	SESSION_STORE_SCHEMA_VERSION,
	installSessionStoreSchema,
	sessionStoreSchemaFormatDigest,
} from "../../../src/storage/session-store/schema.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-schema-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

function openInstalled(): ReturnType<typeof openSessionDatabase> {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	return db;
}

describe("R1 exact 首版 schema", () => {
	it("installs the full 首版 schema with schema_meta and store_control rows", () => {
		const db = openInstalled();
		expect(db.querySingle("SELECT schema_version, format_digest FROM schema_meta")).toMatchObject({
			schema_version: SESSION_STORE_SCHEMA_VERSION,
			format_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(db.querySingle("SELECT admission, migration_epoch, catalog_revision FROM store_control")).toEqual({
			admission: "ready",
			migration_epoch: 0,
			catalog_revision: 0,
		});
		const tables = db
			.queryAll("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.map((row) => row.name as string);
		expect(tables).toEqual(
			expect.arrayContaining([
				"schema_meta",
				"store_control",
				"sessions",
				"session_owners",
				"session_events",
				"session_checkpoints",
				"commands",
				"command_attempt_receipts",
			]),
		);
		db.close();
	});

	it("freezes a deterministic format digest for the exact DDL", () => {
		expect(sessionStoreSchemaFormatDigest()).toBe(sessionStoreSchemaFormatDigest());
		expect(sessionStoreSchemaFormatDigest()).toMatch(/^[a-f0-9]{64}$/);
		expect(sessionStoreSchemaFormatDigest()).not.toBe(sessionStoreSchemaFormatDigest("CREATE TABLE x (a);"));
	});

	it("refuses to install twice and refuses to install over a foreign schema", () => {
		const db = openSessionDatabase(join(dir, "state.db"));
		installSessionStoreSchema(db);
		expect(() => installSessionStoreSchema(db)).toThrowError(/already installed/);
		db.close();

		const foreign = openSessionDatabase(join(dir, "foreign.db"));
		foreign.runSync("CREATE TABLE sessions (session_id TEXT)");
		expect(() => installSessionStoreSchema(foreign)).toThrowError(/already installed/);
		foreign.close();
	});
});

describe("R1 schema constraints", () => {
	it("enforces sessions.status CHECK and session_owners.state CHECK", () => {
		const db = openInstalled();
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_a", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		expect(() =>
			db.runSync(
				"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'flying', 1, 1, ?)",
				["session_bad", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
			),
		).toThrowError();
		expect(() =>
			db.runSync(
				"INSERT INTO session_owners (session_id, generation, state, updated_at_ms) VALUES (?, 1, 'dancing', 1)",
				["session_a"],
			),
		).toThrowError();
		expect(() =>
			db.runSync("INSERT INTO session_owners (session_id, generation, state, port, updated_at_ms) VALUES (?, 1, 'running', 70000, 1)", ["session_a"]),
		).toThrowError();
		expect(() =>
			db.runSync("INSERT INTO session_owners (session_id, generation, state, port, updated_at_ms) VALUES (?, 1, 'running', 0, 1)", ["session_a"]),
		).toThrowError();
		db.close();
	});

	it("enforces command_attempt_receipts.outcome CHECK and checkpoint boundary CHECK", () => {
		const db = openInstalled();
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_a", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		db.runSync(
			"INSERT INTO commands (session_id, command_id, request_digest, origin_generation, created_at_ms) VALUES (?, ?, ?, 1, 1)",
			["session_a", "command_1", "d".repeat(64)],
		);
		expect(() =>
			db.runSync(
				"INSERT INTO command_attempt_receipts (receipt_id, session_id, command_id, attempt_id, origin_generation, effect_class, outcome, created_at_ms) VALUES (?, ?, ?, ?, 1, 'readonly', 'guessed', 1)",
				["receipt_1", "session_a", "command_1", "attempt_1"],
			),
		).toThrowError();
		expect(() =>
			db.runSync(
				"INSERT INTO session_checkpoints (checkpoint_id, session_id, owner_generation, boundary, source_sequence, snapshot_json, snapshot_digest, created_at_ms) VALUES (?, ?, 1, 'before_process', 0, '{}', ?, 1)",
				["checkpoint_1", "session_a", "d".repeat(64)],
			),
		).toThrowError();
		db.close();
	});

	it("cascades session deletion through owners, events, checkpoints, commands and receipts", () => {
		const db = openInstalled();
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_a", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		db.runSync("INSERT INTO session_owners (session_id, generation, state, updated_at_ms) VALUES (?, 1, 'running', 1)", ["session_a"]);
		db.runSync(
			"INSERT INTO session_events (session_id, sequence, event_id, owner_generation, event_type, payload_json, current_event_hash, created_at_ms) VALUES (?, 0, ?, 1, 'session.created', '{}', ?, 1)",
			["session_a", "event_1", "d".repeat(64)],
		);
		db.runSync(
			"INSERT INTO session_checkpoints (checkpoint_id, session_id, owner_generation, boundary, source_sequence, snapshot_json, snapshot_digest, created_at_ms) VALUES (?, ?, 1, 'turn_completed', 0, '{}', ?, 1)",
			["checkpoint_1", "session_a", "d".repeat(64)],
		);
		db.runSync(
			"INSERT INTO commands (session_id, command_id, request_digest, origin_generation, created_at_ms) VALUES (?, ?, ?, 1, 1)",
			["session_a", "command_1", "d".repeat(64)],
		);
		db.runSync(
			"INSERT INTO command_attempt_receipts (receipt_id, session_id, command_id, attempt_id, origin_generation, effect_class, outcome, created_at_ms) VALUES (?, ?, ?, ?, 1, 'readonly', 'committed', 1)",
			["receipt_1", "session_a", "command_1", "attempt_1"],
		);
		db.runSync("DELETE FROM sessions WHERE session_id = ?", ["session_a"]);
		expect(db.querySingle("SELECT COUNT(*) AS n FROM session_owners")?.n).toBe(0);
		expect(db.querySingle("SELECT COUNT(*) AS n FROM session_events")?.n).toBe(0);
		expect(db.querySingle("SELECT COUNT(*) AS n FROM session_checkpoints")?.n).toBe(0);
		expect(db.querySingle("SELECT COUNT(*) AS n FROM commands")?.n).toBe(0);
		expect(db.querySingle("SELECT COUNT(*) AS n FROM command_attempt_receipts")?.n).toBe(0);
		db.close();
	});

	it("enforces unique event_id across a session stream", () => {
		const db = openInstalled();
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_a", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		db.runSync(
			"INSERT INTO session_events (session_id, sequence, event_id, owner_generation, event_type, payload_json, current_event_hash, created_at_ms) VALUES (?, 0, ?, 1, 'session.created', '{}', ?, 1)",
			["session_a", "event_1", "d".repeat(64)],
		);
		expect(() =>
			db.runSync(
				"INSERT INTO session_events (session_id, sequence, event_id, owner_generation, event_type, payload_json, current_event_hash, created_at_ms) VALUES (?, 1, ?, 1, 'session.created', '{}', ?, 1)",
				["session_a", "event_1", "e".repeat(64)],
			),
		).toThrowError();
		db.close();
	});
});
