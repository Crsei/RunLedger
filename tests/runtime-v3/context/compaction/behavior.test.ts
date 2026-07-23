import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../../../../src/runtime/protocol/v3/capability.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../../../../src/runtime/protocol/v3/taint.ts";
import { calculateCompactionInvariantDigest } from "../../../../src/runtime/context/invariants.ts";
import { planCompactionCut, type CompactionSourceEntry } from "../../../../src/runtime/context/compaction/cut-planner.ts";
import {
	decideAutoCompaction,
	CompactionService,
	OverflowRecoveryGuard,
	type CompactionProjectionPort,
	type CompactionRuntimeEvent,
} from "../../../../src/runtime/context/compaction/service.ts";
import { reduceCompactionAttempt, rewindCompactionProjection } from "../../../../src/runtime/context/compaction/reducer.ts";
import type { CompactionInvariantSnapshot } from "../../../../src/runtime/context/compaction/types.ts";
import { authorityId, DIGEST, NOW, principalId, sessionId, tenantId, traceId, workspace } from "../../plan-context-memory/helpers.ts";

function entry(sequence: number, turnId: string, kind: CompactionSourceEntry["kind"], content: string, extra: Partial<CompactionSourceEntry> = {}): CompactionSourceEntry {
	return {
		sequence,
		turnId,
		kind,
		content,
		contentDigest: canonicalDigest(content),
		stable: true,
		turnCompleted: kind === "assistant" || kind === "tool_result",
		inputSources: [],
		declassificationReceipts: [],
		...extra,
	};
}

function history(): readonly CompactionSourceEntry[] {
	return [
		entry(1, "turn-1", "user", "first request ".repeat(20), { turnCompleted: false }),
		entry(2, "turn-1", "tool_call", "call read", { toolCallId: "tool-1", turnCompleted: false }),
		entry(3, "turn-1", "tool_result", "result ".repeat(20), { toolCallId: "tool-1" }),
		entry(4, "turn-2", "user", "second request ".repeat(20), { turnCompleted: false }),
		entry(5, "turn-2", "assistant", "second answer ".repeat(20)),
		entry(6, "turn-3", "user", "current request", { turnCompleted: false }),
		entry(7, "turn-3", "assistant", "current answer"),
	];
}

function invariant(toolPairingDigest: string, overrides: Partial<Omit<CompactionInvariantSnapshot, "invariantDigest">> = {}): CompactionInvariantSnapshot {
	const body: Omit<CompactionInvariantSnapshot, "invariantDigest"> = {
		authorityId,
		tenantId,
		sessionId,
		workspace,
		modeRevision: 4,
		pendingApprovalIds: [],
		goalStateDigest: canonicalDigest("goal"),
		taskStateDigest: canonicalDigest("task"),
		workspaceStateDigest: canonicalDigest("workspace"),
		verificationStateDigest: canonicalDigest("verification"),
		toolPairingDigest,
		inputSources: [],
		declassificationReceipts: [],
		...overrides,
	};
	return { ...body, invariantDigest: calculateCompactionInvariantDigest(body) };
}

function taintFixture(): { source: InputSourceRef; receipt: DeclassificationReceiptRef } {
	const source: InputSourceRef = {
		schemaVersion: 1,
		authorityId,
		tenantId,
		sourceId: createRuntimeId("inputSource", "compact-taint"),
		kind: "model",
		sourceDigest: canonicalDigest("tainted compact source"),
		trust: "derived",
		taintLabels: ["model_derived"],
		observedAt: NOW,
	};
	const body = {
		schemaVersion: 1 as const,
		authorityId,
		tenantId,
		receiptId: createRuntimeId("declassification", "compact-context"),
		sourceId: source.sourceId,
		sourceDigest: source.sourceDigest,
		allowedSink: "context" as const,
		policyDigest: DIGEST,
		approverPrincipalId: principalId,
		decisionRevision: 1,
		issuedAt: NOW,
	};
	return { source, receipt: { ...body, receiptDigest: canonicalDigest(body) } };
}

