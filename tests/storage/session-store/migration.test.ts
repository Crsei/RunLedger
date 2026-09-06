import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import {
	SESSION_STORE_SCHEMA_V1_SQL,
	SESSION_STORE_SCHEMA_V2_SQL,
	SESSION_STORE_SCHEMA_V3_SQL,
	SESSION_STORE_SCHEMA_VERSION,
	installSessionStoreSchema,
	sessionStoreSchemaFormatDigest,
} from "../../../src/storage/session-store/schema.ts";
import { checkStoreCompatibility, migrateSessionStoreToCurrent, migrateSessionStoreV1ToV2, migrateSessionStoreV2ToV3 } from "../../../src/storage/session-store/schema-compatibility.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-store-migration-"));
});

afterEach(() => {
	rmSyncRetry(directory);
});

function installV1Database() {
	const db = openSessionDatabase(join(directory, "state.db"));
	db.withImmediateTransactionSync((tx) => {
		tx.execSync(SESSION_STORE_SCHEMA_V1_SQL);
		tx.runSync("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (1, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V1_SQL)]);
		tx.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, updated_at_ms) VALUES (1, 'ready', 0, 1)");
		tx.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_legacy", "workspace_legacy", "repository_legacy", "d".repeat(64)],
		);
	});
	return db;
}

function installRevision3Database() {
	const db = openSessionDatabase(join(directory, "state.db"));
	db.withImmediateTransactionSync((tx) => {
		tx.execSync(SESSION_STORE_SCHEMA_V3_SQL);
		tx.runSync("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (3, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V3_SQL)]);
		tx.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 1, 1)");
		tx.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_legacy", "workspace_legacy", "repository_legacy", "d".repeat(64)],
		);
	});
	return db;
}

describe("Session Store legacy to current title migration", () => {
	it("migrates revision 3 offline and backfills every row with frozen standard@1", () => {
		const db = installRevision3Database();
		expect(migrateSessionStoreToCurrent(db)).toEqual({ ok: true, storeVersion: SESSION_STORE_SCHEMA_VERSION });
		const standard = standardHarnessProfileRef();
		expect(db.querySingle(
			"SELECT harness_profile_id, harness_profile_version, harness_profile_digest FROM sessions WHERE session_id = ?",
			["session_legacy"],
		)).toEqual({
			harness_profile_id: standard.id,
			harness_profile_version: standard.version,
			harness_profile_digest: standard.descriptorDigest.digest,
		});
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: SESSION_STORE_SCHEMA_VERSION, admission: "ready" } });
		db.close();
	});

	it("refuses the profile migration while an owner is active and leaves revision 3 ready", () => {
		const db = installRevision3Database();
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [
			"session_legacy",
			"runtime_legacy",
		]);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 3, admission: "ready" } });
		expect(db.queryAll("PRAGMA table_info(sessions)").some((row) => row.name === "harness_profile_id")).toBe(false);
		db.close();
	});

	it("adds nullable title projection columns and records the current digest without guessing legacy titles", () => {
		const db = installV1Database();
		const result = migrateSessionStoreV1ToV2(db);
		expect(result).toEqual({ ok: true, storeVersion: 2 });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 2, admission: "ready" } });
		expect(db.querySingle("SELECT title, title_source, title_updated_at_ms FROM sessions WHERE session_id = ?", ["session_legacy"])).toEqual({
			title: null,
			title_source: null,
			title_updated_at_ms: null,
		});
		expect(db.querySingle("SELECT catalog_revision FROM store_control WHERE singleton_id = 1")).toEqual({ catalog_revision: 1 });
		expect(db.querySingle("SELECT format_digest FROM schema_meta WHERE schema_version = 2")).toEqual({
			format_digest: sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V2_SQL),
		});
		db.close();
	});

	it("upgrades title-schema rows to current without inventing a source workspace binding", () => {
		const db = installV1Database();
		expect(migrateSessionStoreV1ToV2(db)).toEqual({ ok: true, storeVersion: 2 });
		expect(migrateSessionStoreToCurrent(db)).toEqual({ ok: true, storeVersion: SESSION_STORE_SCHEMA_VERSION });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: SESSION_STORE_SCHEMA_VERSION, admission: "ready" } });
		expect(db.querySingle("SELECT source_workspace_locator_json FROM sessions WHERE session_id = ?", ["session_legacy"])).toEqual({
			source_workspace_locator_json: null,
		});
		expect(db.querySingle("SELECT format_digest FROM schema_meta WHERE schema_version = ?", [SESSION_STORE_SCHEMA_VERSION])).toEqual({
			format_digest: sessionStoreSchemaFormatDigest(),
		});
		db.close();
	});

	it("applies the additive workspace-binding migration without disrupting an active owner", () => {
		const db = installV1Database();
		expect(migrateSessionStoreV1ToV2(db)).toEqual({ ok: true, storeVersion: 2 });
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [
			"session_legacy",
			"runtime_legacy",
		]);

		expect(migrateSessionStoreV2ToV3(db)).toEqual({ ok: true, storeVersion: 3 });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 3, admission: "ready" } });
		expect(db.querySingle("SELECT source_workspace_locator_json FROM sessions WHERE session_id = ?", ["session_legacy"])).toEqual({
			source_workspace_locator_json: null,
		});
		expect(db.querySingle("SELECT state FROM session_owners WHERE session_id = ?", ["session_legacy"])).toEqual({ state: "running" });
		db.close();
	});

	it("does not migrate while an active owner exists and leaves the old store ready", () => {
		const db = installV1Database();
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [
			"session_legacy",
			"runtime_legacy",
		]);
		expect(migrateSessionStoreV1ToV2(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 1, admission: "ready" } });
		db.close();
	});

	it("installs new stores with an unnamed title state", () => {
		const db = openSessionDatabase(join(directory, "fresh.db"));
		installSessionStoreSchema(db);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: SESSION_STORE_SCHEMA_VERSION } });
		db.close();
	});
});
