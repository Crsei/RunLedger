/**
 * R5:crash recovery fixtures(06 §7.3/§R5 退出条件)。
 *
 * 覆盖:crash takeover 无条件进入 RECOVERY_REQUIRED、barrier 内 prompt 被拒、
 * model partial/tool uncertain 恢复状态机、origin/settled generation、
 * verified_clean 自动收口、resume_despite_uncertainty 显式收口、
 * 旧 owner 恢复写入被拒(self-stop)、旧外部 effect 不被错误宣称 fenced。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import { SessionRuntime } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import { bindCandidateListener } from "../../../src/runtime/session-server/owner-probe.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { createRuntimeHarness } from "./harness.ts";
import { SESSION_CORE_PROTOCOL_MANIFEST } from "../../../src/runtime/session-server/protocol.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-recovery-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

interface Ctx {
	store: SessionStore;
	ownerStore: OwnerStore;
	sessionId: SessionId;
}

function openCtx(seed = "rec"): Ctx {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	return { store, ownerStore, sessionId };
}

/** 可关闭 listener 的 transport(模拟 crash)。 */
function controllableTransport() {
	let bound: { close(): Promise<void> } | undefined;
	return {
		transport: {
			async bindCandidate() {
				const listener = await bindCandidateListener("127.0.0.1");
				bound = listener;
				return listener.endpoint;
			},
			async closeCandidate() {
				return undefined;
			},
			async probe(endpoint: { host: "127.0.0.1"; port: number }, input: { sessionId: string; expectedRuntimeId: string; expectedGeneration: number; authToken: string }, timeoutMs: number) {
				return { ok: false as const, code: "connect_failed" as const };
			},
		},
		closeListener: () => bound?.close(),
	};
}

/** 第一个 owner 正常 claim + 留下 crash 痕迹(started attempt),然后模拟 crash。 */
async function crashWithUnresolvedAttempt(ctx: Ctx): Promise<{ priorGeneration: number }> {
	const controlled = controllableTransport();
	const owner = new SessionOwner({ store: ctx.store, ownerStore: ctx.ownerStore, transport: controlled.transport });
	const claimed = await owner.open(ctx.sessionId);
	if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("expected claim");
	const fence = claimed.fence;
	// 记录一个 side-effect attempt(started)然后 crash。
	ctx.store.recordCommandIntent(fence, {
		sessionId: ctx.sessionId,
		commandId: createRuntimeId("command", "tool"),
		requestDigest: { algorithm: "sha256", digest: "a".repeat(64) },
		originGeneration: fence.generation,
		createdAtMs: Date.now(),
	});
	ctx.store.appendAttemptReceipt(fence, {
		receiptId: createRuntimeId("receipt", "started"),
		sessionId: ctx.sessionId,
		commandId: createRuntimeId("command", "tool"),
		attemptId: createRuntimeId("attempt", "tool-run"),
		originGeneration: fence.generation,
		effectClass: "process_spawn",
		outcome: "started",
		createdAtMs: Date.now(),
	});
	// crash:listener 关闭、heartbeat 过期、不 release。
	await controlled.closeListener();
	ctx.ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, ctx.sessionId]);
	return { priorGeneration: fence.generation };
}

/** 新 owner 经 takeover 建立 runtime(crashTakeover=true)。 */
async function takeoverRuntime(ctx: Ctx): Promise<{ runtime: SessionRuntime; owner: SessionOwner; server: SessionRuntimeServer }> {
	const server = new SessionRuntimeServer({ sessionId: ctx.sessionId, store: ctx.store, controller: nullController(ctx.sessionId) });
	const owner = new SessionOwner({ store: ctx.store, ownerStore: ctx.ownerStore, transport: server });
	const result = await owner.open(ctx.sessionId);
	if (!result.ok || result.outcome !== "claimed") throw new Error(`expected takeover claim, got ${JSON.stringify(result)}`);
	const restored = restoreSession(ctx.store, ctx.sessionId);
	if (!restored.ok) throw new Error("restore failed");
	const runtime = new SessionRuntime({
		sessionId: ctx.sessionId,
		store: ctx.store,
		ownerStore: ctx.ownerStore,
		owner,
		server,
		fence: result.fence,
		crashTakeover: true,
		restored,
	});
	server.bindController(runtime);
	runtime.start();
	return { runtime, owner, server };
}

