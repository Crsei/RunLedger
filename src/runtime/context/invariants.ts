import { runtimeDigest } from "../protocol/foundation.ts";
import type { CompactionCheckpoint } from "./compaction/types.ts";

type InvariantDigest = CompactionCheckpoint["invariantDigest"];

function checkpointBody(checkpoint: CompactionCheckpoint): Omit<CompactionCheckpoint, "invariantDigest"> {
	const { invariantDigest: _invariantDigest, ...body } = checkpoint;
	return body;
}

export function calculateCompactionInvariantDigest(
	snapshot: Omit<CompactionCheckpoint, "invariantDigest"> | CompactionCheckpoint,
): InvariantDigest {
	const body = "invariantDigest" in snapshot
		? checkpointBody(snapshot)
		: snapshot;
	return runtimeDigest(body);
}

export function isCompactionInvariantDigestValid(checkpoint: CompactionCheckpoint): boolean {
	const calculated = calculateCompactionInvariantDigest(checkpoint);
	return calculated.algorithm === checkpoint.invariantDigest.algorithm && calculated.digest === checkpoint.invariantDigest.digest;
}

export function compactionInvariantsMatch(
	before: CompactionCheckpoint,
	after: CompactionCheckpoint,
): boolean {
	if (!isCompactionInvariantDigestValid(before) || !isCompactionInvariantDigestValid(after)) return false;
	return before.invariantDigest.algorithm === after.invariantDigest.algorithm && before.invariantDigest.digest === after.invariantDigest.digest;
}

export const compactionInvariantMatches = compactionInvariantsMatch;
