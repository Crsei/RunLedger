/** Durable named checkpoint facts and their event projection. */

import type { SessionEventRecord, SessionStore } from "../../storage/session-store/session-store.ts";
import { isStableForkBoundary } from "../../storage/session-store/fork-projector.ts";
import { isRuntimeId, type SnapshotId } from "../protocol/ids.ts";
import { runtimeDigest } from "../protocol/foundation.ts";

export const NAMED_CHECKPOINT_SCHEMA = "runledger.named-checkpoint@1";
export const NAMED_CHECKPOINT_REWIND_SCHEMA = "runledger.named-checkpoint-rewind@1";
export const NAMED_CHECKPOINT_LIMITS = Object.freeze({ maxGoalChars: 1_024, maxReportChars: 16_384 });

export interface NamedCheckpoint {
	readonly checkpointId: SnapshotId;
	readonly sessionId: string;
	readonly goal: string;
	/** Digest of the user-visible goal summary; no hidden model summary is stored. */
	readonly summaryDigest: string;
	readonly boundarySequence: number;
	readonly boundaryEventHash: string;
	readonly createdAtMs: number;
	readonly ownerGeneration: number;
}

export function activeNamedCheckpoints(store: SessionStore, sessionId: string): readonly NamedCheckpoint[] {
	return projectNamedCheckpoints(store.replaySessionEvents(sessionId), sessionId);
}

export function resolveNamedCheckpoint(store: SessionStore, sessionId: string, checkpointId: string): NamedCheckpoint | undefined {
	return activeNamedCheckpoints(store, sessionId).find((checkpoint) => checkpoint.checkpointId === checkpointId);
}

export function projectNamedCheckpoints(events: readonly SessionEventRecord[], sessionId: string): readonly NamedCheckpoint[] {
	const active = new Map<string, NamedCheckpoint>();
	for (const event of events) {
		if (event.eventType === "checkpoint.created") {
			const checkpoint = decodeCreatedCheckpoint(event, events, sessionId);
			if (checkpoint !== undefined) active.set(checkpoint.checkpointId, checkpoint);
			continue;
		}
		if (event.eventType === "checkpoint.rewound") {
			const checkpointId = decodeRewoundCheckpointId(event, sessionId);
			if (checkpointId !== undefined) active.delete(checkpointId);
		}
	}
	return [...active.values()].sort((left, right) => left.createdAtMs - right.createdAtMs || left.checkpointId.localeCompare(right.checkpointId));
}

export function findLatestStableCheckpointBoundary(events: readonly SessionEventRecord[], sessionId: string): SessionEventRecord | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]!;
		if (isStableForkBoundary({ eventId: event.eventId, eventType: event.eventType, payloadJson: event.payloadJson, createdAtMs: event.createdAtMs }, sessionId)) return event;
	}
	return undefined;
}

function decodeCreatedCheckpoint(event: SessionEventRecord, events: readonly SessionEventRecord[], sessionId: string): NamedCheckpoint | undefined {
	const value = jsonRecord(event.payloadJson);
	if (value?.schema !== NAMED_CHECKPOINT_SCHEMA || value.sessionId !== sessionId) return undefined;
	if (!isRuntimeId(value.checkpointId, "snapshot") || typeof value.goal !== "string" || value.goal.length === 0 || value.goal.length > NAMED_CHECKPOINT_LIMITS.maxGoalChars || typeof value.summaryDigest !== "string" || value.summaryDigest !== runtimeDigest(value.goal).digest) return undefined;
	const boundarySequence = value.boundarySequence;
	if (typeof boundarySequence !== "number" || !Number.isSafeInteger(boundarySequence) || boundarySequence < 1 || typeof value.boundaryEventHash !== "string" || value.boundaryEventHash.length === 0) return undefined;
	const boundary = events.find((candidate) => candidate.sequence === boundarySequence);
	if (boundary === undefined || boundary.currentEventHash !== value.boundaryEventHash) return undefined;
	if (!isStableForkBoundary({ eventId: boundary.eventId, eventType: boundary.eventType, payloadJson: boundary.payloadJson, createdAtMs: boundary.createdAtMs }, sessionId)) return undefined;
	return {
		checkpointId: value.checkpointId as SnapshotId,
		sessionId,
		goal: value.goal,
		summaryDigest: value.summaryDigest,
		boundarySequence,
		boundaryEventHash: value.boundaryEventHash,
		createdAtMs: event.createdAtMs,
		ownerGeneration: event.ownerGeneration,
	};
}

function decodeRewoundCheckpointId(event: SessionEventRecord, sessionId: string): string | undefined {
	const value = jsonRecord(event.payloadJson);
	if (value?.schema !== NAMED_CHECKPOINT_REWIND_SCHEMA || value.sessionId !== sessionId || !isRuntimeId(value.checkpointId, "snapshot")) return undefined;
	return value.checkpointId;
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export function checkpointCreationPayload(checkpoint: NamedCheckpoint): Record<string, unknown> {
	return {
		schema: NAMED_CHECKPOINT_SCHEMA,
		checkpointId: checkpoint.checkpointId,
		sessionId: checkpoint.sessionId,
		goal: checkpoint.goal,
		summaryDigest: checkpoint.summaryDigest,
		boundarySequence: checkpoint.boundarySequence,
		boundaryEventHash: checkpoint.boundaryEventHash,
		ownerGeneration: checkpoint.ownerGeneration,
	};
}
