import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { CompactionCheckpointRef } from "./types.ts";
import type { CompactionSourceEntry } from "./cut-planner.ts";

export interface CompactedHistoryProjection {
	checkpoint: CompactionCheckpointRef;
	summary: string;
	retained: readonly CompactionSourceEntry[];
	projectionDigest: string;
}

export function createCompactedHistoryProjection(
	checkpoint: CompactionCheckpointRef,
	summary: string,
	retained: readonly CompactionSourceEntry[],
): CompactedHistoryProjection {
	const projectionDigest = canonicalDigest({
		checkpointDigest: checkpoint.checkpointDigest,
		summaryDigest: checkpoint.summaryDigest,
		replacementHistoryDigest: checkpoint.replacementHistoryDigest,
		survivingSuffixFromSequence: checkpoint.survivingSuffixFromSequence,
		retained: retained.map((entry) => ({ sequence: entry.sequence, contentDigest: entry.contentDigest })),
	});
	return { checkpoint, summary, retained, projectionDigest };
}

export function resumeCompactedHistory(
	projection: CompactedHistoryProjection,
	checkpoint: CompactionCheckpointRef,
): CompactedHistoryProjection {
	if (projection.checkpoint.checkpointDigest !== checkpoint.checkpointDigest) {
		throw new Error("persisted projection does not match the requested compaction checkpoint");
	}
	return createCompactedHistoryProjection(checkpoint, projection.summary, projection.retained);
}
