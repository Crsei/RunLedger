import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createHarnessCompositionReceipt,
	minimalHarnessProfileRef,
	resolveHarnessComposition,
	standardHarnessProfileRef,
	type HarnessCompositionReceipt,
	type HarnessProfileRef,
} from "../../../src/runtime/harness-profiles/index.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type SessionId, type RuntimeInstanceId } from "../../../src/runtime/protocol/ids.ts";
import { putSessionCheckpoint } from "../../../src/runtime/session-runtime/checkpoint.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { rmSyncRetry } from "../../helpers/cleanup.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSyncRetry(root);
});

function fixture(profile: HarnessProfileRef = standardHarnessProfileRef()): {
	readonly store: SessionStore;
	readonly sessionId: SessionId;
	readonly fence: { readonly sessionId: SessionId; readonly runtimeId: RuntimeInstanceId; readonly generation: number };
} {
	const root = mkdtempSync(join(tmpdir(), "runledger-harness-recovery-"));
	roots.push(root);
	const db = openSessionDatabase(join(root, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "harness-recovery");
	const runtimeId = createRuntimeId("runtime", "harness-recovery");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "harness-recovery"),
		repositoryId: createRuntimeId("repository", "harness-recovery"),
		settingsDigest: "d".repeat(64),
		harnessProfile: profile,
	});
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	return { store, sessionId, fence: { sessionId, runtimeId, generation: 1 } };
}

function standardReceipt(sessionId: SessionId, ownerGeneration = 1): HarnessCompositionReceipt {
	const descriptor = standardHarnessProfileRef();
	const composition = resolveHarnessComposition({
		ref: descriptor,
		systemPrompt: "stable standard prompt",
		governedTools: [],
	});
	return createHarnessCompositionReceipt({
		sessionId,
		ownerGeneration,
		descriptor: {
			id: "standard",
			version: 1,
			prompt: { mode: "assembled" },
			tools: { mode: "standard", allowlist: [], allowBackgroundHandle: true },
			extensions: { tools: true, context: true, hooks: true, lifecycle: true },
			multiAgent: true,
		},
		composition,
	});
}

function appendReceipt(
	store: SessionStore,
	fence: { readonly sessionId: SessionId; readonly runtimeId: RuntimeInstanceId; readonly generation: number },
	receipt: HarnessCompositionReceipt,
	seed: string,
): void {
	const tail = store.replaySessionEvents(fence.sessionId).at(-1);
	store.appendEvent(fence, {
		eventId: createRuntimeId("event", seed),
		ownerGeneration: fence.generation,
		eventType: "harness.composed",
		payloadJson: JSON.stringify(receipt),
		createdAtMs: 1,
		expectedPreviousEventHash: tail?.currentEventHash ?? null,
	});
}

describe("Harness Profile authority-first recovery", () => {
	it("returns a typed failure when the durable catalog ref no longer resolves exactly", () => {
		const { store, sessionId } = fixture();
		store.database().execSync("DROP TRIGGER sessions_harness_profile_invariant_update");
		store.database().runSync(
			"UPDATE sessions SET harness_profile_digest = ? WHERE session_id = ?",
			["0".repeat(64), sessionId],
		);

		expect(restoreSession(store, sessionId)).toMatchObject({
			ok: false,
			code: "harness_profile_corruption",
		});
		store.database().close();
	});

	it("rejects a well-hashed composition receipt whose profile differs from the catalog authority", () => {
		const { store, sessionId, fence } = fixture(minimalHarnessProfileRef());
		appendReceipt(store, fence, standardReceipt(sessionId), "profile-mismatch");

		expect(restoreSession(store, sessionId)).toMatchObject({
			ok: false,
			code: "harness_composition_corruption",
			diagnostic: { code: "profile_mismatch", eventSequence: 1 },
		});
		store.database().close();
	});

	it("rejects a receipt whose payload generation differs from its owner-fenced event", () => {
		const { store, sessionId, fence } = fixture();
		appendReceipt(store, fence, standardReceipt(sessionId, 2), "generation-mismatch");

		expect(restoreSession(store, sessionId)).toMatchObject({
			ok: false,
			code: "harness_composition_corruption",
			diagnostic: { code: "generation_mismatch", eventSequence: 1 },
		});
		store.database().close();
	});

	it("rejects a receipt whose final composition digest is not derived from its bounded fields", () => {
		const { store, sessionId, fence } = fixture();
		const receipt = standardReceipt(sessionId);
		appendReceipt(store, fence, {
			...receipt,
			compositionDigest: runtimeDigest("tampered composition"),
		}, "digest-mismatch");

		expect(restoreSession(store, sessionId)).toMatchObject({
			ok: false,
			code: "harness_composition_corruption",
			diagnostic: { code: "composition_digest_mismatch", eventSequence: 1 },
		});
		store.database().close();
	});

	it("rejects duplicate composition receipts for one owner generation", () => {
		const { store, sessionId, fence } = fixture();
		const receipt = standardReceipt(sessionId);
		appendReceipt(store, fence, receipt, "duplicate-one");
		appendReceipt(store, fence, receipt, "duplicate-two");

		expect(restoreSession(store, sessionId)).toMatchObject({
			ok: false,
			code: "harness_composition_corruption",
			diagnostic: { code: "duplicate_generation", eventSequence: 2 },
		});
		store.database().close();
	});

	it.each([
		["valid checkpoint", "hit", true],
		["corrupt checkpoint", "corrupt", false],
		["deleted checkpoint", "deleted", false],
	] as const)("keeps the catalog profile authoritative with a %s", (_label, mode, expectedHit) => {
		const { store, sessionId, fence } = fixture();
		appendReceipt(store, fence, standardReceipt(sessionId), `checkpoint-${mode}`);
		const checkpoint = putSessionCheckpoint(store, fence, "paused", 1, {
			replayReady: true,
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
		});
		if (mode === "corrupt") {
			store.database().runSync(
				"UPDATE session_checkpoints SET snapshot_json = ? WHERE checkpoint_id = ?",
				["{}", checkpoint.checkpointId],
			);
		} else if (mode === "deleted") {
			store.database().runSync("UPDATE sessions SET current_checkpoint_id = NULL WHERE session_id = ?", [sessionId]);
			store.database().runSync("DELETE FROM session_checkpoints WHERE checkpoint_id = ?", [checkpoint.checkpointId]);
		}

		const restored = restoreSession(store, sessionId);
		expect(restored).toMatchObject({ ok: true, usedCheckpoint: expectedHit });
		expect(store.getSession(sessionId)?.harnessProfile).toEqual(standardHarnessProfileRef());
		store.database().close();
	});

	it("rejects a fenced generation before it can append another composition receipt", () => {
		const { store, sessionId, fence } = fixture();
		appendReceipt(store, fence, standardReceipt(sessionId), "old-generation-first");
		store.database().runSync(
			"UPDATE session_owners SET runtime_id = ?, generation = 2, state = 'running' WHERE session_id = ?",
			[createRuntimeId("runtime", "new-generation"), sessionId],
		);

		expect(() => appendReceipt(store, fence, standardReceipt(sessionId), "old-generation-second"))
			.toThrowError(expect.objectContaining({ code: "owner_fenced" }));
		expect(store.replaySessionEvents(sessionId).filter((event) => event.eventType === "harness.composed")).toHaveLength(1);
		store.database().close();
	});
});
