/** Startup recovery 四态决策；任何不确定副作用都 fail closed。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventStreamRef, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { AuthorityId, SessionId, TenantId } from "../protocol/v3/ids.ts";
import type { RuntimeEventStore } from "./event-store.ts";
import { replayDurableQueue } from "./durable-queue.ts";
import type { SessionProjection } from "./projections.ts";
import { loadSessionProjection, type SnapshotReplayResult } from "./snapshot.ts";
import { readStopTombstone, type StopTombstone } from "./stop-tombstone.ts";
import type { SessionKernelError } from "./types.ts";

export type RecoveryPauseReason =
	| "active_turn"
	| "active_model_request"
	| "uncertain_operation"
	| "pending_permission"
	| "pending_artifact_intent"
	| "artifact_reconciliation_failed"
	| "pending_verification"
	| "pending_queue_unrecoverable";

export type RecoveryDecision =
	| {
			kind: "resume";
			projection: SessionProjection;
			cursor: EventCursor;
			snapshotSource: "snapshot" | "full";
	  }
	| {
			kind: "pause_for_approval";
			projection: SessionProjection;
			cursor: EventCursor;
			reasons: readonly RecoveryPauseReason[];
			snapshotSource: "snapshot" | "full";
	  }
	| {
			kind: "stopped";
			cursor: EventCursor;
			reason: "stop_tombstone" | "durable_stop_requested" | "terminal_session" | "migration_failed";
			tombstone?: StopTombstone;
	  }
	| {
			kind: "corrupted";
			error: SessionKernelError;
	  };

export interface RecoverSessionOptions {
	store: RuntimeEventStore;
	sessionDirectory: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	snapshotFilePath?: string;
}

function cursorOf(projection: SessionProjection, stream: RuntimeEventStreamRef): EventCursor {
	return {
		stream,
		sequence: projection.headSequence,
		eventId: projection.headEventId,
		eventHash: projection.headEventHash,
	};
}

function corrupted(error?: SessionKernelError): RecoveryDecision {
	return {
		kind: "corrupted",
		error: {
			code: error?.code ?? "corrupted_log",
			message: "session recovery could not establish a trusted resumable state",
			retryable: false,
			...(error?.details
				? {
					details: Object.fromEntries(
						Object.entries(error.details).filter(([key]) =>
							["firstBadSequence", "eventCount", "byteOffset", "tornTail", "sequence"].includes(key),
						),
					),
				}
				: {}),
		},
	};
}

function scopeMatches(options: RecoverSessionOptions, replay: SnapshotReplayResult): boolean {
	return (
		replay.projection.authorityId === options.authorityId &&
		replay.projection.tenantId === options.tenantId &&
		replay.projection.sessionId === options.sessionId
	);
}

function tombstoneMatches(
	options: RecoverSessionOptions,
	tombstone: StopTombstone,
	events: readonly RuntimeEventV3[],
): boolean {
	if (
		tombstone.authorityId !== options.authorityId ||
		tombstone.tenantId !== options.tenantId ||
		tombstone.sessionId !== options.sessionId
	) return false;
	const event = events[tombstone.stopCursor.sequence];
	return Boolean(
		event &&
			(event.type === "session.stop_requested" || event.type === "session.stopped") &&
			canonicalDigest(event.payload.reason) === tombstone.reasonDigest &&
			(event.type !== "session.stop_requested" || event.payload.requestedBy === tombstone.requestedBy) &&
			sameRuntimeEventStream(event.stream, tombstone.stopCursor.stream) &&
			event.eventId === tombstone.stopCursor.eventId &&
			event.currentEventHash === tombstone.stopCursor.eventHash,
	);
}

function recoveryPauseReasons(events: readonly RuntimeEventV3[], projection: SessionProjection): readonly RecoveryPauseReason[] {
	const reasons = new Set<RecoveryPauseReason>();
	if (projection.activeTurnId !== null) reasons.add("active_turn");
	if (projection.activeModelRequestId !== null) reasons.add("active_model_request");
	if (projection.hasUncertainOperations) reasons.add("uncertain_operation");
	if (projection.migration?.status === "in_progress") reasons.add("uncertain_operation");

	const permissions = new Set<string>();
	const artifacts = new Set<string>();
	const verifications = new Set<string>();
	for (const event of events) {
		switch (event.type) {
			case "permission.requested":
				permissions.add(event.payload.approvalId);
				break;
			case "permission.decided":
			case "permission.expired":
			case "permission.revoked":
				permissions.delete(event.payload.approvalId);
				break;
			case "artifact.intent_recorded":
			case "artifact.created":
				artifacts.add(event.payload.artifactId);
				break;
			case "artifact.aborted":
			case "artifact.committed":
				artifacts.delete(event.payload.artifactId);
				break;
			case "verification.started":
				verifications.add(event.payload.verificationId);
				break;
			case "verification.finished":
				verifications.delete(event.payload.verificationId);
				break;
			default:
				break;
		}
	}
	if (permissions.size > 0) reasons.add("pending_permission");
	if (artifacts.size > 0) reasons.add("pending_artifact_intent");
	if (verifications.size > 0) reasons.add("pending_verification");
	if (replayDurableQueue(events).unrecoverable.length > 0) reasons.add("pending_queue_unrecoverable");
	return [...reasons];
}

export async function recoverSession(options: RecoverSessionOptions): Promise<RecoveryDecision> {
	const tombstone = await readStopTombstone(options.sessionDirectory);
	if (!tombstone.ok) return corrupted(tombstone.error);

	const replay = await loadSessionProjection(options.store, options.snapshotFilePath);
	if (!replay.ok) return corrupted(replay.error);
	if (!scopeMatches(options, replay.value)) return corrupted();
	const cursor = cursorOf(replay.value.projection, options.store.streamRef());

	if (tombstone.value) {
		if (!tombstoneMatches(options, tombstone.value, replay.value.events)) return corrupted();
		return { kind: "stopped", cursor, reason: "stop_tombstone", tombstone: tombstone.value };
	}
	if (replay.value.projection.lifecycle === "corrupted") return corrupted();
	if (replay.value.projection.lifecycle === "stop_requested") {
		return { kind: "stopped", cursor, reason: "durable_stop_requested" };
	}
	if (replay.value.projection.lifecycle === "migration_failed") {
		return { kind: "stopped", cursor, reason: "migration_failed" };
	}
	if (replay.value.projection.lifecycle === "stopped" || replay.value.projection.lifecycle === "closed") {
		return { kind: "stopped", cursor, reason: "terminal_session" };
	}

	const reasons = recoveryPauseReasons(replay.value.events, replay.value.projection);
	if (reasons.length > 0) {
		return {
			kind: "pause_for_approval",
			projection: replay.value.projection,
			cursor,
			reasons,
			snapshotSource: replay.value.source,
		};
	}
	return {
		kind: "resume",
		projection: replay.value.projection,
		cursor,
		snapshotSource: replay.value.source,
	};
}
