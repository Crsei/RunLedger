import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_POLICY,
	compactMessages,
	evaluateCompactionTrigger,
	planCompactionCut,
	resolveCompactionPolicy,
	type CompactionTurn,
} from "../../../src/runtime/context/compaction/cut-planner.ts";
import type { AgentMessage } from "../../../src/runtime/types.ts";

function turn(sequence: number, id: string): CompactionTurn {
	return { turnId: id, startSequence: sequence, endSequence: sequence + 1, stable: true, toolCallIds: [], toolResultIds: [] };
}

describe("compaction policy projection", () => {
	it("uses one policy for retention and can fail closed when compaction is disabled", () => {
		expect(planCompactionCut([turn(1, "one"), turn(3, "two"), turn(5, "three")], {
			policy: { enabled: true, midTurnEnabled: false, strategy: "summary", thresholdPercent: 80, thresholdTokens: 0, retainRecentTurns: 2, minCompactedTurns: 1 },
		})).toMatchObject({ kind: "cut", compactedTurnIds: ["one"], retainedTurnIds: ["two", "three"] });
		expect(planCompactionCut([turn(1, "one"), turn(3, "two")], {
			policy: { enabled: false, midTurnEnabled: false, strategy: "summary", thresholdPercent: 80, thresholdTokens: 0, retainRecentTurns: 1, minCompactedTurns: 1 },
		})).toEqual({ kind: "no_cut", reason: "disabled" });
	});

	it("projects partial settings into a bounded immutable compaction policy", () => {
		const policy = resolveCompactionPolicy({ enabled: false, retainRecentTurns: 3 });
		expect(policy).toEqual({
			enabled: false,
			midTurnEnabled: false,
			strategy: "summary",
			thresholdPercent: 80,
			thresholdTokens: 0,
			retainRecentTurns: 3,
			minCompactedTurns: 1,
		});
		expect(Object.isFrozen(policy)).toBe(true);
		expect(resolveCompactionPolicy({ strategy: "invalid" })).toBe(DEFAULT_COMPACTION_POLICY);
	});

	it("uses the first configured threshold and blocks mid-turn compaction when disabled", () => {
		const policy = { ...DEFAULT_COMPACTION_POLICY, thresholdPercent: 80, thresholdTokens: 600 };
		expect(evaluateCompactionTrigger({ policy, contextWindow: 1_000, estimatedInputTokens: 599, midTurn: false, reason: "threshold" })).toMatchObject({ shouldCompact: false });
		expect(evaluateCompactionTrigger({ policy, contextWindow: 1_000, estimatedInputTokens: 600, midTurn: false, reason: "threshold" })).toMatchObject({ shouldCompact: true, thresholdTokens: 600 });
		expect(evaluateCompactionTrigger({ policy, contextWindow: 1_000, estimatedInputTokens: 900, midTurn: true, reason: "overflow" })).toMatchObject({ shouldCompact: false, blockedReason: "mid_turn_disabled" });
		expect(evaluateCompactionTrigger({ policy: { ...policy, midTurnEnabled: true }, contextWindow: 1_000, estimatedInputTokens: 900, midTurn: true, reason: "overflow" })).toMatchObject({ shouldCompact: true, reason: "overflow" });
	});

	it("compacts complete old turns while preserving raw message input and retention", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "first question" }] },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop" },
			{ role: "user", content: [{ type: "text", text: "second question" }] },
			{ role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "stop" },
			{ role: "user", content: [{ type: "text", text: "latest question" }] },
			{ role: "assistant", content: [{ type: "text", text: "latest answer" }], stopReason: "stop" },
		];
		const result = await compactMessages({
			messages,
			policy: { ...DEFAULT_COMPACTION_POLICY, retainRecentTurns: 1, minCompactedTurns: 1 },
			contextWindow: 100,
			estimatedInputTokens: 90,
			midTurn: false,
			reason: "threshold",
			summarize: async () => "first and second turns summary",
		});

		expect(result.status).toBe("compacted");
		expect(result.projectedMessages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("first and second turns summary") }] });
		expect(result.projectedMessages.slice(1)).toEqual(messages.slice(4));
		expect(result.originalMessages).toBe(messages);
	});

	it("keeps the live context when the summary provider is unavailable", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
			{ role: "user", content: [{ type: "text", text: "latest" }] },
		];
		const result = await compactMessages({
			messages,
			policy: { ...DEFAULT_COMPACTION_POLICY, thresholdTokens: 1 },
			contextWindow: 10,
			estimatedInputTokens: 10,
			midTurn: false,
			reason: "overflow",
			summarize: () => undefined,
		});

		expect(result.status).toBe("not_available");
		expect(result.unavailableReason).toBe("summary_unavailable");
		expect(result.projectedMessages).toBe(messages);
	});

	it("rejects invalid thresholds and keeps strategy off fail-closed", () => {
		expect(resolveCompactionPolicy({ thresholdPercent: 0 })).toEqual(DEFAULT_COMPACTION_POLICY);
		const policy = resolveCompactionPolicy({ strategy: "off" });
		expect(evaluateCompactionTrigger({
			policy,
			contextWindow: 100,
			estimatedInputTokens: 100,
			midTurn: false,
			reason: "manual",
		})).toEqual({ shouldCompact: false, reason: "manual", blockedReason: "disabled" });
	});
});
