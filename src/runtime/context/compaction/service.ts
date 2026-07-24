import { canonicalDigest, canonicalJson } from "../../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import type { RuntimeEventPayloadMap } from "../../protocol/v3/event-payloads.ts";
import { createRuntimeId, type AuthorityId, type CommandId, type CompactionId, type PrincipalId, type ResourceId, type SessionId, type TenantId, type TraceId } from "../../protocol/v3/ids.ts";
import { inputSourcesAllowedAtSink, propagateInputSources, type DeclassificationReceiptRef, type InputSourceRef } from "../../protocol/v3/taint.ts";
import { conservativeTokenEstimate } from "../token-estimator.ts";
import type {
	CompactionCheckpoint,
	CompactionCheckpointRef,
	CompactionInvariantSnapshot,
	CompactionProjectionInstallationReceipt,
	CompactionReason,
	CompactionSuppressionReason,
} from "./types.ts";
import { planCompactionCut, type CompactionSourceEntry } from "./cut-planner.ts";
import { createCompactedHistoryProjection, type CompactedHistoryProjection } from "./projection.ts";
import { summarizeCompactionEntries, type CompactionSummarySampler } from "./summarizer.ts";
import { validateCompactionSummary } from "./validator.ts";
import { isCompactionCheckpoint, isCompactionProjectionInstallationReceipt } from "./schema.ts";

export type CompactionRuntimeEvent = {
	[TType in "compaction.started" | "compaction.completed" | "compaction.failed" | "compaction.suppressed"]: {
		type: TType;
		principalId: PrincipalId;
		traceId: TraceId;
		payload: RuntimeEventPayloadMap[TType];
	};
}["compaction.started" | "compaction.completed" | "compaction.failed" | "compaction.suppressed"];

export interface CompactionEventSink {
	append(event: CompactionRuntimeEvent): Promise<void>;
}

export interface CompactionArtifactPort {
	put(input: {
		kind: "log" | "session_report";
		mediaType: "application/json" | "text/markdown";
		body: string;
		inputSources: readonly InputSourceRef[];
		declassificationReceipts: readonly DeclassificationReceiptRef[];
	}): Promise<ArtifactRef>;
}

export interface CompactionProjectionPort {
	install(request: CompactionProjectionInstallRequest): Promise<CompactionProjectionInstallationReceipt>;
}

export interface CompactionProjectionInstallRequest {
	projection: CompactedHistoryProjection;
	expectedProjectionRevision: number;
	previousProjectionDigest: string;
}

export interface CompactionServiceIdentity {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
}

export type CompactionServiceResult =
	| {
			ok: true;
			lifecycleState: "live_projection_installed";
			checkpoint: CompactionCheckpoint;
			projection: CompactedHistoryProjection;
			installation: CompactionProjectionInstallationReceipt;
	  }
	| { ok: false; status: "suppressed"; reason: CompactionSuppressionReason }
	| {
			ok: false;
			status: "failed";
			errorCode: string;
			originalProjectionDigest: string;
			lifecycleState?: "prepared";
			checkpoint?: CompactionCheckpoint;
			projection?: CompactedHistoryProjection;
	  }
	| {
			ok: false;
			status: "recovery_required";
			errorCode: "projection_recovery_required";
			originalProjectionDigest: string;
			lifecycleState: "durably_committed";
			checkpoint: CompactionCheckpoint;
			projection: CompactedHistoryProjection;
	  };

export interface CompactionRequest {
	commandId: CommandId;
	traceId: TraceId;
	reason: CompactionReason;
	history: readonly CompactionSourceEntry[];
	retainedTurns: number;
	maxInputChars: number;
	maxSummaryTokens: number;
	targetInputBudget: number;
	timeoutMs: number;
	summarizerProfileId: ResourceId;
	summarizerProfileDigest: string;
	previousCheckpoint?: CompactionCheckpointRef;
	originalProjectionDigest: string;
	expectedProjectionRevision: number;
	captureInvariants(): CompactionInvariantSnapshot;
}

