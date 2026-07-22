import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	BudgetGuard,
	createBudgetReservationId,
	createBudgetVector,
	type BudgetJournalRecord,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import { LoopBreaker } from "../../../src/runtime/orchestrator/loop-breaker.ts";
import { openSavePointCoordinator } from "../../../src/runtime/orchestrator/save-point.ts";
import type { SavePointJournalRecord } from "../../../src/runtime/orchestrator/types.ts";
import {
	InMemoryDurableOrchestratorJournal,
	TurnOrchestrator,
} from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import { bindings, budgetLimits, digest, idempotency } from "./helpers.ts";

async function createHarness() {
	const budgetJournal = new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>();
	const savePointJournal = new InMemoryDurableOrchestratorJournal<SavePointJournalRecord>();
	const savePoints = await openSavePointCoordinator({ initialBindings: bindings(), journal: savePointJournal });
	if (!savePoints.ok) throw new Error(savePoints.error.message);
	const budget = new BudgetGuard({
		goalId: createRuntimeId("goal", "turn"),
		limits: budgetLimits({ soft: 80, hard: 100 }),
		journal: budgetJournal,
	});
	return {
		budget,
		savePoints: savePoints.value,
		orchestrator: new TurnOrchestrator({
			budget,
			savePoints: savePoints.value,
			loopBreaker: new LoopBreaker({
				maxRepeatedToolSignature: 3,
				maxRepeatedFailure: 3,
				maxNoProgress: 3,
				maxRemediationAttempts: 3,
			}),
		}),
	};
}

describe("TurnOrchestrator", () => {
	it("durably reserves before begin and waits for settlement before applying changes", async () => {
		const harness = await createHarness();
		const operationId = createRuntimeId("command", "turn-operation");
		const reservationId = createBudgetReservationId();
		const beginRequest = {
			phase: "implementation",
			operationId,
			reservationId,
			estimatedUpperBound: createBudgetVector({ toolCalls: 1, activeAgents: 1 }),
			budgetIdempotencyKey: idempotency("turn-budget"),
			savePointIdempotencyKey: idempotency("turn-save"),
			rollbackIdempotencyKey: idempotency("turn-rollback"),
		} as const;
		const begun = await harness.orchestrator.beginOperation(beginRequest);
		expect(begun.ok).toBe(true);
		if (!begun.ok) return;
		const budgetBefore = await harness.budget.snapshot();
		expect(budgetBefore.ok && budgetBefore.value.reserved.toolCalls).toBe(1);
		await harness.savePoints.queueMutation(
			operationId,
			{
				mutationId: createRuntimeId("command", "turn-config"),
				kind: "config",
				value: { revision: 2, configDigest: digest("9") },
			},
			idempotency("turn-mutation"),
		);
		const listenerOrder: string[] = [];
		harness.savePoints.subscribe(async () => {
			await Promise.resolve();
			listenerOrder.push("settled");
		});
		const settled = await harness.orchestrator.settleOperation({
			operation: begun.value,
			outcome: "succeeded",
			resultDigest: digest("8"),
			actual: createBudgetVector({ toolCalls: 1 }),
			budgetIdempotencyKey: idempotency("turn-commit"),
			settlementIdempotencyKey: idempotency("turn-settle"),
			safePointIdempotencyKey: idempotency("turn-apply"),
		});
		expect(settled.ok).toBe(true);
		expect(listenerOrder).toEqual(["settled"]);
		expect(harness.savePoints.bindings().config.revision).toBe(2);
		const budgetAfter = await harness.budget.snapshot();
		expect(budgetAfter.ok && budgetAfter.value.committed.toolCalls).toBe(1);
		expect(budgetAfter.ok && budgetAfter.value.reserved.activeAgents).toBe(0);
		const duplicateBegin = await harness.orchestrator.beginOperation(beginRequest);
		expect(duplicateBegin.ok).toBe(false);
	});

	it("blocks side effects outside work phases and after the loop breaker trips", async () => {
		const harness = await createHarness();
		const base = {
			operationId: createRuntimeId("command", "blocked-operation"),
			reservationId: createBudgetReservationId(),
			estimatedUpperBound: createBudgetVector({ toolCalls: 1 }),
			budgetIdempotencyKey: idempotency("blocked-budget"),
			savePointIdempotencyKey: idempotency("blocked-save"),
			rollbackIdempotencyKey: idempotency("blocked-rollback"),
		};
		expect((await harness.orchestrator.beginOperation({ ...base, phase: "planning" })).ok).toBe(false);
		for (let index = 0; index < 3; index += 1) {
			harness.orchestrator.observeLoop({
				observationId: `loop-${index}`,
				phase: "implementation",
				toolSignature: "same",
				madeProgress: true,
				observedAt: "2026-07-22T00:00:00.000Z",
			});
		}
		const blocked = await harness.orchestrator.beginOperation({
			...base,
			phase: "implementation",
			operationId: createRuntimeId("command", "loop-blocked"),
			reservationId: createBudgetReservationId(),
		});
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("loop_broken");
	});

	it("refunds a reservation when save-point creation cannot start", async () => {
		const harness = await createHarness();
		const activeOperation = createRuntimeId("command", "already-active");
		await harness.savePoints.begin(activeOperation, idempotency("already-active"));
		const reservationId = createBudgetReservationId();
		const blocked = await harness.orchestrator.beginOperation({
			phase: "implementation",
			operationId: createRuntimeId("command", "cannot-start"),
			reservationId,
			estimatedUpperBound: createBudgetVector({ toolCalls: 1 }),
			budgetIdempotencyKey: idempotency("cannot-budget"),
			savePointIdempotencyKey: idempotency("cannot-save"),
			rollbackIdempotencyKey: idempotency("cannot-rollback"),
		});
		expect(blocked.ok).toBe(false);
		const snapshot = await harness.budget.snapshot();
		const reservation = snapshot.ok ? snapshot.value.reservations.find((entry) => entry.reservationId === reservationId) : undefined;
		expect(reservation?.status).toBe("refunded");
	});
});
