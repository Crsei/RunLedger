import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { createTcpOwnerTransport } from "../../../src/runtime/session-server/owner-probe.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import {
	applySessionStatusProjectionRepair,
	SESSION_STATUS_PROJECTION_REPAIR_VERSION,
} from "../../../src/storage/session-store/projection-repair.ts";
import { beginOfflineMigration } from "../../../src/storage/session-store/schema-compatibility.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-projection-repair-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("versioned Session status projection repair", () => {
	it("repairs an old active plus unowned drift from validated events and is idempotent", async () => {
		const db = openSessionDatabase(join(dir, "state.db"));
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "projection-drift");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "projection-drift"),
			repositoryId: createRuntimeId("repository", "projection-drift"),
			settingsDigest: "d".repeat(64),
		});
		const owner = new SessionOwner({ store, ownerStore, transport: createTcpOwnerTransport() });
		const claimed = await owner.open(sessionId);
		expect(claimed.ok && claimed.outcome === "claimed").toBe(true);
		owner.release("paused");
		// 合成旧 binary 留下的 cache drift；event/hash/owner truth 保持有效。
		db.runSync("UPDATE sessions SET status = 'active' WHERE session_id = ?", [sessionId]);

		const firstGate = beginOfflineMigration(db);
		expect(firstGate.ok).toBe(true);
		if (!firstGate.ok) return;
		expect(applySessionStatusProjectionRepair(db, {
			gate: firstGate.gate,
			repairVersion: SESSION_STATUS_PROJECTION_REPAIR_VERSION,
		})).toEqual({ ok: true, repairVersion: 1, scanned: 1, repaired: 1 });
		expect(store.getSession(sessionId)?.status).toBe("paused");

		const secondGate = beginOfflineMigration(db);
		expect(secondGate.ok).toBe(true);
		if (!secondGate.ok) return;
		expect(applySessionStatusProjectionRepair(db, {
			gate: secondGate.gate,
			repairVersion: SESSION_STATUS_PROJECTION_REPAIR_VERSION,
		})).toEqual({ ok: true, repairVersion: 1, scanned: 1, repaired: 0 });
		db.close();
	});
});
