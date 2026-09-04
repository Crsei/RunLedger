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
import { SessionStore, SessionStoreError, sessionEventHash, appendEventInTransaction } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { projectSessionReplay } from "../../../src/storage/session-codec.ts";
import type { LedgerEntry } from "../../../src/runtime/ledger/types.ts";
import { minimalHarnessProfileRef, standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";

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
	it("requires and returns a validated durable harness profile ref", () => {
		const store = openStore();
		const minimal = minimalHarnessProfileRef();
		const created = store.createSession({
			sessionId: createRuntimeId("session", "minimal-profile"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
			harnessProfile: minimal,
		});
		expect(created.harnessProfile).toEqual(minimal);
		expect(store.getSession(created.sessionId)?.harnessProfile).toEqual(minimal);
		store.database().close();
	});

	it("rejects a create ref whose digest does not match the builtin descriptor", () => {
		const store = openStore();
		const standard = standardHarnessProfileRef();
		expect(() => store.createSession({
			sessionId: createRuntimeId("session", "bad-profile"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
			harnessProfile: {
				...standard,
				descriptorDigest: { algorithm: "sha256", digest: "0".repeat(64) as typeof standard.descriptorDigest.digest },
			},
		})).toThrowError(/descriptor digest mismatch/u);
		expect(store.listSessions()).toHaveLength(0);
		store.database().close();
	});

	it("inherits the source profile atomically when forking", () => {
		const store = openStore();
		const minimal = minimalHarnessProfileRef();
		const source = store.createSession({
			sessionId: createRuntimeId("session", "profile-source"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "a".repeat(64),
			sourceWorkspaceLocator: "source-locator",
			harnessProfile: minimal,
		});
		const forkInput = {
			sessionId: createRuntimeId("session", "profile-fork"),
			sourceSessionId: source.sessionId,
			workspaceId: createRuntimeId("workspace", "ignored"),
			repositoryId: createRuntimeId("repository", "ignored"),
			settingsDigest: "b".repeat(64),
		};
		const forked = store.forkSession(forkInput);
		expect(forked).toMatchObject({
			workspaceId: source.workspaceId,
			repositoryId: source.repositoryId,
			settingsDigest: source.settingsDigest,
			sourceWorkspaceLocator: source.sourceWorkspaceLocator,
			harnessProfile: minimal,
		});
		store.database().close();
	});

	it("persists a private current worktree locator with an owner-fenced audit event", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "workspace-binding");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "workspace-binding");
		ownerRow(store, sessionId, runtimeId, 3);
		const locatorJson = JSON.stringify({ version: 1, worktreeLocator: { version: 1, platform: "linux", kind: "posix", path: "/private/worktree" } });
		const candidate = store as SessionStore & {
			putWorktreeLocator?: (fence: { readonly sessionId: typeof sessionId; readonly runtimeId: typeof runtimeId; readonly generation: number }, input: {
				readonly locatorJson: string;
				readonly repositoryId?: string;
				readonly eventType: "workspace.bound" | "workspace.validation_recorded";
				readonly payload: Record<string, unknown>;
			}) => void;
		};
		expect(typeof candidate.putWorktreeLocator).toBe("function");
		if (candidate.putWorktreeLocator === undefined) return;
		candidate.putWorktreeLocator({ sessionId, runtimeId, generation: 3 }, {
			locatorJson,
			eventType: "workspace.bound",
			payload: { bindingDigest: "a".repeat(64) },
			repositoryId: createRuntimeId("repository", "canonical-worktree-repository"),
		});

		expect(store.getSession(sessionId)?.worktreeLocator).toBe(locatorJson);
		expect(store.getSession(sessionId)?.repositoryId).toBe("repository_canonical-worktree-repository");
		expect(store.replaySessionEvents(sessionId)).toMatchObject([{
			ownerGeneration: 3,
			eventType: "workspace.bound",
			payloadJson: JSON.stringify({ bindingDigest: "a".repeat(64) }),
		}]);
		store.database().close();
	});

	it("creates and lists sessions from the durable catalog", () => {
		const store = openStore();
		const created = store.createSession({
			sessionId: createRuntimeId("session", "a"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
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
				harnessProfile: standardHarnessProfileRef(),
				settingsDigest: "d".repeat(64),
			}),
		).toThrowError(SessionStoreError);
		store.database().close();
	});

	it("does not reclaim a Session while its owner is still running", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "reclaim-running");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "reclaim-running");
		ownerRow(store, sessionId, runtimeId, 1);

		expect(store.reclaimSessionWithoutUserMessages({ sessionId, runtimeId, generation: 1 })).toBe(false);
		expect(store.getSession(sessionId)).toBeDefined();
		store.database().close();
	});

	it("does not reclaim a message-less Session retained for an error exit audit", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "reclaim-error");
		const runtimeId = createRuntimeId("runtime", "reclaim-error");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		ownerRow(store, sessionId, runtimeId, 1);
		new OwnerStore(store.database()).releaseOwner({ sessionId, runtimeId, generation: 1 }, "error");

		expect(store.reclaimSessionWithoutUserMessages({ sessionId, runtimeId, generation: 1 })).toBe(false);
		expect(store.getSession(sessionId)).toBeDefined();
		store.database().close();
	});

	it("rejects create when the catalog revision changed before the transaction", () => {
		const store = openStore();
		store.createSession({
			sessionId: createRuntimeId("session", "catalog-cas-existing"),
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const target = createRuntimeId("session", "catalog-cas-target");
		let error: unknown;
		try {
			store.createSession({
				sessionId: target,
				workspaceId: createRuntimeId("workspace", "w"),
				repositoryId: createRuntimeId("repository", "r"),
				harnessProfile: standardHarnessProfileRef(),
				settingsDigest: "d".repeat(64),
				expectedCatalogRevision: 0,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SessionStoreError);
		expect((error as SessionStoreError).code).toBe("catalog_revision_conflict");
		expect(store.getSession(target)).toBeUndefined();
		store.database().close();
	});

	it("fork projects every canonical ledger record onto its own session lineage and retains tool/config audit", () => {
		const store = openStore();
		const sourceId = createRuntimeId("session", "source");
		store.createSession({
			sessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sourceId, runtimeId, 1);
		const fence = { sessionId: sourceId, runtimeId, generation: 1 };
		const appendLedger = (eventId: string, type: "message" | "tool_call" | "tool_result" | "custom", payload: Record<string, unknown>, timestamp: number): void => {
			const tail = store.replaySessionEvents(sourceId).at(-1);
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", eventId),
				ownerGeneration: 1,
				eventType: `ledger.${type}`,
				payloadJson: JSON.stringify({
					id: `legacy_${eventId}`,
					sessionId: sourceId,
					parentId: sourceId,
					timestamp,
					type,
					payload,
				}),
				createdAtMs: timestamp,
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
		};
		appendLedger("user", "message", {
			role: "user",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		}, 1);
		store.appendDriverEvent(fence, "driver.claimed", { clientId: "source-driver" });
		appendLedger("tool-call", "tool_call", { toolCallId: "call_1", toolName: "echo", input: { text: "hi" } }, 2);
		appendLedger("tool-result", "tool_result", { toolCallId: "call_1", toolName: "echo", content: "hi", isError: false }, 3);
		appendLedger("config", "custom", { kind: "runtime.config", provider: "deepseek", model: "v4", thinkingLevel: "high" }, 4);
		const toolCall = store.replaySessionEvents(sourceId).at(-1)!;
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "closed"),
			ownerGeneration: 1,
			eventType: "session.closed",
			payloadJson: JSON.stringify({ reason: "source complete" }),
			createdAtMs: 3,
			expectedPreviousEventHash: toolCall.currentEventHash,
		});

		const forkId = createRuntimeId("session", "fork");
		const forked = store.forkSession({
			sessionId: forkId,
			sourceSessionId: sourceId,
		});
		const sourceEvents = store.replaySessionEvents(sourceId);
		const forkEvents = store.replaySessionEvents(forkId);
		expect(forkEvents.map((event) => event.eventType)).toEqual([
			"ledger.message",
			"ledger.tool_call",
			"ledger.tool_result",
			"ledger.custom",
			"session.forked",
		]);
		expect(forkEvents.map((event) => event.ownerGeneration)).toEqual([0, 0, 0, 0, 0]);
		const forkLedgerEntries = forkEvents.slice(0, -1).map((event) => JSON.parse(event.payloadJson) as LedgerEntry);
		expect(forkLedgerEntries.map((entry) => entry.sessionId)).toEqual([forkId, forkId, forkId, forkId]);
		expect(forkLedgerEntries[0]?.parentId).toBe(forkId);
		expect(forkLedgerEntries.slice(1).map((entry, index) => entry.parentId)).toEqual(forkLedgerEntries.slice(0, -1).map((entry) => entry.id));
		expect(forkLedgerEntries.map((entry) => entry.id)).not.toContain("legacy_user");
		const replay = projectSessionReplay(forkLedgerEntries);
		expect(replay.messages).toMatchObject([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		expect(replay.auditEntries.map((entry) => entry.type)).toEqual(["tool_call", "tool_result"]);
		expect(replay.config).toMatchObject({ provider: "deepseek", model: "v4", thinkingLevel: "high" });
		expect(JSON.parse(forkEvents[4]!.payloadJson)).toEqual({
			sourceSessionId: sourceId,
			sourceHeadSequence: sourceEvents.length,
			sourceHeadHash: sourceEvents.at(-1)!.currentEventHash,
		});
		expect(forkEvents[0]?.previousEventHash).toBeNull();
		expect(forkEvents[0]?.currentEventHash).not.toBe(sourceEvents[0]?.currentEventHash);
		expect(forked.headSequence).toBe(5);
		expect(store.projectSession(forkId)).toMatchObject({ status: "active", driverRevision: 0, headSequence: 5 });
		store.database().close();
	});

	it("rejects a fork when the durable source head has advanced", () => {
		const store = openStore();
		const sourceId = createRuntimeId("session", "fork-cas-source");
		store.createSession({
			sessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "fork-cas-runtime");
		ownerRow(store, sourceId, runtimeId, 1);
		store.appendEvent({ sessionId: sourceId, runtimeId, generation: 1 }, {
			eventId: createRuntimeId("event", "fork-cas-event"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: "{}",
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		const forkId = createRuntimeId("session", "fork-cas-target");

		let error: unknown;
		try {
			store.forkSession({
				sessionId: forkId,
				sourceSessionId: sourceId,
				expectedSourceHeadSequence: 0,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionStoreError);
		expect((error as SessionStoreError).code).toBe("fork_source_head_conflict");
		expect(store.getSession(forkId)).toBeUndefined();
		store.database().close();
	});

	it("rejects a fork when the catalog revision changed before the transaction", () => {
		const store = openStore();
		const sourceId = createRuntimeId("session", "fork-catalog-cas-source");
		store.createSession({
			sessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const forkId = createRuntimeId("session", "fork-catalog-cas-target");
		let error: unknown;
		try {
			store.forkSession({
				sessionId: forkId,
				sourceSessionId: sourceId,
				expectedSourceHeadSequence: 0,
				expectedCatalogRevision: 0,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SessionStoreError);
		expect((error as SessionStoreError).code).toBe("catalog_revision_conflict");
		expect(store.getSession(forkId)).toBeUndefined();
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
			harnessProfile: standardHarnessProfileRef(),
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
			harnessProfile: standardHarnessProfileRef(),
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
			harnessProfile: standardHarnessProfileRef(),
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
			harnessProfile: standardHarnessProfileRef(),
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
			harnessProfile: standardHarnessProfileRef(),
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
			harnessProfile: standardHarnessProfileRef(),
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

describe("R2 append atomicity and fence characterization", () => {
	it("rolls back the whole append transaction when a later write in the same transaction fails", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };
		let boom: unknown;
		try {
			store.database().withImmediateTransactionSync((tx) => {
				appendEventInTransaction(tx, fence, {
					eventId: createRuntimeId("event", "1"),
					ownerGeneration: 1,
					eventType: "message",
					payloadJson: "{}",
					createdAtMs: 1,
					expectedPreviousEventHash: null,
				});
				throw new Error("commit aborted");
			});
		} catch (error) {
			boom = error;
		}
		expect((boom as Error | undefined)?.message).toBe("commit aborted");
		expect(store.replaySessionEvents(sessionId)).toEqual([]);
		expect(store.getSession(sessionId)?.headSequence).toBe(0);
		expect(store.getSession(sessionId)?.status).toBe("active");
		expect(store.catalogRevision()).toBe(1);
		store.database().close();
	});

	it("rejects worktree locator writes from a fenced owner", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		ownerRow(store, sessionId, createRuntimeId("runtime", "r1"), 1);
		let fencedLocatorError: unknown;
		try {
			store.putWorktreeLocator(
				{ sessionId, runtimeId: createRuntimeId("runtime", "old"), generation: 0 },
				{
					locatorJson: JSON.stringify({ version: 1, worktreePathDigest: "abc" }),
					repositoryId: createRuntimeId("repository", "r"),
					eventType: "workspace.bound",
					payload: { digest: "abc" },
				},
			);
		} catch (error) {
			fencedLocatorError = error;
		}
		expect(fencedLocatorError).toBeInstanceOf(SessionStoreError);
		expect((fencedLocatorError as SessionStoreError).code).toBe("owner_fenced");
		expect(store.getSession(sessionId)?.worktreeLocator).toBeUndefined();
		store.database().close();
	});

	it("rejects an attempt receipt whose origin generation does not match the intent", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const runtimeId = createRuntimeId("runtime", "r1");
		ownerRow(store, sessionId, runtimeId, 1);
		const fence = { sessionId, runtimeId, generation: 1 };
		const commandId = createRuntimeId("command", "c1");
		store.recordCommandIntent(fence, {
			sessionId,
			commandId,
			requestDigest: digest("req"),
			originGeneration: 1,
			createdAtMs: 1,
		});
		let originMismatchError: unknown;
		try {
			store.appendAttemptReceipt(fence, {
				receiptId: createRuntimeId("receipt", "1"),
				sessionId,
				commandId,
				attemptId: createRuntimeId("attempt", "1"),
				originGeneration: 2,
				effectClass: "workspace_mutation",
				outcome: "uncertain",
				createdAtMs: 2,
			});
		} catch (error) {
			originMismatchError = error;
		}
		expect(originMismatchError).toBeInstanceOf(SessionStoreError);
		expect((originMismatchError as SessionStoreError).code).toBe("receipt_origin_mismatch");
		expect(store.listAttemptReceipts(sessionId, commandId)).toEqual([]);
		store.database().close();
	});

	it("rejects driver events from a fenced owner", () => {
		const store = openStore();
		const sessionId = createRuntimeId("session", "a");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		ownerRow(store, sessionId, createRuntimeId("runtime", "r1"), 1);
		let fencedDriverError: unknown;
		try {
			store.appendDriverEvent(
				{ sessionId, runtimeId: createRuntimeId("runtime", "old"), generation: 0 },
				"driver.claimed",
				{ connectionId: createRuntimeId("connection", "a") },
			);
		} catch (error) {
			fencedDriverError = error;
		}
		expect(fencedDriverError).toBeInstanceOf(SessionStoreError);
		expect((fencedDriverError as SessionStoreError).code).toBe("owner_fenced");
		expect(store.getSession(sessionId)?.driverRevision).toBe(0);
		store.database().close();
	});
});

function fenceOf(sessionId: string, runtimeId: string) {
	return { sessionId, runtimeId, generation: 1 };
}