function checkpointRef(checkpoint: CompactionCheckpoint): CompactionCheckpointRef {
	return {
		schemaVersion: 1,
		authorityId: checkpoint.authorityId,
		tenantId: checkpoint.tenantId,
		checkpointId: checkpoint.checkpointId,
		compactionId: checkpoint.compactionId,
		sessionId: checkpoint.sessionId,
		sourceFromSequence: checkpoint.cut.sourceFromSequence,
		sourceToSequence: checkpoint.cut.sourceToSequence,
		retainedFromSequence: checkpoint.cut.retainedFromSequence,
		survivingSuffixFromSequence: checkpoint.survivingSuffixFromSequence,
		summaryArtifact: checkpoint.summaryArtifact,
		summaryDigest: checkpoint.summaryDigest,
		replacementHistoryArtifact: checkpoint.replacementHistoryArtifact,
		replacementHistoryDigest: checkpoint.replacementHistoryDigest,
		invariantDigest: checkpoint.invariantsAfter.invariantDigest,
		...(checkpoint.previousCheckpoint === undefined
			? {}
			: {
					previousCheckpointId: checkpoint.previousCheckpoint.checkpointId,
					previousCheckpointDigest: checkpoint.previousCheckpoint.checkpointDigest,
					previousReplacementHistoryDigest: checkpoint.previousCheckpoint.replacementHistoryDigest,
				}),
		checkpointDigest: checkpoint.checkpointDigest,
	};
}

function canonicalReplacementEntry(entry: CompactionSourceEntry): Readonly<Record<string, unknown>> {
	return {
		sequence: entry.sequence,
		...(entry.sequenceIndex === undefined
			? {}
			: { sequenceIndex: entry.sequenceIndex }),
		turnId: entry.turnId,
		kind: entry.kind,
		content: entry.content,
		contentDigest: entry.contentDigest,
		stable: entry.stable,
		turnCompleted: entry.turnCompleted,
		...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
		...(entry.artifact === undefined ? {} : { artifact: entry.artifact }),
		inputSources: entry.inputSources,
		declassificationReceipts: entry.declassificationReceipts,
	};
}

function installationMatches(
	receipt: CompactionProjectionInstallationReceipt,
	checkpoint: CompactionCheckpoint,
	projection: CompactedHistoryProjection,
	expectedProjectionRevision: number,
	previousProjectionDigest: string,
): boolean {
	return (
		isCompactionProjectionInstallationReceipt(receipt) &&
		receipt.checkpointId === checkpoint.checkpointId &&
		receipt.checkpointDigest === checkpoint.checkpointDigest &&
		receipt.replacementHistoryArtifact.artifactId === checkpoint.replacementHistoryArtifact.artifactId &&
		receipt.replacementHistoryDigest === checkpoint.replacementHistoryDigest &&
		receipt.expectedProjectionRevision === expectedProjectionRevision &&
		receipt.previousProjectionDigest === previousProjectionDigest &&
		receipt.projectionDigest === projection.projectionDigest
	);
}

function checkpointDigest(checkpoint: Omit<CompactionCheckpoint, "checkpointDigest">): string {
	return canonicalDigest(checkpoint);
}

export class CompactionService {
	readonly #identity: CompactionServiceIdentity;
	readonly #sampler: CompactionSummarySampler;
	readonly #artifacts: CompactionArtifactPort;
	readonly #events: CompactionEventSink;
	readonly #projection: CompactionProjectionPort;
	readonly #clock: () => Date;

