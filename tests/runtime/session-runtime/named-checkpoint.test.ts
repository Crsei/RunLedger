import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { NamedCheckpointDomain } from "../../../src/runtime/session-runtime/named-checkpoint-domain.ts";
import { activeNamedCheckpoints } from "../../../src/runtime/session-runtime/named-checkpoint.ts";
import type { AttemptPort } from "../../../src/runtime/session-runtime/attempt-gateway.ts";
import { projectSessionReplay } from "../../../src/storage/session-codec.ts";
import type { LedgerEntry } from "../../../src/runtime/ledger/types.ts";

let directory: string;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "named-checkpoint-")); });
afterEach(() => { rmSyncRetry(directory); });

function harness(): { store: SessionStore; sessionId: SessionId; fence: { readonly sessionId: SessionId; readonly runtimeId: RuntimeInstanceId; readonly generation: number } } {
	const database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	const store = new SessionStore(database);
	const sessionId = createRuntimeId("session", "named-source");
	const runtimeId = createRuntimeId("runtime", "named-owner");
	store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "named"), repositoryId: createRuntimeId("repository", "named"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
	database.runSync("INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)", [sessionId, runtimeId]);
	return { store, sessionId, fence: { sessionId, runtimeId, generation: 1 } };
}

function attempts(): AttemptPort {
	return {
		beginAttempt: () => ({ attemptId: createRuntimeId("attempt", "named"), commandId: createRuntimeId("command", "named") }),
		settleAttempt: () => ({ ok: true }),
	};
}

function appendStableAssistant(store: SessionStore, sessionId: SessionId, fence: { readonly sessionId: SessionId; readonly runtimeId: RuntimeInstanceId; readonly generation: number }): void {
	store.appendEvent(fence, {
		eventId: createRuntimeId("event", "stable"), ownerGeneration: fence.generation, eventType: "ledger.message", createdAtMs: 1,
		payloadJson: JSON.stringify({ id: "entry_stable", sessionId, parentId: sessionId, timestamp: 1, type: "message", payload: { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Finished first approach." }] } } }),
		expectedPreviousEventHash: null,
	});
}

describe("named checkpoint authority", () => {
	it("records an owner-fenced stable boundary and resolves it from events", async () => {
		const { store, sessionId, fence } = harness();
		appendStableAssistant(store, sessionId, fence);
		const domain = new NamedCheckpointDomain({ store, fence, attemptPort: attempts });
		const created = await domain.create("Before refactor");
		expect(created).toMatchObject({ ok: true, checkpoint: { sessionId, boundarySequence: 1, goal: "Before refactor" } });
		expect(activeNamedCheckpoints(store, sessionId)).toHaveLength(1);
		expect(await domain.create("Second")).toEqual({ ok: false, code: "checkpoint_active" });
		store.database().close();
	});

	it("atomically forks only through the checkpoint and appends source audit plus target report", async () => {
		const { store, sessionId, fence } = harness();
		appendStableAssistant(store, sessionId, fence);
		const domain = new NamedCheckpointDomain({ store, fence, attemptPort: attempts });
		const created = await domain.create("Before refactor");
		if (!created.ok) throw new Error("checkpoint creation failed");
		const sourceBefore = store.replaySessionEvents(sessionId);
		const targetSessionId = createRuntimeId("session", "named-rewound");
		store.rewindSession(fence, {
			sessionId: targetSessionId, sourceSessionId: sessionId, expectedSourceHeadSequence: sourceBefore.length,
			expectedCatalogRevision: store.catalogRevision(), throughSequence: created.checkpoint.boundarySequence,
			checkpointId: created.checkpoint.checkpointId, checkpointGoal: created.checkpoint.goal,
			checkpointSequence: created.checkpoint.boundarySequence, report: "Use the safer implementation and retain the tests.",
		});
		const sourceAfter = store.replaySessionEvents(sessionId);
		expect(sourceAfter.slice(0, -1)).toEqual(sourceBefore);
		expect(sourceAfter.at(-1)?.eventType).toBe("checkpoint.rewound");
		expect(activeNamedCheckpoints(store, sessionId)).toEqual([]);
		const targetEvents = store.replaySessionEvents(targetSessionId);
		expect(targetEvents.map((event) => event.eventType)).toEqual(["ledger.message", "session.forked", "ledger.custom"]);
		const ledger = targetEvents.filter((event) => event.eventType.startsWith("ledger.")).map((event) => JSON.parse(event.payloadJson) as LedgerEntry);
		expect(projectSessionReplay(ledger).messages).toMatchObject([
			{ role: "assistant" },
			{ role: "user", content: [{ type: "text", text: expect.stringContaining("safer implementation") }] },
		]);
		store.database().close();
	});
});