function artifact(body: string, kind: ArtifactRef["kind"]): ArtifactRef {
	const storedDigest = canonicalDigest(body);
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", `${kind}-${storedDigest.slice(0, 30)}`),
		storedDigest,
		kind,
		originalSize: Buffer.byteLength(body),
		storedSize: Buffer.byteLength(body),
		mediaType: kind === "log" ? "application/json" : "text/markdown",
		redaction: "metadata_only",
		transformReceipt: createRuntimeId("receipt", `${kind}-${storedDigest.slice(0, 30)}`),
	};
}

function projectionPort(installed: string[] = [], failMessage?: string): CompactionProjectionPort {
	return {
		install: async (request) => {
			if (failMessage) throw new Error(failMessage);
			installed.push(request.projection.projectionDigest);
			const body = {
				schemaVersion: 1 as const,
				authorityId,
				tenantId,
				sessionId,
				receiptId: createRuntimeId("receipt", `install-${request.projection.checkpoint.checkpointId}`),
				state: "live_projection_installed" as const,
				checkpointId: request.projection.checkpoint.checkpointId,
				checkpointDigest: request.projection.checkpoint.checkpointDigest,
				replacementHistoryArtifact: request.projection.checkpoint.replacementHistoryArtifact,
				replacementHistoryDigest: request.projection.checkpoint.replacementHistoryDigest,
				expectedProjectionRevision: request.expectedProjectionRevision,
				installedProjectionRevision: request.expectedProjectionRevision + 1,
				previousProjectionDigest: request.previousProjectionDigest,
				projectionDigest: request.projection.projectionDigest,
				installedAt: NOW,
			};
			return { ...body, receiptDigest: canonicalDigest(body) };
		},
	};
}