	public constructor(options: {
		identity: CompactionServiceIdentity;
		sampler: CompactionSummarySampler;
		artifacts: CompactionArtifactPort;
		events: CompactionEventSink;
		projection: CompactionProjectionPort;
		clock?: () => Date;
	}) {
		this.#identity = options.identity;
		this.#sampler = options.sampler;
		this.#artifacts = options.artifacts;
		this.#events = options.events;
		this.#projection = options.projection;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async compact(request: CompactionRequest): Promise<CompactionServiceResult> {
		const compactionId = createRuntimeId("compaction", `op-${canonicalDigest({ sessionId: this.#identity.sessionId, commandId: request.commandId }).slice(0, 48)}`);
		const planned = planCompactionCut(request.history, request.retainedTurns);
		if (!planned.ok) {
			await this.#events.append({
				type: "compaction.suppressed", principalId: this.#identity.principalId, traceId: request.traceId,
				payload: { compactionId, reason: planned.reason, attemptDigest: planned.attemptDigest },
			});
			return { ok: false, status: "suppressed", reason: planned.reason };
		}
		const before = request.captureInvariants();
		const sources = propagateInputSources(...planned.compacted.map((entry) => entry.inputSources));
		const receipts = planned.compacted.flatMap((entry) => entry.declassificationReceipts);
		if (sources === undefined || !inputSourcesAllowedAtSink(sources, "context", receipts, this.#clock())) {
			return this.fail(request, compactionId, "taint_rejected");
		}
		let inputArtifact: ArtifactRef;
		let completionCommitted = false;
		let preparedCheckpoint: CompactionCheckpoint | undefined;
		let preparedProjection: CompactedHistoryProjection | undefined;
		try {
			inputArtifact = await this.#artifacts.put({
				kind: "log",
				mediaType: "application/json",
				body: canonicalJson({
					schemaVersion: 1,
					sessionId: this.#identity.sessionId,
					kind: "compaction_source_history",
					entries: planned.compacted.map(canonicalReplacementEntry),
				}),
				inputSources: sources,
				declassificationReceipts: receipts,
			});
			await this.#events.append({
				type: "compaction.started", principalId: this.#identity.principalId, traceId: request.traceId,
				payload: {
					compactionId, reason: request.reason,
					sourceFromSequence: planned.cut.sourceFromSequence,
					sourceToSequence: planned.cut.sourceToSequence,
					retainedFromSequence: planned.cut.retainedFromSequence,
					invariantDigest: before.invariantDigest,
					idempotencyKey: request.commandId,
				},
			});
			const summarized = await summarizeCompactionEntries({
				entries: planned.compacted,
				sampler: this.#sampler,
				maxInputChars: request.maxInputChars,
				maxSummaryTokens: request.maxSummaryTokens,
				timeoutMs: request.timeoutMs,
			});
			const summaryArtifact = await this.#artifacts.put({
				kind: "session_report",
				mediaType: "text/markdown",
				body: summarized.summary,
				inputSources: summarized.inputSources,
				declassificationReceipts: summarized.declassificationReceipts,
			});
			const replacementHistoryBody = canonicalJson({
				schemaVersion: 1,
				sessionId: this.#identity.sessionId,
				kind: "compaction_replacement_history",
				cut: planned.cut,
				summary: summarized.summary,
				summaryDigest: summarized.summaryDigest,
				summaryArtifact,
				survivingSuffixFromSequence: planned.cut.retainedFromSequence,
				retained: planned.retained.map(canonicalReplacementEntry),
				...(request.previousCheckpoint === undefined
					? {}
					: {
						previousCheckpointId: request.previousCheckpoint.checkpointId,
						previousCheckpointDigest: request.previousCheckpoint.checkpointDigest,
						previousReplacementHistoryDigest: request.previousCheckpoint.replacementHistoryDigest,
					}),
			});
			const replacementHistoryDigest = canonicalDigest(replacementHistoryBody);
			const replacementHistoryArtifact = await this.#artifacts.put({
				kind: "log",
				mediaType: "application/json",
				body: replacementHistoryBody,
				inputSources: summarized.inputSources,
				declassificationReceipts: summarized.declassificationReceipts,
			});
			const after = request.captureInvariants();
			const retainedTokens = planned.retained.reduce((sum, entry) => sum + conservativeTokenEstimate(entry.content), 0);
			const validation = validateCompactionSummary({
				summary: summarized.summary,
				cut: planned.cut,
				before,
				after,
				maxSummaryTokens: request.maxSummaryTokens,
				targetInputBudget: request.targetInputBudget,
				retainedEstimatedTokens: retainedTokens,
				previousCheckpoint: request.previousCheckpoint,
				validatedAt: this.#clock().toISOString(),
			});
			if (validation.outcome !== "valid") return this.fail(request, compactionId, "validation_failed");
			const body: Omit<CompactionCheckpoint, "checkpointDigest"> = {
				schemaVersion: 1,
				authorityId: this.#identity.authorityId,
				tenantId: this.#identity.tenantId,
				principalId: this.#identity.principalId,
				compactionId,
				checkpointId: createRuntimeId("checkpoint", `compact-${summarized.summaryDigest.slice(0, 48)}`),
				sessionId: this.#identity.sessionId,
				reason: request.reason,
				commandId: request.commandId,
				cut: planned.cut,
				inputArtifact,
				summaryArtifact,
				summaryDigest: summarized.summaryDigest,
				replacementHistoryArtifact,
				replacementHistoryDigest,
				survivingSuffixFromSequence: planned.cut.retainedFromSequence,
				...(request.previousCheckpoint === undefined
					? {}
					: { previousReplacementHistoryDigest: request.previousCheckpoint.replacementHistoryDigest }),
				summarizerProfileId: request.summarizerProfileId,
				summarizerProfileDigest: request.summarizerProfileDigest,
				preEstimatedTokens: request.history.reduce((sum, entry) => sum + conservativeTokenEstimate(entry.content), 0),
				postEstimatedTokens: conservativeTokenEstimate(summarized.summary) + retainedTokens,
				maxSummaryTokens: request.maxSummaryTokens,
				invariantsBefore: before,
				invariantsAfter: after,
				validation,
				...(request.previousCheckpoint === undefined ? {} : { previousCheckpoint: request.previousCheckpoint }),
				createdAt: this.#clock().toISOString(),
			};
			const checkpoint: CompactionCheckpoint = { ...body, checkpointDigest: checkpointDigest(body) };
			if (!isCompactionCheckpoint(checkpoint)) return this.fail(request, compactionId, "checkpoint_invalid");
			const ref = checkpointRef(checkpoint);
			const projection = createCompactedHistoryProjection(ref, summarized.summary, planned.retained);
			preparedCheckpoint = checkpoint;
			preparedProjection = projection;
			await this.#events.append({
				type: "compaction.completed", principalId: this.#identity.principalId, traceId: request.traceId,
				payload: {
					compactionId,
					checkpointId: checkpoint.checkpointId,
					checkpointDigest: checkpoint.checkpointDigest,
					summaryArtifactId: summaryArtifact.artifactId,
					summaryDigest: summarized.summaryDigest,
					invariantDigest: after.invariantDigest,
					...(request.previousCheckpoint === undefined ? {} : { previousCheckpointId: request.previousCheckpoint.checkpointId }),
				},
			});
			completionCommitted = true;
			const installation = await this.#projection.install({
				projection,
				expectedProjectionRevision: request.expectedProjectionRevision,
				previousProjectionDigest: request.originalProjectionDigest,
			});
			if (!installationMatches(
				installation,
				checkpoint,
				projection,
				request.expectedProjectionRevision,
				request.originalProjectionDigest,
			)) throw new Error("compaction projection installation receipt is invalid or uncorrelated");
			return { ok: true, lifecycleState: "live_projection_installed", checkpoint, projection, installation };
		} catch (error) {
			if (completionCommitted && preparedCheckpoint && preparedProjection) {
				// completed 是 canonical commit；projection 可由 checkpoint 重建，不能再追加相互矛盾的 failed terminal。
				return {
					ok: false,
					status: "recovery_required",
					errorCode: "projection_recovery_required",
					originalProjectionDigest: request.originalProjectionDigest,
					lifecycleState: "durably_committed",
					checkpoint: preparedCheckpoint,
					projection: preparedProjection,
				};
			}
			const failed = await this.fail(request, compactionId, error instanceof Error ? error.name : "compaction_failed");
			return preparedCheckpoint && preparedProjection
				? { ...failed, lifecycleState: "prepared", checkpoint: preparedCheckpoint, projection: preparedProjection }
				: failed;
		}
	}

	public async installCommittedProjection(request: {
		checkpoint: CompactionCheckpoint;
		projection: CompactedHistoryProjection;
		expectedProjectionRevision: number;
		previousProjectionDigest: string;
	}): Promise<Extract<CompactionServiceResult, { ok: true }>> {
		if (
			!isCompactionCheckpoint(request.checkpoint) ||
			request.checkpoint.authorityId !== this.#identity.authorityId ||
			request.checkpoint.tenantId !== this.#identity.tenantId ||
			request.checkpoint.sessionId !== this.#identity.sessionId ||
			request.projection.checkpoint.checkpointDigest !== request.checkpoint.checkpointDigest ||
			request.projection.projectionDigest !== createCompactedHistoryProjection(
				request.projection.checkpoint,
				request.projection.summary,
				request.projection.retained,
			).projectionDigest
		) throw new Error("committed compaction projection is invalid or outside the session scope");
		const installation = await this.#projection.install({
			projection: request.projection,
			expectedProjectionRevision: request.expectedProjectionRevision,
			previousProjectionDigest: request.previousProjectionDigest,
		});
		if (!installationMatches(
			installation,
			request.checkpoint,
			request.projection,
			request.expectedProjectionRevision,
			request.previousProjectionDigest,
		)) throw new Error("recovered compaction installation receipt is invalid or uncorrelated");
		return {
			ok: true,
			lifecycleState: "live_projection_installed",
			checkpoint: request.checkpoint,
			projection: request.projection,
			installation,
		};
	}

	private async fail(request: CompactionRequest, compactionId: CompactionId, errorCode: string): Promise<Extract<CompactionServiceResult, { ok: false; status: "failed" }>> {
		try {
			await this.#events.append({
				type: "compaction.failed",
				principalId: this.#identity.principalId,
				traceId: request.traceId,
				payload: {
					compactionId,
					error: { code: errorCode.slice(0, 128) || "compaction_failed", messageDigest: canonicalDigest({ errorCode }), retryable: false },
					originalProjectionDigest: request.originalProjectionDigest,
				},
			});
		} catch {
			// 可选 compaction 不得因诊断 event sink 不可用阻断普通 turn。
		}
		return { ok: false, status: "failed", errorCode, originalProjectionDigest: request.originalProjectionDigest };
	}
}

