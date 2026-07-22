import { describe, expect, it } from "vitest";
import { RootBudgetGuardAdapter } from "../../../src/runtime/agents/supervisor.ts";
import type { AgentBudgetRequest } from "../../../src/runtime/agents/types.ts";
import {
	BUDGET_DIMENSIONS,
	BudgetGuard,
	type BudgetJournalRecord,
	type BudgetLimits,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { key } from "./helpers.ts";

function limits(): BudgetLimits {
	const result = Object.fromEntries(
		BUDGET_DIMENSIONS.map((dimension) => [dimension, { soft: dimension === "activeAgents" ? 1 : 1_000_000, hard: dimension === "activeAgents" ? 1 : 2_000_000 }]),
	);
	return result as BudgetLimits;
}

function budget(): AgentBudgetRequest {
	return {
		maxTurns: 8,
		maxInputTokens: 100,
		maxOutputTokens: 200,
		maxUsdMicros: 300,
		maxWallTimeMs: 400,
		maxToolCalls: 5,
		maxNetworkBytes: 600,
		maxStorageBytes: 700,
	};
}

function reserveRequest(seed: string) {
	const agentId = createRuntimeId("agent", seed);
	const agentBudget = budget();
	return {
		requestId: createRuntimeId("command", `reserve-${seed}`),
		idempotencyKey: key(`reserve-${seed}`),
		agentId,
		budget: agentBudget,
		requestDigest: canonicalDigest({ agentId, budget: agentBudget }),
	};
}

describe("root BudgetGuard adapter", () => {
	it("reserves every child dimension plus the shared active-agent gauge", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>();
		const guard = new BudgetGuard({ goalId: createRuntimeId("goal", "agents"), limits: limits(), journal });
		const adapter = new RootBudgetGuardAdapter(guard);
		const reserved = await adapter.reserve(reserveRequest("one"));
		expect(reserved.ok).toBe(true);
		const snapshot = await guard.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.reserved).toMatchObject({
			inputTokens: 100,
			outputTokens: 200,
			usdMicros: 300,
			wallTimeMs: 400,
			toolCalls: 5,
			networkBytes: 600,
			storageBytes: 700,
			activeAgents: 1,
		});
	});

	it("denies excess concurrency, then admits after the prior reservation is released", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>();
		const guard = new BudgetGuard({ goalId: createRuntimeId("goal", "agents"), limits: limits(), journal });
		const adapter = new RootBudgetGuardAdapter(guard);
		const first = await adapter.reserve(reserveRequest("first"));
		if (!first.ok) throw new Error(first.error.message);
		const denied = await adapter.reserve(reserveRequest("second"));
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.code).toBe("budget_denied");
		expect(
			(
				await adapter.settle({
					idempotencyKey: key("settle-first"),
					reservation: first.value,
					outcome: "stopped",
					partialResults: [],
				})
			).ok,
		).toBe(true);
		expect((await adapter.reserve(reserveRequest("third"))).ok).toBe(true);
	});
});
