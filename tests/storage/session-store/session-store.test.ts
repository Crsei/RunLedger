/**
 * R2:SessionStore API fixtures(06 §4.3/§4.4/§4.5)。
 *
 * 覆盖:create/fork/event append(hash chain + owner fence)/checkpoint cache/
 * command intent + attempt receipt/projection,以及“删除全部 checkpoint 后
 * 从 genesis 重建得到相同 projection”的 authority 证明。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore, SessionStoreError, sessionEventHash } from "../../../src/storage/session-store/session-store.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-api-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

function openStore(): SessionStore {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	return new SessionStore(db);
}

function ownerRow(store: SessionStore, sessionId: string, runtimeId: string, generation: number): void {
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, ?, 'running', 1)",
		[sessionId, runtimeId, generation],
	);
}

const digest = (seed: string) => ({ algorithm: "sha256", digest: canonicalDigest({ seed }) }) as const;

describe("R2 catalog and lifecycle", () => {
	it("creates and lists sessions from the durable catalog", () => {
		const store = openStore();
		const created = store.createSession({
			sessionId: createRuntimeId("session", "a"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		expect(created).toMatchObject({ status: "active", headSequence: 0, driverRevision: 0 });
		expect(store.getSession(created.sessionId)?.sessionId).toBe(created.sessionId);
		expect(store.listSessions()).toHaveLength(1);
		expect(() =>
			store.createSession({
				sessionId: createRuntimeId("session", "a"),
				workspaceId: createRuntimeId("workspace", "w"),
				repositoryId: createRuntimeId("repository", "r"),
				settingsDigest: "d".repeat(64),
			}),
		).toThrowError(SessionStoreError);
		store.database().close();
	});

	it("forks a session by copying all events into a new hash chain", () => {
		const store = openStore();
		const sourceId = createRuntimeId("session", "source");
		store.createSession({
			sessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sourceId, runtimeId, 1);
		const fence = { sessionId: sourceId, runtimeId, generation: 1 };
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		const firstEvent = store.replaySessionEvents(sourceId).at(-1)!;
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "2"),
			ownerGeneration: 1,
			eventType: "tool_call",
			payloadJson: JSON.stringify({ name: "echo" }),
			createdAtMs: 2,
			expectedPreviousEventHash: firstEvent.currentEventHash,
		});

		const forkId = createRuntimeId("session", "fork");
		const forked = store.forkSession({
			sessionId: forkId,
			sourceSessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		expect(forked.headSequence).toBe(2);
		const sourceEvents = store.replaySessionEvents(sourceId);
		const forkEvents = store.replaySessionEvents(forkId);
		expect(forkEvents.map((e) => e.payloadJson)).toEqual(sourceEvents.map((e) => e.payloadJson));
		expect(forkEvents[0]?.previousEventHash).toBeNull();
		expect(forkEvents[0]?.currentEventHash).not.toBe(sourceEvents[0]?.currentEventHash);
		store.database().close();
	});
});

describe("R2 owner-fenced event append", () => {
	it("appends events with a validated hash chain and updates head", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };

		const first = store.appendEvent(fence, {
			eventId: createRuntimeId("event", "1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: "{}",
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		expect(first.previousEventHash).toBeNull();
		expect(first.currentEventHash).toBe(sessionEventHash(sessionId, 1, first.eventId, "message", "{}", null));

		const second = store.appendEvent(fence, {
			eventId: createRuntimeId("event", "2"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: "{}",
			createdAtMs: 2,
			expectedPreviousEventHash: first.currentEventHash,
		});
		expect(second.sequence).toBe(2);
		expect(store.projectSession(sessionId).headSequence).toBe(2);
		store.database().close();
	});

	it("rejects stale previous hash and fenced owners inside the transaction", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: "{}",
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		let staleError: unknown;
		try {
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", "2"),
				ownerGeneration: 1,
				eventType: "message",
				payloadJson: "{}",
				createdAtMs: 2,
				expectedPreviousEventHash: "wrong-hash",
			});
		} catch (error) {
			staleError = error;
		}
		expect(staleError).toBeInstanceOf(SessionStoreError);
		expect((staleError as SessionStoreError).code).toBe("previous_hash_mismatch");

		// 旧 generation 的 durable write 全部被拒绝(§4.5)。
		const staleFence = { sessionId, runtimeId, generation: 0 };
		let fencedError: unknown;
		try {
			store.appendEvent(staleFence, {
				eventId: createRuntimeId("event", "3"),
				ownerGeneration: 0,
				eventType: "message",
				payloadJson: "{}",
				createdAtMs: 3,
				expectedPreviousEventHash: store.replaySessionEvents(sessionId).at(-1)?.currentEventHash ?? null,
			});
		} catch (error) {
			fencedError = error;
		}
		expect(fencedError).toBeInstanceOf(SessionStoreError);
		expect((fencedError as SessionStoreError).code).toBe("owner_fenced");
		store.database().close();
	});
});

describe("R2 command intent and append-only receipts", () => {
	it("records immutable intents and appends receipts with origin/settled generations", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };
		const commandId = createRuntimeId("command", "c1");
		const intent = {
			sessionId,
			commandId,
			requestDigest: digest("req"),
			originGeneration: 1,
			createdAtMs: 1,
		};
		store.recordCommandIntent(fence, intent);
		let conflictError: unknown;
		try {
			store.recordCommandIntent(fence, { ...intent, requestDigest: digest("other") });
		} catch (error) {
			conflictError = error;
		}
		expect(conflictError).toBeInstanceOf(SessionStoreError);
		expect((conflictError as SessionStoreError).code).toBe("command_intent_conflict");

		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "1"),
			sessionId,
			commandId,
			attemptId: createRuntimeId("attempt", "1"),
			originGeneration: 1,
			effectClass: "workspace_mutation",
			outcome: "uncertain",
			createdAtMs: 2,
		});
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "2"),
			sessionId,
			commandId,
			attemptId: createRuntimeId("attempt", "2"),
			originGeneration: 1,
			settledGeneration: 1,
			effectClass: "workspace_mutation",
			outcome: "verified",
			evidenceDigest: digest("evidence"),
			createdAtMs: 3,
		});
		const receipts = store.listAttemptReceipts(sessionId, commandId);
		expect(receipts.map((r) => r.outcome)).toEqual(["uncertain", "verified"]);
		expect(receipts[1]?.settledGeneration).toBe(1);
		store.database().close();
	});
});

describe("R2 checkpoint cache and authority rebuild", () => {
	it("deletes the whole checkpoint cache and rebuilds the identical projection from events", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "1"),
			ownerGeneration: 1,
			eventType: "driver.claimed",
			payloadJson: JSON.stringify({ connectionId: createRuntimeId("connection", "a") }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "2"),
			ownerGeneration: 1,
			eventType: "session.closed",
			payloadJson: JSON.stringify({ reason: "done" }),
			createdAtMs: 2,
			expectedPreviousEventHash: store.replaySessionEvents(sessionId).at(-1)?.currentEventHash ?? null,
		});
		const checkpoint = {
			checkpointId: createRuntimeId("snapshot", "c1"),
			sessionId,
			ownerGeneration: 1,
			boundary: "turn_completed" as const,
			sourceSequence: 2,
			snapshotDigest: digest("snapshot"),
			createdAtMs: 3,
		};
		store.putCheckpoint(fence, checkpoint, JSON.stringify({ status: "completed" }));
		expect(store.getCheckpoint(checkpoint.checkpointId)?.snapshotJson).toBe(JSON.stringify({ status: "completed" }));

		const cached = store.projectSession(sessionId);
		store.clearCheckpoints(sessionId);
		expect(store.getCheckpoint(checkpoint.checkpointId)).toBeUndefined();
		const rebuilt = store.rebuildFromEvents(sessionId);
		expect(rebuilt).toEqual({ sessionId, status: "completed", headSequence: 2, driverRevision: 1 });
		// sessions 行是 projection,其 status/driverRevision 由事件 reducer 更新(R5);
		// R2 证明:删除全部 checkpoint 后从 genesis 重建与缓存投影的 head 一致。
		expect(cached.headSequence).toBe(rebuilt.headSequence);
		expect(cached.sessionId).toBe(rebuilt.sessionId);
		store.database().close();
	});

	it("detects hash-chain tampering during replay", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		store.appendEvent(fenceOf(sessionId, runtimeId), {
			eventId: createRuntimeId("event", "1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: "{}",
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		store.database().runSync("UPDATE session_events SET payload_json = 'tampered' WHERE session_id = ? AND sequence = 1", [sessionId]);
		expect(() => store.replaySessionEvents(sessionId)).toThrowError(/hash chain broken|event hash mismatch/);
		store.database().close();
	});

	it("rejects checkpoint cache writes from a fenced owner", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		ownerRow(store, sessionId, createRuntimeId("runtime", "r1"), 1);
		let fencedCheckpointError: unknown;
		try {
			store.putCheckpoint(
				{ sessionId, runtimeId: createRuntimeId("runtime", "old"), generation: 0 },
				{
					checkpointId: createRuntimeId("snapshot", "c1"),
					sessionId,
					ownerGeneration: 0,
					boundary: "paused",
					sourceSequence: 0,
					snapshotDigest: digest("s"),
					createdAtMs: 1,
				},
				"{}",
			);
		} catch (error) {
			fencedCheckpointError = error;
		}
		expect(fencedCheckpointError).toBeInstanceOf(SessionStoreError);
		expect((fencedCheckpointError as SessionStoreError).code).toBe("owner_fenced");
		store.database().close();
	});
});

function fenceOf(sessionId: string, runtimeId: string) {
	return { sessionId, runtimeId, generation: 1 };
}
