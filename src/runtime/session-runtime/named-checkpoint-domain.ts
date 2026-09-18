/** Session-owned named checkpoint authority used by the model-facing tools. */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type SnapshotId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionDomainResult } from "./domain-router.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";
import type { RewindDriverResponse, RewindPort } from "./rewind-reverse-request.ts";
import {
	activeNamedCheckpoints,
	checkpointCreationPayload,
	findLatestStableCheckpointBoundary,
	NAMED_CHECKPOINT_LIMITS,
	type NamedCheckpoint,
} from "./named-checkpoint.ts";

const MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "checkpoint.list", capability: "session.catalog", access: "read" as const }),
]);

export type CheckpointCreateResult =
	| { readonly ok: true; readonly checkpoint: NamedCheckpoint }
	| { readonly ok: false; readonly code: string };

export interface NamedCheckpointToolPort {
	create(goal: string, signal?: AbortSignal): Promise<CheckpointCreateResult>;
	rewind(checkpointId: string, report: string, signal?: AbortSignal): Promise<RewindDriverResponse>;
}

export interface NamedCheckpointDomainOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly attemptPort: () => AttemptPort | undefined;
	readonly rewindPort?: RewindPort;
}

export class NamedCheckpointDomain implements SessionResourceDomainPort, NamedCheckpointToolPort {
	public readonly operationManifest = MANIFEST;
	private readonly options: NamedCheckpointDomainOptions;

	public constructor(options: NamedCheckpointDomainOptions) {
		this.options = options;
	}

	public async query(operation: string, payload: Record<string, unknown>): Promise<SessionDomainResult> {
		if (operation !== "checkpoint.list") return failure(operation, "operation_unavailable", "unavailable");
		if (Object.keys(payload).length > 0) return failure(operation, "checkpoint_list_invalid");
		const checkpoints = activeNamedCheckpoints(this.options.store, this.options.fence.sessionId);
		return {
			ok: true,
			status: "ok",
			operation,
			domainRevision: this.options.store.getSession(this.options.fence.sessionId)?.headSequence ?? 0,
			value: { checkpoints },
		};
	}

	public async create(goal: string, signal?: AbortSignal): Promise<CheckpointCreateResult> {
		if (signal?.aborted === true) return { ok: false, code: "aborted" };
		const normalizedGoal = goal.trim();
		if (normalizedGoal.length === 0 || normalizedGoal.length > NAMED_CHECKPOINT_LIMITS.maxGoalChars) return { ok: false, code: "checkpoint_goal_invalid" };
		const { store, fence } = this.options;
		const active = activeNamedCheckpoints(store, fence.sessionId);
		if (active.length > 0) return { ok: false, code: "checkpoint_active" };
		const events = store.replaySessionEvents(fence.sessionId);
		const boundary = findLatestStableCheckpointBoundary(events, fence.sessionId);
		if (boundary === undefined) return { ok: false, code: "checkpoint_stable_boundary_required" };
		const attempt = this.options.attemptPort();
		if (attempt === undefined) return { ok: false, code: "owner_fenced" };
		const requestDigest = runtimeDigest({ operation: "checkpoint", goal: normalizedGoal, boundarySequence: boundary.sequence, boundaryHash: boundary.currentEventHash });
		const begun = attempt.beginAttempt("readonly", requestDigest);
		if ("error" in begun || !("attemptId" in begun)) return { ok: false, code: "error" in begun ? begun.error : "checkpoint_attempt_unavailable" };
		const checkpoint: NamedCheckpoint = {
			checkpointId: createRuntimeId("snapshot", runtimeDigest({ requestDigest, now: Date.now() }).digest.slice(0, 64)),
			sessionId: fence.sessionId,
			goal: normalizedGoal,
			summaryDigest: runtimeDigest(normalizedGoal).digest,
			boundarySequence: boundary.sequence,
			boundaryEventHash: boundary.currentEventHash,
			createdAtMs: Date.now(),
			ownerGeneration: fence.generation,
		};
		try {
			const head = store.latestEventHead(fence.sessionId);
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", `checkpoint-${checkpoint.checkpointId.slice(-48)}`),
				ownerGeneration: fence.generation,
				eventType: "checkpoint.created",
				payloadJson: JSON.stringify(checkpointCreationPayload(checkpoint)),
				createdAtMs: checkpoint.createdAtMs,
				expectedPreviousEventHash: head.hash,
			});
			const settled = attempt.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation: "checkpoint", checkpointId: checkpoint.checkpointId }));
			return settled.ok ? { ok: true, checkpoint } : { ok: false, code: settled.code };
		} catch (error) {
			attempt.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ operation: "checkpoint", error: error instanceof Error ? error.message : String(error) }));
			return { ok: false, code: "checkpoint_create_failed" };
		}
	}

	public async rewind(checkpointId: string, report: string, signal?: AbortSignal): Promise<RewindDriverResponse> {
		if (signal?.aborted === true) return { ok: false, code: "aborted" };
		if (report.trim().length === 0 || report.length > NAMED_CHECKPOINT_LIMITS.maxReportChars) return { ok: false, code: "rewind_report_invalid" };
		const { store, fence, rewindPort } = this.options;
		if (rewindPort === undefined) return { ok: false, code: "reverse_request_unhandled" };
		const checkpoint = activeNamedCheckpoints(store, fence.sessionId).find((candidate) => candidate.checkpointId === checkpointId);
		if (checkpoint === undefined) return { ok: false, code: "checkpoint_not_found" };
		const source = store.getSession(fence.sessionId);
		if (source === undefined) return { ok: false, code: "session_not_found" };
		return rewindPort.request({
			checkpointId: checkpoint.checkpointId,
			checkpointGoal: checkpoint.goal,
			sourceSessionId: fence.sessionId,
			checkpointSequence: checkpoint.boundarySequence,
			expectedSourceHeadSequence: source.headSequence,
			expectedCatalogRevision: store.catalogRevision(),
			report: report.trim(),
		}, signal);
	}
}

function failure(operation: string, code: string, status: "failed" | "unavailable" = "failed"): SessionDomainResult {
	return { ok: false, status, code, operation };
}
