import { describe, expect, it } from "vitest";
import { planCompactionCut, type CompactionTurn } from "../../../src/runtime/context/compaction/cut-planner.ts";

function turn(
	sequence: number,
	id: string,
	options: Partial<Pick<CompactionTurn, "stable" | "toolCallIds" | "toolResultIds">> = {},
): CompactionTurn {
	return {
		turnId: id,
		startSequence: sequence,
		endSequence: sequence + 1,
		stable: true,
		toolCallIds: [],
		toolResultIds: [],
		...options,
	};
}

describe("planCompactionCut", () => {
	it("compacts only a stable prefix and always retains the newest turn", () => {
		const result = planCompactionCut([
			turn(1, "turn-1"),
			turn(3, "turn-2"),
			turn(5, "turn-3"),
		], { retainRecentTurns: 1 });

		expect(result).toEqual({
			kind: "cut",
			startSequence: 1,
			endSequence: 4,
			compactedTurnIds: ["turn-1", "turn-2"],
			retainedTurnIds: ["turn-3"],
		});
	});

	it("does not cut through an unstable turn or an incomplete tool batch", () => {
		const result = planCompactionCut([
			turn(1, "turn-1"),
			turn(3, "turn-2", { stable: false }),
			turn(5, "turn-3", { toolCallIds: ["call-1"], toolResultIds: [] }),
		], { retainRecentTurns: 1 });

		expect(result).toEqual({ kind: "no_cut", reason: "unstable_or_incomplete_prefix" });
	});

	it("rejects malformed sequence ranges instead of producing an ambiguous checkpoint", () => {
		expect(() => planCompactionCut([
			turn(4, "turn-1"),
			{ ...turn(2, "turn-2"), endSequence: 1 },
		])).toThrowError(/sequence/i);
	});
});
