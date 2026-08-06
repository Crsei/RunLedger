/**
 * R1:schema compatibility 与 offline-only migration gate fixtures(06 §4.2)。
 *
 * 覆盖:MIN/MAX 窗口、too-new/too-old/format-digest 破坏 fail closed、
 * admission gate(零 owner 通过 / active owner 拒绝)、migrator crash 后
 * migration_blocked 保持 fail closed、显式 resume/abort。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { SESSION_STORE_SCHEMA_VERSION, installSessionStoreSchema, sessionStoreSchemaFormatDigest } from "../../../src/storage/session-store/schema.ts";
import {
	abortOfflineMigration,
	applyStructuralMigration,
	beginOfflineMigration,
	checkStoreCompatibility,
	countActiveOwners,
	resumeOfflineMigration,
} from "../../../src/storage/session-store/schema-compatibility.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-compat-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function openInstalled(): ReturnType<typeof openSessionDatabase> {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	return db;
}

describe("R1 schema compatibility window", () => {
	it("accepts the current binary schema and reports the frozen header", () => {
		const db = openInstalled();
		const result = checkStoreCompatibility(db);
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect(result.header).toMatchObject({
			storeVersion: SESSION_STORE_SCHEMA_VERSION,
			admission: "ready",
			migrationEpoch: 0,
		});
		expect(result.header.formatDigest).toBe(sessionStoreSchemaFormatDigest());
		db.close();
	});

	it("fails closed with store_schema_too_new above the binary max", () => {
		const db = openInstalled();
		db.runSync("UPDATE schema_meta SET schema_version = 99, format_digest = ? WHERE schema_version = ?", [
			"f".repeat(64),
			SESSION_STORE_SCHEMA_VERSION,
		]);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: false, code: "store_schema_too_new" });
		db.close();
	});

	it("fails closed with store_schema_too_old below the binary min", () => {
		const db = openInstalled();
		db.runSync("UPDATE schema_meta SET schema_version = 0, format_digest = ? WHERE schema_version = ?", [
			"f".repeat(64),
			SESSION_STORE_SCHEMA_VERSION,
		]);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: false, code: "store_schema_too_old" });
		db.close();
	});

	it("fails closed on format digest mismatch for the current version", () => {
		const db = openInstalled();
		db.runSync("UPDATE schema_meta SET format_digest = ? WHERE schema_version = ?", [
			"e".repeat(64),
			SESSION_STORE_SCHEMA_VERSION,
		]);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: false, code: "format_digest_mismatch" });
		db.close();
	});

	it("fails closed when the header tables are missing", () => {
		const db = openSessionDatabase(join(dir, "bare.db"));
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: false, code: "missing_header" });
		db.close();
	});
});

describe("R1 offline-only migration admission gate", () => {
	it("opens the gate with zero active owners and applies one transactional migration", () => {
		const db = openInstalled();
		const gate = beginOfflineMigration(db);
		expect(gate).toMatchObject({ ok: true });
		if (!gate.ok) return;

		const blocked = checkStoreCompatibility(db);
		expect(blocked).toMatchObject({ ok: true });
		if (blocked.ok) expect(blocked.header.admission).toBe("migration_blocked");

		const nextSql = "ALTER TABLE sessions ADD COLUMN probe_column INTEGER;";
		const applied = applyStructuralMigration(db, {
			gate: gate.gate,
			nextVersion: 2,
			nextSql,
			nextFormatDigest: "a".repeat(64),
		});
		expect(applied).toEqual({ ok: true, storeVersion: 2 });
		const after = checkStoreCompatibility(db);
		expect(after).toMatchObject({ ok: false, code: "store_schema_too_new" });
		db.close();
	});

	it("refuses the gate while any owner is active and keeps admission ready", () => {
		const db = openInstalled();
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_a", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [
			"session_a",
			"runtime_1",
		]);
		expect(countActiveOwners(db)).toBe(1);
		expect(beginOfflineMigration(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true });
		db.close();
	});

	it("rejects migration when the gate epoch changed and rolls back the DDL on failure", () => {
		const db = openInstalled();
		const gate = beginOfflineMigration(db);
		if (!gate.ok) throw new Error("gate failed");
		// 模拟另一个 migrator 抢先 epoch+1:gate 不再权威。
		db.runSync("UPDATE store_control SET migration_epoch = migration_epoch + 1, updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
		const applied = applyStructuralMigration(db, {
			gate: gate.gate,
			nextVersion: 2,
			nextSql: "ALTER TABLE sessions ADD COLUMN probe_column INTEGER;",
			nextFormatDigest: "a".repeat(64),
		});
		expect(applied).toMatchObject({ ok: false, code: "epoch_changed" });
		// DDL 未应用,admission 仍为 blocked。
		const header = checkStoreCompatibility(db);
		if (header.ok) expect(header.header.admission).toBe("migration_blocked");
		db.close();
	});

	it("keeps migration_blocked fail-closed after a migrator crash and allows explicit abort", () => {
		const db = openInstalled();
		const gate = beginOfflineMigration(db);
		if (!gate.ok) throw new Error("gate failed");
		// 模拟崩溃:不调用 apply/release,直接重新 open(新连接)。
		db.close();
		const reopened = openSessionDatabase(join(dir, "state.db"));
		expect(checkStoreCompatibility(reopened)).toMatchObject({ ok: true });
		const header = checkStoreCompatibility(reopened);
		if (header.ok) expect(header.header.admission).toBe("migration_blocked");

		// 只有显式 abort(resume 后)能恢复 ready。
		const resumed = resumeOfflineMigration(reopened);
		expect(resumed).toMatchObject({ ok: true });
		if (!resumed.ok) return;
		expect(abortOfflineMigration(reopened, resumed.gate)).toBe(true);
		expect(checkStoreCompatibility(reopened)).toMatchObject({ ok: true });
		reopened.close();
	});

	it("refuses a second gate while admission is migration_blocked", () => {
		const db = openInstalled();
		expect(beginOfflineMigration(db)).toMatchObject({ ok: true });
		expect(beginOfflineMigration(db)).toMatchObject({ ok: false, code: "admission_not_ready" });
		db.close();
	});
});