describe("compaction cut and service", () => {
	it("cuts only complete turns and never splits a tool pair", () => {
		const planned = planCompactionCut(history(), 1);
		expect(planned).toMatchObject({ ok: true, cut: { sourceFromSequence: 1, sourceToSequence: 5, retainedFromSequence: 6, completedTurnCount: 2 } });
		const crossing = [
			entry(1, "turn-1", "tool_call", "call", { toolCallId: "cross", turnCompleted: false }),
			entry(2, "turn-2", "assistant", "middle", { turnCompleted: true }),
			entry(3, "turn-3", "tool_result", "result", { toolCallId: "cross", turnCompleted: false }),
			entry(4, "turn-3", "assistant", "later", { turnCompleted: true }),
		];
		expect(planCompactionCut(crossing, 1)).toMatchObject({ ok: false, reason: "no_safe_cut" });
	});

	it("commits a validated checkpoint before switching projection", async () => {
		const entries = history();
		const planned = planCompactionCut(entries, 1);
		if (!planned.ok) throw new Error("fixture has no cut");
		const snapshot = invariant(planned.cut.toolPairingDigest);
		const events: CompactionRuntimeEvent[] = [];
		const projections: string[] = [];
		const service = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId },
			sampler: { sample: async (_input, options) => {
				expect(options.tools).toEqual([]);
				return "Goal: preserve the audited objective. Completed: first two turns. Pending: current turn.";
			} },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async (event) => { events.push(event); } },
			projection: projectionPort(projections),
			clock: () => new Date(NOW),
		});
		const result = await service.compact({
			commandId: createRuntimeId("command", "compact"), traceId, reason: "manual", history: entries,
			retainedTurns: 1, maxInputChars: 50_000, maxSummaryTokens: 500, targetInputBudget: 2_000, timeoutMs: 1_000,
			summarizerProfileId: createRuntimeId("resource", "summarizer"), summarizerProfileDigest: DIGEST,
			originalProjectionDigest: canonicalDigest("original"), expectedProjectionRevision: 0, captureInvariants: () => snapshot,
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("compaction failed");
		expect(result.lifecycleState).toBe("live_projection_installed");
		expect(result.checkpoint.validation.outcome).toBe("valid");
		expect(result.projection.retained.map((item) => item.sequence)).toEqual([6, 7]);
		expect(events.map((event) => event.type)).toEqual(["compaction.started", "compaction.completed"]);
		expect(projections).toEqual([result.projection.projectionDigest]);
	});

	it("keeps the original projection on secret/validation failure and reports artifact crash", async () => {
		const entries = history();
		const planned = planCompactionCut(entries, 1);
		if (!planned.ok) throw new Error("fixture has no cut");
		const snapshot = invariant(planned.cut.toolPairingDigest);
		const events: CompactionRuntimeEvent[] = [];
		const projections: string[] = [];
		const service = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId },
			sampler: { sample: async () => "-----BEGIN PRIVATE KEY-----\nsecret" },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async (event) => { events.push(event); } },
			projection: projectionPort(projections),
			clock: () => new Date(NOW),
		});
		const result = await service.compact({
			commandId: createRuntimeId("command", "secret"), traceId, reason: "manual", history: entries,
			retainedTurns: 1, maxInputChars: 50_000, maxSummaryTokens: 500, targetInputBudget: 2_000, timeoutMs: 1_000,
			summarizerProfileId: createRuntimeId("resource", "summarizer"), summarizerProfileDigest: DIGEST,
			originalProjectionDigest: canonicalDigest("original"), expectedProjectionRevision: 0, captureInvariants: () => snapshot,
		});
		expect(result).toMatchObject({ ok: false, status: "failed", errorCode: "validation_failed" });
		expect(projections).toEqual([]);
		expect(events.at(-1)?.type).toBe("compaction.failed");
	});

	it("preserves taint/declassification through summary artifacts and rejects invariant lineage loss", async () => {
		const taint = taintFixture();
		const entries = history().map((item, index) => index === 0
			? { ...item, inputSources: [taint.source], declassificationReceipts: [taint.receipt] }
			: item);
		const planned = planCompactionCut(entries, 1);
		if (!planned.ok) throw new Error("fixture has no cut");
		const snapshot = invariant(planned.cut.toolPairingDigest, { inputSources: [taint.source], declassificationReceipts: [taint.receipt] });
		const artifactInputs: Array<{ kind: "log" | "session_report"; body: string; inputSources: readonly InputSourceRef[]; declassificationReceipts: readonly DeclassificationReceiptRef[] }> = [];
		const service = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId },
			sampler: { sample: async () => "Audited summary" },
			artifacts: { put: async (input) => { artifactInputs.push(input); return artifact(input.body, input.kind); } },
			events: { append: async () => undefined },
			projection: projectionPort(),
			clock: () => new Date(NOW),
		});
		const request = {
			commandId: createRuntimeId("command", "taint-preserved"), traceId, reason: "manual" as const, history: entries,
			retainedTurns: 1, maxInputChars: 50_000, maxSummaryTokens: 500, targetInputBudget: 2_000, timeoutMs: 1_000,
			summarizerProfileId: createRuntimeId("resource", "summarizer"), summarizerProfileDigest: DIGEST,
			originalProjectionDigest: canonicalDigest("original"), expectedProjectionRevision: 0, captureInvariants: () => snapshot,
		};
		expect(await service.compact(request)).toMatchObject({ ok: true });
		expect(artifactInputs).toHaveLength(3);
		expect(artifactInputs.slice(1)).toEqual([
			expect.objectContaining({ inputSources: [taint.source], declassificationReceipts: [taint.receipt] }),
			expect.objectContaining({ inputSources: [taint.source], declassificationReceipts: [taint.receipt] }),
		]);
		expect(JSON.parse(artifactInputs[2]?.body ?? "null")).toMatchObject({
			kind: "compaction_replacement_history",
			survivingSuffixFromSequence: 6,
			retained: [
				{ sequence: 6, content: "current request" },
				{ sequence: 7, content: "current answer" },
			],
		});

		let captures = 0;
		const changed = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId },
			sampler: { sample: async () => "Audited summary" },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async () => undefined },
			projection: projectionPort([], "projection must not install"),
			clock: () => new Date(NOW),
		});
		const lost = await changed.compact({
			...request,
			commandId: createRuntimeId("command", "taint-lost"),
			captureInvariants: () => ++captures === 1 ? snapshot : invariant(planned.cut.toolPairingDigest),
		});
		expect(lost).toMatchObject({ ok: false, status: "failed", errorCode: "validation_failed" });
	});

	it("keeps artifact/event/projection crash boundaries unambiguous", async () => {
		const entries = history();
		const planned = planCompactionCut(entries, 1);
		if (!planned.ok) throw new Error("fixture has no cut");
		const snapshot = invariant(planned.cut.toolPairingDigest);
		const request = {
			commandId: createRuntimeId("command", "crash-boundary"), traceId, reason: "manual" as const, history: entries,
			retainedTurns: 1, maxInputChars: 50_000, maxSummaryTokens: 500, targetInputBudget: 2_000, timeoutMs: 1_000,
			summarizerProfileId: createRuntimeId("resource", "summarizer"), summarizerProfileDigest: DIGEST,
			originalProjectionDigest: canonicalDigest("original"), expectedProjectionRevision: 0, captureInvariants: () => snapshot,
		};

		const artifactEvents: CompactionRuntimeEvent[] = [];
		const artifactFailure = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId }, sampler: { sample: async () => "summary" },
			artifacts: { put: async () => { throw new Error("artifact unavailable"); } },
			events: { append: async (event) => { artifactEvents.push(event); } }, projection: projectionPort([], "must not install"),
		});
		expect(await artifactFailure.compact(request)).toMatchObject({ ok: false, status: "failed" });
		expect(artifactEvents.map((event) => event.type)).toEqual(["compaction.failed"]);

		const completionEvents: CompactionRuntimeEvent[] = [];
		const eventFailure = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId }, sampler: { sample: async () => "summary" },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async (event) => {
				if (event.type === "compaction.completed") throw new Error("event unavailable");
				completionEvents.push(event);
			} }, projection: projectionPort([], "must not install"), clock: () => new Date(NOW),
		});
		expect(await eventFailure.compact(request)).toMatchObject({
			ok: false,
			status: "failed",
			lifecycleState: "prepared",
		});
		expect(completionEvents.map((event) => event.type)).toEqual(["compaction.started", "compaction.failed"]);

		const projectionEvents: CompactionRuntimeEvent[] = [];
		const projectionFailure = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId }, sampler: { sample: async () => "summary" },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async (event) => { projectionEvents.push(event); } },
			projection: projectionPort([], "projection unavailable"), clock: () => new Date(NOW),
		});
		const committed = await projectionFailure.compact(request);
		expect(committed).toMatchObject({
			ok: false,
			status: "recovery_required",
			errorCode: "projection_recovery_required",
			lifecycleState: "durably_committed",
		});
		expect(projectionEvents.map((event) => event.type)).toEqual(["compaction.started", "compaction.completed"]);
		if (committed.ok || committed.status !== "recovery_required") throw new Error("fixture did not reach durable commit");
		const recoveredInstalls: string[] = [];
		const recovering = new CompactionService({
			identity: { authorityId, tenantId, principalId, sessionId }, sampler: { sample: async () => "unused" },
			artifacts: { put: async (input) => artifact(input.body, input.kind) },
			events: { append: async () => undefined }, projection: projectionPort(recoveredInstalls), clock: () => new Date(NOW),
		});
		const recovered = await recovering.installCommittedProjection({
			checkpoint: committed.checkpoint,
			projection: committed.projection,
			expectedProjectionRevision: 0,
			previousProjectionDigest: request.originalProjectionDigest,
		});
		expect(recovered.lifecycleState).toBe("live_projection_installed");
		expect(recoveredInstalls).toEqual([committed.projection.projectionDigest]);
	});
});

