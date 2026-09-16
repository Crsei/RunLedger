import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { SESSION_STORE_SCHEMA_V4_SQL, SESSION_STORE_SCHEMA_V6_SQL, sessionStoreSchemaFormatDigest } from "../../../src/storage/session-store/schema.ts";
import { migrateSessionStoreToCurrent } from "../../../src/storage/session-store/schema-compatibility.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { legacyPlanHarnessProfileRef, minimalHarnessProfileRef } from "../../../src/runtime/harness-profiles/resolver.ts";
import { resolveAgentMode } from "../../../src/runtime/harness-profiles/agent-mode.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSyncRetry(root); });

describe("agent mode offline migration", () => {
	it("preserves old minimal identity and enables a separate shell-only session", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-mode-schema-")); roots.push(root);
		const db = openSessionDatabase(join(root, "state.db"));
		db.execSync(SESSION_STORE_SCHEMA_V4_SQL);
		db.runSync("INSERT INTO schema_meta VALUES (4, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V4_SQL)]);
		db.execSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 0, 1)");
		const store = new SessionStore(db);
		const identity = { workspaceId: createRuntimeId("workspace", "mode"), repositoryId: createRuntimeId("repository", "mode"), settingsDigest: "d".repeat(64) };
		const legacyId = createRuntimeId("session", "legacy-mode");
		store.createSession({ ...identity, sessionId: legacyId, harnessProfile: minimalHarnessProfileRef() });
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [legacyId, createRuntimeId("runtime", "mode-migration")]);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		expect(db.querySingle("SELECT MAX(schema_version) AS version FROM schema_meta")).toEqual({ version: 4 });
		db.runSync("UPDATE session_owners SET state = 'unowned' WHERE session_id = ?", [legacyId]);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: true, storeVersion: 7 });
		expect(store.getSession(legacyId)?.harnessProfile).toEqual(minimalHarnessProfileRef());
		const mode = resolveAgentMode("minimal"); if (!mode.ok) throw new Error(mode.code);
		const shellId = createRuntimeId("session", "shell-mode");
		store.createSession({ ...identity, sessionId: shellId, harnessProfile: mode.ref });
		expect(store.getSession(shellId)?.harnessProfile).toEqual(mode.ref);
		const forked = store.forkSession({ sessionId: createRuntimeId("session", "legacy-fork"), sourceSessionId: legacyId, expectedSourceHeadSequence: 0, expectedCatalogRevision: store.catalogRevision() });
		expect(forked.harnessProfile).toEqual(minimalHarnessProfileRef());
		expect(db.querySingle("PRAGMA foreign_key_check")).toBeUndefined();
		db.close();
	});

	it("admits plan@2 only after the V6 -> V7 offline migration", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan2-schema-")); roots.push(root);
		const db = openSessionDatabase(join(root, "state.db"));
		db.execSync(SESSION_STORE_SCHEMA_V6_SQL);
		db.runSync("INSERT INTO schema_meta VALUES (6, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V6_SQL)]);
		db.execSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 0, 1)");
		const store = new SessionStore(db);
		const identity = { workspaceId: createRuntimeId("workspace", "plan2"), repositoryId: createRuntimeId("repository", "plan2"), settingsDigest: "d".repeat(64) };
		const planMode = resolveAgentMode("plan");
		if (!planMode.ok) throw new Error(planMode.code);
		expect(planMode.ref.version).toBe(2);
		// V6 白名单只认 plan@1,plan@2 必须在迁移前被拒。用 plan@1 Session 占位以验证
		// 迁移仍受 active owner 门禁约束。
		const beforeId = createRuntimeId("session", "plan2-before");
		store.createSession({ ...identity, sessionId: beforeId, harnessProfile: legacyPlanHarnessProfileRef() });
		expect(() => store.createSession({ ...identity, sessionId: createRuntimeId("session", "plan2-rejected"), harnessProfile: planMode.ref }))
			.toThrowError(/harness profile ref is invalid/);
		db.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [beforeId, createRuntimeId("runtime", "plan2-migration")]);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		db.runSync("UPDATE session_owners SET state = 'unowned' WHERE session_id = ?", [beforeId]);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: true, storeVersion: 7 });
		const afterId = createRuntimeId("session", "plan2-after");
		store.createSession({ ...identity, sessionId: afterId, harnessProfile: planMode.ref });
		expect(store.getSession(afterId)?.harnessProfile).toEqual(planMode.ref);
		// 历史 plan@1 ref 在迁移后仍可写入与读取。
		const legacyId = createRuntimeId("session", "plan1-legacy");
		store.createSession({ ...identity, sessionId: legacyId, harnessProfile: legacyPlanHarnessProfileRef() });
		expect(store.getSession(legacyId)?.harnessProfile).toEqual(legacyPlanHarnessProfileRef());
		db.close();
	});
});
