/**
 * Compaction checkpoint 的最小 lifecycle port 与内存 adapter。
 *
 * 这是 checkpoint intent/commit 的行为切片，不负责写 event、artifact 或
 * model-history projection。生产 Host 可以在不改变 checkpoint contract 的前提
 * 下替换本 adapter。
 */

import { runtimeDigest, type RuntimeContentRef } from "../../protocol/foundation.ts";
import { isCompactionCheckpoint } from "./schema.ts";
import type { CompactionCheckpoint, CompactionStatus } from "./types.ts";
import { isCompactionInvariantDigestValid } from "../invariants.ts";
import type { SessionId, SnapshotId } from "../../protocol/ids.ts";

export type CompactionCheckpointStoreErrorCode =
	| "invalid_schema"
	| "invalid_invariant"
	| "illegal_transition"
	| "attempt_not_monotonic"
	| "scope_conflict"
	| "source_range_conflict";

export interface CompactionCheckpointStoreError {
	readonly code: CompactionCheckpointStoreErrorCode;
	readonly message: string;
}

export type CompactionCheckpointStoreResult<T> =
	| { readonly ok: true; readonly value: T; readonly replayed?: boolean }
	| { readonly ok: false; readonly error: CompactionCheckpointStoreError };

export interface CompactionCheckpointStorePort {
	apply(value: unknown): CompactionCheckpointStoreResult<CompactionCheckpoint>;
	append(value: unknown): CompactionCheckpointStoreResult<CompactionCheckpoint>;
	replay(values: readonly unknown[]): CompactionCheckpointStoreResult<readonly CompactionCheckpoint[]>;
	get(compactionId: SnapshotId): CompactionCheckpoint | undefined;
	list(sessionId?: SessionId): readonly CompactionCheckpoint[];
	latest(sessionId: SessionId): CompactionCheckpoint | undefined;
}

const NEXT_STATUS: Readonly<Record<CompactionStatus, readonly CompactionStatus[]>> = {
	planned: ["started"],
	started: ["completed", "failed"],
	completed: [],
	failed: [],
};

function failure<T>(code: CompactionCheckpointStoreErrorCode, message: string): CompactionCheckpointStoreResult<T> {
	return { ok: false, error: { code, message } };
}

function sameDigest(left: { readonly digest: string }, right: { readonly digest: string }): boolean {
	return left.digest === right.digest;
}

function cloneContentRef(ref: RuntimeContentRef): RuntimeContentRef {
	return {
		subjectKind: ref.subjectKind,
		digest: { ...ref.digest },
		...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
		...(ref.size === undefined ? {} : { size: ref.size }),
	};
}

function cloneCheckpoint(checkpoint: CompactionCheckpoint): CompactionCheckpoint {
	return {
		...checkpoint,
		sourceRange: {
			...checkpoint.sourceRange,
			stream: { ...checkpoint.sourceRange.stream },
			head: { ...checkpoint.sourceRange.head, eventHash: { ...checkpoint.sourceRange.head.eventHash } },
			rangeDigest: { ...checkpoint.sourceRange.rangeDigest },
		},
		...(checkpoint.replacementArtifactRef === undefined
			? {}
			: { replacementArtifactRef: cloneContentRef(checkpoint.replacementArtifactRef) }),
		invariantDigest: { ...checkpoint.invariantDigest },
		...(checkpoint.terminalReceiptRef === undefined
			? {}
			: { terminalReceiptRef: cloneContentRef(checkpoint.terminalReceiptRef) }),
		projectionDigest: { ...checkpoint.projectionDigest },
	};
}

function sourceRangeDigest(checkpoint: CompactionCheckpoint): { readonly digest: string } {
	return runtimeDigest(checkpoint.sourceRange);
}

function checkpointDigest(checkpoint: CompactionCheckpoint): { readonly digest: string } {
	return runtimeDigest(checkpoint);
}

function sortedCheckpoints(values: Iterable<CompactionCheckpoint>): CompactionCheckpoint[] {
	return [...values]
		.sort((left, right) => {
			if (left.sourceRange.endSequence !== right.sourceRange.endSequence) {
				return left.sourceRange.endSequence - right.sourceRange.endSequence;
			}
			if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
			return left.compactionId.localeCompare(right.compactionId);
		})
		.map(cloneCheckpoint);
}