describe("auto/overflow/resume controls", () => {
	it("explains threshold, flush, suppression, and invalid config decisions", () => {
		expect(decideAutoCompaction({ estimatedInputTokens: 800, contextWindowTokens: 1_000, thresholdPercent: 80, reservedTokens: 100, isFlushing: false, suppressed: false })).toMatchObject({ trigger: true, reason: "threshold_reached" });
		expect(decideAutoCompaction({ estimatedInputTokens: 800, contextWindowTokens: 1_000, thresholdPercent: 80, reservedTokens: 100, isFlushing: true, suppressed: false })).toMatchObject({ trigger: false, reason: "flush_in_progress" });
		expect(decideAutoCompaction({ estimatedInputTokens: 800, contextWindowTokens: 1_000, thresholdPercent: 99, reservedTokens: 100, isFlushing: false, suppressed: false })).toMatchObject({ trigger: false, reason: "invalid_config" });
	});

	it("allows overflow recovery once and never after side effects", () => {
		const guard = new OverflowRecoveryGuard();
		expect(guard.claim("request-1", false)).toBe(true);
		expect(guard.claim("request-1", false)).toBe(false);
		expect(guard.claim("request-2", true)).toBe(false);
	});

	it("rewind drops future checkpoint projections without rewriting raw audit", () => {
		const checkpoint = {
			schemaVersion: 1 as const, authorityId, tenantId, checkpointId: createRuntimeId("checkpoint", "one"),
			compactionId: createRuntimeId("compaction", "one"), sessionId, sourceFromSequence: 1, sourceToSequence: 5,
			retainedFromSequence: 6, summaryArtifact: artifact("summary", "session_report"), summaryDigest: canonicalDigest("summary"),
			survivingSuffixFromSequence: 6,
			replacementHistoryArtifact: artifact("replacement", "log"),
			replacementHistoryDigest: canonicalDigest("replacement"),
			invariantDigest: DIGEST, checkpointDigest: canonicalDigest("checkpoint"),
		};
		const attempt = { schemaVersion: 1 as const, authorityId, tenantId, principalId, receiptId: createRuntimeId("receipt", "compact"), compactionId: checkpoint.compactionId, sessionId, status: "completed" as const, attemptDigest: DIGEST, checkpoint, completedAt: NOW };
		const state = reduceCompactionAttempt({ checkpoints: [] }, attempt);
		const secondCheckpoint = {
			...checkpoint,
			checkpointId: createRuntimeId("checkpoint", "two"),
			compactionId: createRuntimeId("compaction", "two"),
			sourceFromSequence: 6,
			sourceToSequence: 9,
			retainedFromSequence: 10,
			survivingSuffixFromSequence: 10,
			previousCheckpointId: checkpoint.checkpointId,
			previousCheckpointDigest: checkpoint.checkpointDigest,
			previousReplacementHistoryDigest: checkpoint.replacementHistoryDigest,
			checkpointDigest: canonicalDigest("checkpoint-two"),
		};
		const secondAttempt = { ...attempt, receiptId: createRuntimeId("receipt", "compact-two"), compactionId: secondCheckpoint.compactionId, checkpoint: secondCheckpoint };
		const chained = reduceCompactionAttempt(state, secondAttempt);
		expect(chained.checkpoints).toHaveLength(2);
		expect(rewindCompactionProjection(chained, 5)).toMatchObject({ checkpoints: [checkpoint], latest: checkpoint });
		expect(rewindCompactionProjection(state, 4)).toEqual({ checkpoints: [], latest: undefined });
		expect(() => reduceCompactionAttempt(state, { ...secondAttempt, checkpoint: { ...secondCheckpoint, previousCheckpointDigest: DIGEST } })).toThrow("does not extend");
	});
});