function nullController(sessionId: SessionId) {
	return {
		sessionId,
		protocolManifest: () => SESSION_CORE_PROTOCOL_MANIFEST,
		snapshot: () => ({ sessionId, headSequence: 0, sessionStatus: "active", runtimeState: "starting" }),
		handleCommand: async () => ({ ok: false as const, code: "not_bound" }),
		handleQuery: async () => ({ ok: false, kind: "not_bound" }),
		onEvent: () => () => undefined,
		isMutatingKind: () => false,
	};
}

describe("R5 crash recovery", () => {
	it("projects an active wire status while the internal runtime is ready", async () => {
		const runtimeHarness = await createRuntimeHarness("wire-status");
		try {
			expect(runtimeHarness.runtime.runtimeState).toBe("ready");
			expect(runtimeHarness.runtime.snapshot().sessionStatus).toBe("active");
		} finally {
			await runtimeHarness.server.close();
			runtimeHarness.store.database().close();
			runtimeHarness.cleanup();
		}
	});

	it("projects safe completed run summaries at the same durable snapshot head", async () => {
		const runtimeHarness = await createRuntimeHarness("run-summary");
		try {
			let tail = runtimeHarness.store.replaySessionEvents(runtimeHarness.sessionId).at(-1);
			for (const [index, payload] of [
				{ type: "agent_start", timestamp: 1_000, runId: "run-summary-1" },
				{ type: "agent_end", timestamp: 1_250, runId: "run-summary-1", stopReason: "stop", elapsedMs: 250, activeDurationMs: 200, messageCountAtEnd: 2 },
			].entries()) {
				const appended = runtimeHarness.store.appendEvent(runtimeHarness.fence, {
					eventId: createRuntimeId("event", `run-summary-${index}`), ownerGeneration: runtimeHarness.fence.generation,
					eventType: "agent.event", payloadJson: JSON.stringify(payload), createdAtMs: payload.timestamp,
					expectedPreviousEventHash: tail?.currentEventHash ?? null,
				});
				tail = appended;
			}
			const snapshot = runtimeHarness.runtime.snapshot();
			expect(snapshot.headSequence).toBe(runtimeHarness.runtime.currentHeadSequence());
			expect(snapshot.agentRuns).toEqual([
				expect.objectContaining({ runId: "run-summary-1", status: "completed", stopReason: "stop", activeDurationMs: 200, messageCountAtEnd: 2 }),
			]);
			expect(JSON.stringify(snapshot.agentRuns)).not.toContain("prompt");
		} finally {
			await runtimeHarness.server.close();
			runtimeHarness.store.database().close();
			runtimeHarness.cleanup();
		}
	});

	it("enters RECOVERY_REQUIRED unconditionally after a crash takeover", async () => {
		const ctx = openCtx();
		await crashWithUnresolvedAttempt(ctx);
		const { runtime } = await takeoverRuntime(ctx);
		expect(runtime.runtimeState).toBe("recovery_required");
		expect(runtime.barrierState).toBe("open");
		expect(runtime.isRecoveryRequired).toBe(true);
		// owner row publish recovery_required。
		expect(ctx.ownerStore.readOwner(ctx.sessionId)?.state).toBe("recovery_required");
		// 事件序列连续:hash chain 校验通过(restore 已做)。
		expect(runtime.restoredCheckpoint).toBeUndefined();
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("blocks normal prompt admission while the barrier is open (spawnCount stays 0)", async () => {
		const ctx = openCtx();
		await crashWithUnresolvedAttempt(ctx);
		const { runtime } = await takeoverRuntime(ctx);
		const prompt = await runtime.handleCommand(
			{ commandId: createRuntimeId("command", "p"), kind: "prompt", body: { promptText: "hi" } },
			{ connectionId: createRuntimeId("connection", "c"), clientId: "client_x", isDriver: true },
		);
		expect(prompt).toMatchObject({ ok: false, code: "recovery_barrier_active" });
		// barrier 未收口前所有新副作用 spawnCount=0。
		expect(runtime.sideEffectSpawnCount).toBe(0);
		const sideEffect = runtime.beginAttempt("workspace_mutation");
		expect("error" in sideEffect && sideEffect.error).toBe("recovery_barrier_active");
		expect(runtime.sideEffectSpawnCount).toBe(0);
		// 只读检查允许。
		const readonly = runtime.beginAttempt("readonly");
		expect("attemptId" in readonly).toBe(true);
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("settles the prior attempt via recovery.verify with origin/settled generations", async () => {
		const ctx = openCtx();
		const { priorGeneration } = await crashWithUnresolvedAttempt(ctx);
		const { runtime } = await takeoverRuntime(ctx);
		expect(runtime.unresolvedAttemptsCount()).toBe(1);
		const explain = await runtime.handleCommand(
			{ commandId: createRuntimeId("command", "exp"), kind: "recovery_explain", body: {} },
			{ connectionId: createRuntimeId("connection", "c"), clientId: "client_x", isDriver: true },
		);
		expect(explain.ok).toBe(true);
		if (!explain.ok) throw new Error("expected ok");
		const unresolved = (explain.result.unresolvedAttempts as { attemptId: string; originGeneration: number }[]);
		expect(unresolved[0]!.originGeneration).toBe(priorGeneration);
		const verify = await runtime.handleCommand(
			{ commandId: createRuntimeId("command", "v"), kind: "recovery_verify", body: { attemptId: unresolved[0]!.attemptId } },
			{ connectionId: createRuntimeId("connection", "c"), clientId: "client_x", isDriver: true },
		);
		expect(verify.ok).toBe(true);
		expect(runtime.runtimeState).toBe("ready");
		expect(runtime.barrierState).toBe("closed");
		// settled generation = 新 generation > origin。
		const receipts = ctx.store.listAllAttemptReceipts(ctx.sessionId);
		const settled = receipts.find((receipt) => receipt.outcome === "verified");
		expect(settled?.settledGeneration).toBeGreaterThanOrEqual(priorGeneration);
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("auto-closes with recovery.verified_clean when no unresolved attempt exists", async () => {
		const ctx = openCtx();
		// 无 unresolved attempt 的 crash:直接收口。
		const { runtime } = await takeoverRuntime(ctx);
		expect(runtime.runtimeState).toBe("recovery_required");
		const assess = await runtime.handleCommand(
			{ commandId: createRuntimeId("command", "a"), kind: "recovery_assess", body: {} },
			{ connectionId: createRuntimeId("connection", "c"), clientId: "client_x", isDriver: true },
		);
		expect(assess.ok).toBe(true);
		expect(runtime.runtimeState).toBe("ready");
		expect(runtime.barrierState).toBe("closed");
		const events = ctx.store.replaySessionEvents(ctx.sessionId);
		expect(events.some((event) => event.eventType === "recovery.verified_clean")).toBe(true);
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("resume_despite_uncertainty records the explicit human decision and reopens side effects", async () => {
		const ctx = openCtx();
		await crashWithUnresolvedAttempt(ctx);
		const { runtime } = await takeoverRuntime(ctx);
		expect(runtime.runtimeState).toBe("recovery_required");
		const resume = await runtime.handleCommand(
			{ commandId: createRuntimeId("command", "r"), kind: "recovery_resume", body: { reasonCode: "user-accepted-uncertainty" } },
			{ connectionId: createRuntimeId("connection", "c"), clientId: "client_x", isDriver: true },
		);
		expect(resume.ok).toBe(true);
		expect(runtime.runtimeState).toBe("ready_with_uncertainty");
		expect(runtime.barrierState).toBe("closed");
		// 显式 decision 落库。
		const events = ctx.store.replaySessionEvents(ctx.sessionId);
		const decision = events.find((event) => event.eventType === "recovery.resume_despite_uncertainty");
		expect(decision).toBeDefined();
		const payload = JSON.parse(decision!.payloadJson) as Record<string, unknown>;
		expect(payload.reasonCode).toBe("user-accepted-uncertainty");
		expect(payload.settledGeneration).toBe(runtime.fence.generation);
		// 收口后 side-effect 恢复(新的 generation 记录 attempt)。
		const attempt = runtime.beginAttempt("process_spawn");
		expect("attemptId" in attempt).toBe(true);
		expect(runtime.sideEffectSpawnCount).toBe(1);
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("timeline queries the live durable event stream after runtime startup", async () => {
		const ctx = openCtx("timeline-live");
		const { runtime, owner } = await takeoverRuntime(ctx);
		const fence = owner.currentFence;
		if (fence === undefined) throw new Error("owner fence missing");
		const tail = ctx.store.replaySessionEvents(ctx.sessionId).at(-1);
		ctx.store.appendEvent(fence, {
			eventId: createRuntimeId("event", "after-startup"),
			ownerGeneration: fence.generation,
			eventType: "test.after_startup",
			payloadJson: JSON.stringify({ live: true }),
			createdAtMs: Date.now(),
			expectedPreviousEventHash: tail?.currentEventHash ?? null,
		});

		const timeline = await runtime.handleQuery({ kind: "timeline", body: { limit: 10 } });
		const events = timeline.events as readonly { eventType: string; payload: Record<string, unknown> }[];
		expect(events.at(-1)).toEqual({
			sequence: expect.any(Number),
			eventId: createRuntimeId("event", "after-startup"),
			eventType: "test.after_startup",
			payload: { live: true },
		});
		await runtime.server.close();
		ctx.store.database().close();
	});

	it("rejects the old owner's resume writes and self-stops it", async () => {
		const ctx = openCtx();
		const controlled = controllableTransport();
		let fencedFence: unknown = undefined;
		const oldOwner = new SessionOwner({
			store: ctx.store,
			ownerStore: ctx.ownerStore,
			transport: controlled.transport,
			onFenced: (fence) => {
				fencedFence = fence;
			},
		});
		const claimed = await oldOwner.open(ctx.sessionId);
		if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("expected claim");
		await controlled.closeListener();
		ctx.ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, ctx.sessionId]);
		// 新 owner takeover。
		const { runtime } = await takeoverRuntime(ctx);
		expect(runtime.fence.generation).toBe(claimed.fence.generation + 1);
		// 旧 owner 的 durable write 被拒(owner_fenced)。
		const oldFence = claimed.fence;
		expect(() =>
			ctx.store.appendEvent(oldFence, {
				eventId: createRuntimeId("event", "old"),
				ownerGeneration: oldFence.generation,
				eventType: "message",
				payloadJson: "{}",
				createdAtMs: Date.now(),
				expectedPreviousEventHash: null,
			}),
		).toThrowError(/owner fenced/u);
		// 旧 owner heartbeat 触发 self-stop。
		oldOwner.startHeartbeat();
		await new Promise((resolve) => setTimeout(resolve, 3_200));
		expect(oldOwner.isStopping).toBe(true);
		expect(fencedFence).toMatchObject({ sessionId: ctx.sessionId, runtimeId: oldFence.runtimeId, generation: oldFence.generation });
		// 不把"DB fence"宣称成"外部副作用已停止":事件流中无 recovery.verified_clean。
		expect(ctx.store.replaySessionEvents(ctx.sessionId).some((event) => event.eventType === "recovery.verified_clean")).toBe(false);
		await runtime.server.close();
		ctx.store.database().close();
	});
});
