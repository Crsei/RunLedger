import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { CompactionInvariantSnapshot } from "./compaction/types.ts";

export function calculateCompactionInvariantDigest(
	snapshot: Omit<CompactionInvariantSnapshot, "invariantDigest"> | CompactionInvariantSnapshot,
): string {
	const { invariantDigest: _invariantDigest, ...body } = snapshot as CompactionInvariantSnapshot;
	return canonicalDigest(body);
}

export function compactionInvariantsMatch(
	before: CompactionInvariantSnapshot,
	after: CompactionInvariantSnapshot,
): boolean {
	return (
		before.invariantDigest === calculateCompactionInvariantDigest(before) &&
		after.invariantDigest === calculateCompactionInvariantDigest(after) &&
		canonicalDigest(before.workspace) === canonicalDigest(after.workspace) &&
		before.modeRevision === after.modeRevision &&
		canonicalDigest(before.approvedPlan ?? null) === canonicalDigest(after.approvedPlan ?? null) &&
		canonicalDigest(before.pendingApprovalIds) === canonicalDigest(after.pendingApprovalIds) &&
		before.goalStateDigest === after.goalStateDigest &&
		before.taskStateDigest === after.taskStateDigest &&
		before.workspaceStateDigest === after.workspaceStateDigest &&
		before.verificationStateDigest === after.verificationStateDigest &&
		before.toolPairingDigest === after.toolPairingDigest &&
		canonicalDigest(before.inputSources) === canonicalDigest(after.inputSources) &&
		canonicalDigest(before.declassificationReceipts) === canonicalDigest(after.declassificationReceipts)
	);
}
