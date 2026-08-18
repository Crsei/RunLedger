import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import {
	SESSION_STORE_SCHEMA_V1_SQL,
	SESSION_STORE_SCHEMA_V2_SQL,
	SESSION_STORE_SCHEMA_VERSION,
	installSessionStoreSchema,
	sessionStoreSchemaFormatDigest,
} from "../../../src/storage/session-store/schema.ts";
import { checkStoreCompatibility, migrateSessionStoreV1ToV2 } from "../../../src/storage/session-store/schema-compatibility.ts";

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

describe("Session Store legacy to current title migration", () => {
	it("adds nullable title projection columns and records the current digest without guessing legacy titles", () => {
		const db = installV1Database();
		const result = migrateSessionStoreV1ToV2(db);
		expect(result).toEqual({ ok: true, storeVersion: SESSION_STORE_SCHEMA_VERSION });
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
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 2 } });
		db.close();
	});
});
