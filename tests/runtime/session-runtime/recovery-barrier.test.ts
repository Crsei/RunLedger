/**
 * R5:recovery barrier fixtures(06 §7.3)。
 *
 * 覆盖:barrier 内 readonly 放行 / side-effect 拒绝(spawnCount=0)、
 * verified_clean 收口、verify 收口(origin/settled generation)、abort、
 * resume_despite_uncertainty receipt(principal/reason/origin/settled + evidence)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { RecoveryBarrier, type RecoveryDecision } from "../../../src/runtime/session-runtime/recovery-barrier.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-recovery-barrier-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function openStore(): { store: SessionStore; sessionId: SessionId; fence: { sessionId: SessionId; runtimeId: string; generation: number } } {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "rb");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	const runtimeId = createRuntimeId("runtime", "r");
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	return { store, sessionId, fence: { sessionId, runtimeId, generation: 1 } };
}

const evidence = (seed: string) => ({ algorithm: "sha256" as const, digest: canonicalDigest({ seed }) as string & { readonly __sha256Digest: true } });

describe("R5 recovery barrier", () => {
	it("allows readonly checks and rejects side-effect mutations while open", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		expect(barrier.isOpen).toBe(true);
		expect(barrier.admitMutation("readonly")).toEqual({ ok: true });
		expect(barrier.admitMutation("workspace_mutation")).toEqual({ ok: false, code: "recovery_barrier_active" });
		expect(barrier.admitMutation("process_spawn")).toEqual({ ok: false, code: "recovery_barrier_active" });
		expect(barrier.admitMutation("external_mutation")).toEqual({ ok: false, code: "recovery_barrier_active" });
		expect(barrier.admitPrompt()).toEqual({ ok: false, code: "recovery_barrier_active" });
		// 证据:barrier 未收口前新副作用 spawnCount = 0。
		expect(barrier.sideEffectSpawnCount).toBe(0);
		store.database().close();
	});

	it("counts admitted side effects only when the barrier is closed", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "closed");
		expect(barrier.admitMutation("workspace_mutation")).toEqual({ ok: true });
		expect(barrier.admitMutation("process_spawn")).toEqual({ ok: true });
		expect(barrier.sideEffectSpawnCount).toBe(2);
		store.database().close();
	});

	it("auto-closes via assess() when no unresolved attempts remain", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		expect(barrier.hasUnresolvedAttempts()).toBe(false);
		const result = barrier.assess();
		expect(result).toMatchObject({ ok: true, state: "closed", unresolvedRemaining: 0 });
		expect(barrier.isOpen).toBe(false);
		// 收口有 durable recovery.verified_clean 事件。
		const events = store.replaySessionEvents(fence.sessionId);
		expect(events.some((event) => event.eventType === "recovery.verified_clean")).toBe(true);
		store.database().close();
	});

	it("keeps the barrier open while an unresolved attempt exists", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		// 遗留 started receipt(模拟 crash 于 tool running 中)。
		store.recordCommandIntent(fence, {
			sessionId: fence.sessionId,
			commandId: createRuntimeId("command", "c1"),
			requestDigest: evidence("c1"),
			originGeneration: 1,
			createdAtMs: 1,
		});
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "r1"),
			sessionId: fence.sessionId,
			commandId: createRuntimeId("command", "c1"),
			attemptId: createRuntimeId("attempt", "a1"),
			originGeneration: 1,
			effectClass: "process_spawn",
			outcome: "started",
			createdAtMs: 1,
		});
		expect(barrier.hasUnresolvedAttempts()).toBe(true);
		expect(barrier.assess()).toMatchObject({ ok: true, state: "open", unresolvedRemaining: 1 });
		store.database().close();
	});

	it("treats interrupted as unresolved until it is explicitly verified or accepted", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		const commandId = createRuntimeId("command", "interrupted");
		const attemptId = createRuntimeId("attempt", "interrupted");
		store.recordCommandIntent(fence, {
			sessionId: fence.sessionId,
			commandId,
			requestDigest: evidence("interrupted"),
			originGeneration: 1,
			createdAtMs: 1,
		});
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "interrupted"),
			sessionId: fence.sessionId,
			commandId,
			attemptId,
			originGeneration: 1,
			effectClass: "process_spawn",
			outcome: "interrupted",
			createdAtMs: 1,
		});
		expect(barrier.unresolvedAttempts().map((receipt) => receipt.attemptId)).toEqual([attemptId]);
		store.database().close();
	});

	it("verifies an attempt with settled generation >= origin and closes when none remain", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		const attemptId = createRuntimeId("attempt", "a1");
		store.recordCommandIntent(fence, {
			sessionId: fence.sessionId,
			commandId: createRuntimeId("command", "c1"),
			requestDigest: evidence("c1"),
			originGeneration: 1,
			createdAtMs: 1,
		});
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "r1"),
			sessionId: fence.sessionId,
			commandId: createRuntimeId("command", "c1"),
			attemptId,
			originGeneration: 1,
			effectClass: "external_mutation",
			outcome: "uncertain",
			createdAtMs: 1,
		});
		const decision: RecoveryDecision = { kind: "verify", attemptId, outcome: "settled", evidenceDigest: evidence("evidence") };
		const result = barrier.decide(decision);
		expect(result).toMatchObject({ ok: true, state: "closed", unresolvedRemaining: 0 });
		const receipts = store.listAllAttemptReceipts(fence.sessionId);
		expect(receipts).toHaveLength(2);
		const settled = receipts.find((receipt) => receipt.outcome === "verified");
		expect(settled?.settledGeneration).toBe(1);
		expect(settled?.originGeneration).toBe(1);
		expect(settled?.evidenceDigest?.digest).toBe(evidence("evidence").digest);
		store.database().close();
	});

	it("records abort without closing the barrier", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		const result = barrier.decide({ kind: "abort", reasonCode: "operator-abort" });
		expect(result).toMatchObject({ ok: true, state: "open" });
		const events = store.replaySessionEvents(fence.sessionId);
		expect(events.some((event) => event.eventType === "recovery.abort" && JSON.parse(event.payloadJson).reasonCode === "operator-abort")).toBe(true);
		store.database().close();
	});

	it("resume_despite_uncertainty records principal/reason/origin/settled and opens mutations", () => {
		const { store, fence } = openStore();
		const barrier = new RecoveryBarrier({ store, fence }, "open");
		const commandId = createRuntimeId("command", "accepted");
		const attemptId = createRuntimeId("attempt", "accepted");
		store.recordCommandIntent(fence, {
			sessionId: fence.sessionId,
			commandId,
			requestDigest: evidence("accepted"),
			originGeneration: 1,
			createdAtMs: 1,
		});
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "accepted-started"),
			sessionId: fence.sessionId,
			commandId,
			attemptId,
			originGeneration: 1,
			effectClass: "external_mutation",
			outcome: "uncertain",
			createdAtMs: 1,
		});
		const decision: RecoveryDecision = {
			kind: "resume_despite_uncertainty",
			principalId: createRuntimeId("principal", "operator"),
			reasonCode: "user-accepted-uncertainty",
			originGeneration: 1,
			settledGeneration: 1,
			evidenceDigest: evidence("resume"),
		};
		const result = barrier.decide(decision);
		expect(result).toMatchObject({ ok: true, state: "closed" });
		const events = store.replaySessionEvents(fence.sessionId);
		const resume = events.find((event) => event.eventType === "recovery.resume_despite_uncertainty");
		expect(resume).toBeDefined();
		const payload = JSON.parse(resume!.payloadJson) as Record<string, unknown>;
		expect(payload.principalId).toContain("principal_");
		expect(payload.reasonCode).toBe("user-accepted-uncertainty");
		expect(payload.originGeneration).toBe(1);
		expect(payload.settledGeneration).toBe(1);
		const latest = store.listAllAttemptReceipts(fence.sessionId).at(-1);
		expect(latest).toMatchObject({ attemptId, outcome: "uncertain", originGeneration: 1, settledGeneration: 1 });
		const replayed = new RecoveryBarrier({ store, fence }, "open");
		expect(replayed.unresolvedAttempts()).toHaveLength(0);
		// 收口后 side-effect 恢复。
		expect(barrier.admitMutation("workspace_mutation")).toEqual({ ok: true });
		store.database().close();
	});
});