function validateCheckpoint(value: unknown): CompactionCheckpointStoreResult<CompactionCheckpoint> {
	if (!isCompactionCheckpoint(value)) return failure("invalid_schema", "compaction checkpoint does not match the current schema");
	if (!isCompactionInvariantDigestValid(value)) return failure("invalid_invariant", "compaction checkpoint invariant digest is invalid");
	return { ok: true, value };
}

function applyTo(
	state: Map<string, CompactionCheckpoint>,
	value: unknown,
): CompactionCheckpointStoreResult<CompactionCheckpoint> {
	const validated = validateCheckpoint(value);
	if (!validated.ok) return validated;
	const candidate = validated.value;
	const current = state.get(candidate.compactionId);
	if (current === undefined) {
		if (candidate.status !== "planned") return failure("illegal_transition", "a checkpoint must start in planned status");
		state.set(candidate.compactionId, cloneCheckpoint(candidate));
		return { ok: true, value: cloneCheckpoint(candidate), replayed: false };
	}

	if (sameDigest(checkpointDigest(current), checkpointDigest(candidate))) {
		return { ok: true, value: cloneCheckpoint(current), replayed: true };
	}
	if (current.sessionId !== candidate.sessionId) {
		return failure("scope_conflict", "a compaction id cannot move between sessions");
	}
	if (!sameDigest(sourceRangeDigest(current), sourceRangeDigest(candidate))) {
		return failure("source_range_conflict", "a compaction source range cannot change during its lifecycle");
	}
	if (candidate.attempt < current.attempt) {
		return failure("attempt_not_monotonic", "compaction attempt must not decrease");
	}
	if (!NEXT_STATUS[current.status].includes(candidate.status)) {
		return failure("illegal_transition", `cannot transition compaction from ${current.status} to ${candidate.status}`);
	}

	state.set(candidate.compactionId, cloneCheckpoint(candidate));
	return { ok: true, value: cloneCheckpoint(candidate), replayed: false };
}

export class InMemoryCompactionCheckpointStore implements CompactionCheckpointStorePort {
	#checkpoints = new Map<string, CompactionCheckpoint>();

	public apply(value: unknown): CompactionCheckpointStoreResult<CompactionCheckpoint> {
		return applyTo(this.#checkpoints, value);
	}

	public append(value: unknown): CompactionCheckpointStoreResult<CompactionCheckpoint> {
		return this.apply(value);
	}

	public replay(values: readonly unknown[]): CompactionCheckpointStoreResult<readonly CompactionCheckpoint[]> {
		const next = new Map(this.#checkpoints);
		for (const value of values) {
			const result = applyTo(next, value);
			if (!result.ok) return result;
		}
		this.#checkpoints = next;
		return { ok: true, value: sortedCheckpoints(this.#checkpoints.values()) };
	}

	public get(compactionId: SnapshotId): CompactionCheckpoint | undefined {
		const checkpoint = this.#checkpoints.get(compactionId);
		return checkpoint === undefined ? undefined : cloneCheckpoint(checkpoint);
	}

	public list(sessionId?: SessionId): readonly CompactionCheckpoint[] {
		const values = sessionId === undefined
			? this.#checkpoints.values()
			: [...this.#checkpoints.values()].filter((checkpoint) => checkpoint.sessionId === sessionId);
		return sortedCheckpoints(values);
	}

	/** 返回可用于恢复 model-visible projection 的最新已完成 checkpoint。 */
	public latest(sessionId: SessionId): CompactionCheckpoint | undefined {
		const completed = [...this.#checkpoints.values()].filter(
			(checkpoint) => checkpoint.sessionId === sessionId && checkpoint.status === "completed",
		);
		return sortedCheckpoints(completed).at(-1);
	}
}

export { InMemoryCompactionCheckpointStore as CompactionCheckpointStore };
export { InMemoryCompactionCheckpointStore as MemoryCompactionCheckpointStore };
