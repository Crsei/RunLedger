import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { SESSION_STORE_SCHEMA_V5_SQL, sessionStoreSchemaFormatDigest } from "../../../src/storage/session-store/schema.ts";
import { migrateSessionStoreToCurrent, checkStoreCompatibility } from "../../../src/storage/session-store/schema-compatibility.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("standard prompt schema migration", () => {
	it("requires zero active owners, preserves old profiles and forks, and admits only the exact new ref", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-standard-schema-")); roots.push(root);
		const db = openSessionDatabase(join(root, "state.db"));
		try {
			db.execSync(SESSION_STORE_SCHEMA_V5_SQL);
			db.runSync("INSERT INTO schema_meta VALUES (5, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V5_SQL)]);
			db.execSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 0, 1)");
			const store = new SessionStore(db);
			const identity = { workspaceId: createRuntimeId("workspace", "standard-schema"), repositoryId: createRuntimeId("repository", "standard-schema"), settingsDigest: "d".repeat(64) };
			const legacyId = createRuntimeId("session", "legacy-standard");
			store.createSession({ ...identity, sessionId: legacyId, harnessProfile: standardHarnessProfileRef() });
			const currentId = createRuntimeId("session", "current-standard");
			expect(() => store.createSession({ ...identity, sessionId: currentId, harnessProfile: standardHarnessProfileRef(2) })).toThrow();
			db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [legacyId, createRuntimeId("runtime", "standard-schema")]);
			expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: false, code: "active_owners_present" });
			expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: 5 } });
			db.runSync("UPDATE session_owners SET state = 'unowned' WHERE session_id = ?", [legacyId]);
			expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: true, storeVersion: 6 });
			expect(store.getSession(legacyId)?.harnessProfile).toEqual(standardHarnessProfileRef());
			store.createSession({ ...identity, sessionId: currentId, harnessProfile: standardHarnessProfileRef(2) });
			expect(store.getSession(currentId)?.harnessProfile).toEqual(standardHarnessProfileRef(2));
			for (const sourceSessionId of [legacyId, currentId]) {
				const fork = store.forkSession({ sessionId: createRuntimeId("session", `${sourceSessionId}-fork`), sourceSessionId, expectedSourceHeadSequence: 0, expectedCatalogRevision: store.catalogRevision() });
				expect(fork.harnessProfile).toEqual(store.getSession(sourceSessionId)?.harnessProfile);
			}
			expect(() => db.runSync("UPDATE sessions SET harness_profile_digest = ? WHERE session_id = ?", [standardHarnessProfileRef().descriptorDigest.digest, currentId])).toThrow();
			expect(db.querySingle("PRAGMA foreign_key_check")).toBeUndefined();
			expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: true, alreadyCurrent: true });
		} finally { db.close(); }
	});
});
