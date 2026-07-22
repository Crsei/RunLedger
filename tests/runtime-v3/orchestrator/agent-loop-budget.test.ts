import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	BudgetGuard,
	BUDGET_DIMENSIONS,
	createBudgetVector,
	type BudgetLimits,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import {
	AgentOperationBudgetError,
	BudgetGuardAgentOperationAdapter,
} from "../../../src/runtime/orchestrator/agent-loop-budget.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import type { BudgetJournalRecord } from "../../../src/runtime/orchestrator/budget-guard.ts";
import { zeroAgentOperationBudgetUsage } from "../../../src/runtime/operation-budget.ts";

function limits(hard = 1_000_000): BudgetLimits {
	return Object.fromEntries(
		BUDGET_DIMENSIONS.map((dimension) => [dimension, { soft: Math.floor(hard / 2), hard }]),
	) as BudgetLimits;
}

function runtime(hard?: number) {
	const guard = new BudgetGuard({
		goalId: createRuntimeId("goal", "agent-loop-budget"),
		limits: limits(hard),
		journal: new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>(),
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	return { guard, adapter: new BudgetGuardAgentOperationAdapter(guard, () => new Date("2026-07-22T00:00:00.000Z")) };
}

describe("BudgetGuardAgentOperationAdapter", () => {
	it("durably reserves, commits actual usage and refunds an operation that never started", async () => {
		const { guard, adapter } = runtime();
		const provider = await adapter.reserve({
			kind: "provider",
			operationKey: "modelRequest_fixture",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), inputTokens: 100, outputTokens: 50 },
		});
		await adapter.commit({
			reservation: provider,
			outcome: "succeeded",
			actual: { ...zeroAgentOperationBudgetUsage(), inputTokens: 80, outputTokens: 20 },
			resultDigest: canonicalDigest("provider-result"),
		});

		const tool = await adapter.reserve({
			kind: "tool",
			operationKey: "toolCall_fixture",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), wallTimeMs: 100, toolCalls: 1 },
		});
		await adapter.refund({ reservation: tool, reason: "not_started" });

		const snapshot = await guard.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) throw new Error(snapshot.error.message);
		expect(snapshot.value.committed).toEqual(createBudgetVector({ inputTokens: 80, outputTokens: 20 }));
		expect(snapshot.value.reserved).toEqual(createBudgetVector());
		expect(snapshot.value.reservations.map((reservation) => reservation.status).sort()).toEqual([
			"committed",
			"refunded",
		]);
	});

	it("fails closed on denial and after an uncertain operation", async () => {
		const denied = runtime(10).adapter;
		await expect(denied.reserve({
			kind: "provider",
			operationKey: "modelRequest_denied",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), inputTokens: 11 },
		})).rejects.toMatchObject({ code: "budget_denied" });

		const { adapter } = runtime();
		const reservation = await adapter.reserve({
			kind: "tool",
			operationKey: "toolCall_uncertain",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), toolCalls: 1 },
		});
		await adapter.commit({
			reservation,
			outcome: "uncertain",
			actual: { ...zeroAgentOperationBudgetUsage(), toolCalls: 1 },
			resultDigest: canonicalDigest("uncertain"),
		});
		expect(adapter.uncertainOperationKey()).toBe("toolCall_uncertain");
		await expect(adapter.reserve({
			kind: "provider",
			operationKey: "modelRequest_after-uncertain",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), inputTokens: 1 },
		})).rejects.toBeInstanceOf(AgentOperationBudgetError);
		await expect(adapter.reserve({
			kind: "provider",
			operationKey: "modelRequest_after-uncertain",
			estimatedUpperBound: { ...zeroAgentOperationBudgetUsage(), inputTokens: 1 },
		})).rejects.toMatchObject({ code: "uncertain_operation" });
	});
});
