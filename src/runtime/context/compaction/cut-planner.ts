/**
 * Manual compaction 的纯 cut planner。
 *
 * 它只决定哪些完整 turn 可以进入 summary 输入，不执行摘要生成、事件写入或
 * projection 替换。遇到不稳定 turn 或未配对 tool batch 时保守地不切，避免
 * checkpoint 包含孤立的 tool call/result。
 */

export interface CompactionTurn {
	readonly turnId: string;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly stable: boolean;
	readonly toolCallIds: readonly string[];
	readonly toolResultIds: readonly string[];
}

export type CompactionCutPlan =
	| {
			readonly kind: "cut";
			readonly startSequence: number;
			readonly endSequence: number;
			readonly compactedTurnIds: readonly string[];
			readonly retainedTurnIds: readonly string[];
	  }
	| {
			readonly kind: "no_cut";
			readonly reason: "insufficient_history" | "unstable_or_incomplete_prefix";
	  };

export interface CompactionCutOptions {
	/** 至少保留多少个最新 turn，默认 1。 */
	readonly retainRecentTurns?: number;
	/** 至少要压缩多少个完整 turn，默认 1。 */
	readonly minCompactedTurns?: number;
}

export class CompactionCutPlanningError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "CompactionCutPlanningError";
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new CompactionCutPlanningError(`${name} must be a positive safe integer`);
	}
}

function assertTurnShape(turn: CompactionTurn, previous: CompactionTurn | undefined, ids: Set<string>): void {
	if (turn.turnId.length === 0 || ids.has(turn.turnId)) {
		throw new CompactionCutPlanningError("turn ids must be non-empty and unique");
	}
	if (!Number.isSafeInteger(turn.startSequence) || !Number.isSafeInteger(turn.endSequence) || turn.startSequence < 0 || turn.endSequence < turn.startSequence) {
		throw new CompactionCutPlanningError("turn sequence range is invalid");
	}
	if (previous !== undefined && turn.startSequence <= previous.endSequence) {
		throw new CompactionCutPlanningError("turn sequence ranges must be strictly ordered");
	}
	ids.add(turn.turnId);
	if (!isCompleteToolBatch(turn)) {
		return;
	}
}

/** tool call/result 必须一一对应，且同一 ID 不能重复。 */
export function isCompleteToolBatch(turn: Pick<CompactionTurn, "toolCallIds" | "toolResultIds">): boolean {
	const calls = new Set(turn.toolCallIds);
	const results = new Set(turn.toolResultIds);
	return calls.size === turn.toolCallIds.length && results.size === turn.toolResultIds.length && calls.size === results.size && [...calls].every((id) => results.has(id));
}

export function planCompactionCut(
	turns: readonly CompactionTurn[],
	options: CompactionCutOptions = {},
): CompactionCutPlan {
	const retainRecentTurns = options.retainRecentTurns ?? 1;
	const minCompactedTurns = options.minCompactedTurns ?? 1;
	assertPositiveInteger(retainRecentTurns, "retainRecentTurns");
	assertPositiveInteger(minCompactedTurns, "minCompactedTurns");

	const ids = new Set<string>();
	for (let index = 0; index < turns.length; index += 1) assertTurnShape(turns[index]!, turns[index - 1], ids);

	const eligibleCount = turns.length - retainRecentTurns;
	if (eligibleCount < minCompactedTurns) return { kind: "no_cut", reason: "insufficient_history" };

	const candidate = turns.slice(0, eligibleCount);
	if (candidate.some((turn) => !turn.stable || !isCompleteToolBatch(turn))) {
		return { kind: "no_cut", reason: "unstable_or_incomplete_prefix" };
	}
	if (candidate.length < minCompactedTurns) return { kind: "no_cut", reason: "insufficient_history" };

	const compactedTurnIds = candidate.map((turn) => turn.turnId);
	return {
		kind: "cut",
		startSequence: candidate[0]!.startSequence,
		endSequence: candidate[candidate.length - 1]!.endSequence,
		compactedTurnIds,
		retainedTurnIds: turns.slice(eligibleCount).map((turn) => turn.turnId),
	};
}
