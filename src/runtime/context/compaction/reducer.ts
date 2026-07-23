import type { CompactionAttemptReceipt, CompactionCheckpointRef, CompactionSuppressionReceipt } from "./types.ts";

export interface CompactionProjectionState {
	checkpoints: readonly CompactionCheckpointRef[];
	latest?: CompactionCheckpointRef;
	lastAttempt?: CompactionAttemptReceipt;
	lastSuppression?: CompactionSuppressionReceipt;
}

export function reduceCompactionAttempt(
	state: CompactionProjectionState,
	attempt: CompactionAttemptReceipt,
): CompactionProjectionState {
	if (attempt.status === "completed") {
		if (
			state.latest !== undefined &&
			(attempt.checkpoint.previousCheckpointId !== state.latest.checkpointId ||
				attempt.checkpoint.previousCheckpointDigest !== state.latest.checkpointDigest)
		) throw new Error("compaction checkpoint does not extend the latest valid chain");
		return { ...state, checkpoints: [...state.checkpoints, attempt.checkpoint], latest: attempt.checkpoint, lastAttempt: attempt };
	}
	if (attempt.status === "suppressed") return { ...state, lastAttempt: attempt, lastSuppression: attempt.suppression };
	return { ...state, lastAttempt: attempt };
}

export function rewindCompactionProjection(
	state: CompactionProjectionState,
	targetSequence: number,
): CompactionProjectionState {
	const checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.sourceToSequence <= targetSequence);
	return { checkpoints, latest: checkpoints[checkpoints.length - 1] };
}