export interface AutoCompactionDecision {
	trigger: boolean;
	reason: "below_threshold" | "threshold_reached" | "invalid_config" | "flush_in_progress" | "suppressed";
	thresholdTokens: number;
}

export function decideAutoCompaction(options: {
	estimatedInputTokens: number;
	contextWindowTokens: number;
	thresholdPercent: number;
	reservedTokens: number;
	isFlushing: boolean;
	suppressed: boolean;
}): AutoCompactionDecision {
	if (!Number.isFinite(options.thresholdPercent) || options.thresholdPercent < 50 || options.thresholdPercent > 90 || options.reservedTokens < 0) {
		return { trigger: false, reason: "invalid_config", thresholdTokens: 0 };
	}
	const thresholdTokens = Math.max(0, Math.floor(options.contextWindowTokens * options.thresholdPercent / 100) - options.reservedTokens);
	if (options.isFlushing) return { trigger: false, reason: "flush_in_progress", thresholdTokens };
	if (options.suppressed) return { trigger: false, reason: "suppressed", thresholdTokens };
	return options.estimatedInputTokens >= thresholdTokens
		? { trigger: true, reason: "threshold_reached", thresholdTokens }
		: { trigger: false, reason: "below_threshold", thresholdTokens };
}

export class OverflowRecoveryGuard {
	readonly #attempted = new Set<string>();
	public claim(requestId: string, sideEffectsStarted: boolean): boolean {
		if (sideEffectsStarted || this.#attempted.has(requestId)) return false;
		this.#attempted.add(requestId);
		return true;
	}
	public clear(requestId: string): void {
		this.#attempted.delete(requestId);
	}
}
