import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../../protocol/v3/taint.ts";
import type { CompactionCut, CompactionSuppressionReason } from "./types.ts";

export type CompactionEntryKind = "user" | "assistant" | "tool_call" | "tool_result" | "system";

export interface CompactionSourceEntry {
	sequence: number;
	/** 同一 canonical event 投影出多个 parallel tool entries 时的稳定位置。 */
	sequenceIndex?: number;
	turnId: string;
	kind: CompactionEntryKind;
	content: string;
	contentDigest: string;
	stable: boolean;
	turnCompleted: boolean;
	toolCallId?: string;
	artifact?: ArtifactRef;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export type CompactionCutPlan =
	| { ok: true; cut: CompactionCut; compacted: readonly CompactionSourceEntry[]; retained: readonly CompactionSourceEntry[] }
	| { ok: false; reason: CompactionSuppressionReason; attemptDigest: string };

function suppressed(reason: CompactionSuppressionReason, entries: readonly CompactionSourceEntry[]): CompactionCutPlan {
	return { ok: false, reason, attemptDigest: canonicalDigest({ reason, sequences: entries.map((entry) => entry.sequence) }) };
}

export function compactionToolPairing(entries: readonly CompactionSourceEntry[]): {
	digest: string;
	pairs: ReadonlyMap<string, { call?: number; result?: number }>;
} {
	const pairs = new Map<string, { call?: number; result?: number }>();
	for (const entry of entries) {
		if ((entry.kind !== "tool_call" && entry.kind !== "tool_result") || entry.toolCallId === undefined) continue;
		const current = pairs.get(entry.toolCallId) ?? {};
		if (entry.kind === "tool_call") current.call = entry.sequence;
		else current.result = entry.sequence;
		pairs.set(entry.toolCallId, current);
	}
	return {
		digest: canonicalDigest([...pairs.entries()].sort(([left], [right]) => left.localeCompare(right))),
		pairs,
	};
}

export function planCompactionCut(
	input: readonly CompactionSourceEntry[],
	retainedTurns: number,
): CompactionCutPlan {
	if (!Number.isSafeInteger(retainedTurns) || retainedTurns < 0) return suppressed("schema_invalid", input);
	const entries = input.slice().sort(
		(left, right) =>
			left.sequence - right.sequence ||
			(left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0) ||
			left.kind.localeCompare(right.kind),
	);
	if (entries.length === 0) return suppressed("insufficient_history", entries);
	if (entries.some((entry, index) => {
		const position = entry.sequenceIndex ?? 0;
		const previous = entries[index - 1];
		return (
			!Number.isSafeInteger(entry.sequence) ||
			entry.sequence < 0 ||
			!Number.isSafeInteger(position) ||
			position < 0 ||
			(previous !== undefined &&
				entry.sequence === previous.sequence &&
				position === (previous.sequenceIndex ?? 0))
		);
	})) {
		return suppressed("schema_invalid", entries);
	}
	if (entries.some((entry) => !entry.stable)) return suppressed("active_tool_batch", entries);
	const completedTurns = [...new Set(entries.filter((entry) => entry.turnCompleted).map((entry) => entry.turnId))];
	if (completedTurns.length <= retainedTurns) return suppressed("insufficient_history", entries);
	const retainedTurnIds = new Set(completedTurns.slice(-retainedTurns));
	let cutTo = Math.max(...entries.filter((entry) => !retainedTurnIds.has(entry.turnId)).map((entry) => entry.sequence));
	const pairState = compactionToolPairing(entries);
	for (const pair of pairState.pairs.values()) {
		if (pair.call === undefined || pair.result === undefined) return suppressed("active_tool_batch", entries);
		if (pair.call <= cutTo && pair.result > cutTo) cutTo = pair.call - 1;
		if (pair.result <= cutTo && pair.call > cutTo) cutTo = pair.result - 1;
	}
	const compacted = entries.filter((entry) => entry.sequence <= cutTo);
	const retained = entries.filter((entry) => entry.sequence > cutTo);
	if (compacted.length === 0 || retained.length === 0) return suppressed("no_safe_cut", entries);
	const compactedTurns = new Set(compacted.filter((entry) => entry.turnCompleted).map((entry) => entry.turnId));
	if (compactedTurns.size === 0) return suppressed("no_safe_cut", entries);
	return {
		ok: true,
		cut: {
			sourceFromSequence: compacted[0]?.sequence ?? 0,
			sourceToSequence: compacted[compacted.length - 1]?.sequence ?? 0,
			retainedFromSequence: (compacted[compacted.length - 1]?.sequence ?? -1) + 1,
			completedTurnCount: compactedTurns.size,
			toolPairingDigest: pairState.digest,
			offloadedArtifacts: compacted.flatMap((entry) => entry.artifact === undefined ? [] : [entry.artifact]),
		},
		compacted,
		retained,
	};
}
