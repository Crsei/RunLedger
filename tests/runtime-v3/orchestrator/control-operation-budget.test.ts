import { describe, expect, it } from "vitest";
import { zeroAgentOperationBudgetUsage } from "../../../src/runtime/operation-budget.ts";
import {
	BudgetGuard,
	createBudgetVector,
	type BudgetJournalRecord,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import {
	DurableControlJournal,
	createDurableLoopObservation,
	type ControlJournalRecord,
} from "../../../src/runtime/orchestrator/control-journal.ts";
import { DurableRetryController } from "../../../src/runtime/orchestrator/durable-retry-controller.ts";
import { LoopBreaker } from "../../../src/runtime/orchestrator/loop-breaker.ts";
import { openSavePointCoordinator } from "../../../src/runtime/orchestrator/save-point.ts";
import { TurnOrchestrator } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import { TurnOrchestratorAgentOperationAdapter } from "../../../src/runtime/orchestrator/turn-operation-budget.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import type { SavePointJournalRecord } from "../../../src/runtime/orchestrator/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { bindings, budgetLimits, digest, idempotency } from "./helpers.ts";

describe("durable governed operation budget", () => {
	it("keeps uncertain mutations unapplied and blocks restart-safe work until reconciliation", async () => {
		const budget = new BudgetGuard({
			goalId: createRuntimeId("goal", "governed-operation"),
			limits: budgetLimits({ soft: 1_000, hard: 2_000 }),
			journal: new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>(),
		});
		const savePoints = await openSavePointCoordinator({
			initialBindings: bindings(),
			journal: new InMemoryDurableOrchestratorJournal<SavePointJournalRecord>(),
		});
		if (!savePoints.ok) throw new Error(savePoints.error.message);
		const controlJournal = new InMemoryDurableOrchestratorJournal<ControlJournalRecord>();
		const control = new DurableControlJournal({ journal: controlJournal });
		const turns = new TurnOrchestrator({
			budget,
			savePoints: savePoints.value,
			loopBreaker: new LoopBreaker({
				maxRepeatedToolSignature: 3,
				maxRepeatedFailure: 3,
				maxNoProgress: 3,
				maxRemediationAttempts: 3,
			}),
		});
		const adapter = new TurnOrchestratorAgentOperationAdapter({
			turns,
			savePoints: savePoints.value,
			control,
			phase: () => "planning",
		});
		const reservation = await adapter.reserve({
			kind: "provider",
			operationKey: "provider-request-stable",
			estimatedUpperBound: {
				...zeroAgentOperationBudgetUsage(),
				inputTokens: 100,
			},
		});
		await savePoints.value.queueMutation(
			reservation.operationId,
			{
				mutationId: createRuntimeId("command", "uncertain-model-mutation"),
				kind: "config",
				value: { revision: 2, configDigest: digest("9") },
			},
			idempotency("uncertain-mutation"),
		);
		await adapter.commit({
			reservation,
			outcome: "uncertain",
			actual: zeroAgentOperationBudgetUsage(),
			resultDigest: digest("8"),
		});
		expect(savePoints.value.bindings().config.revision).toBe(1);
		expect(savePoints.value.pendingMutationCount()).toBe(1);
		const recoveredControl = new DurableControlJournal({ journal: controlJournal });
		const snapshot = await recoveredControl.snapshot();
		expect(snapshot.ok && snapshot.value.uncertainOperations).toHaveLength(1);
		const observation = createDurableLoopObservation({
			observationId: "durable-observation",
			phase: "implementation",
			toolSignature: digest("1"),
			diffDigest: digest("2"),
			observedAt: "2026-07-24T00:00:00.000Z",
		}, {
			artifactIds: [createRuntimeId("artifact", "durable-loop-evidence")],
			toolResultDigests: [digest("3")],
			diffDigests: [digest("4")],
			failureDigests: [],
			beforeTreeDigest: digest("5"),
			afterTreeDigest: digest("6"),
		});
		if (!observation.ok) throw new Error(observation.error.message);
		expect((await recoveredControl.recordLoopObservation(
			observation.value,
			idempotency("durable-observation"),
		)).ok).toBe(true);
		expect(createDurableLoopObservation({
			observationId: "model-only",
			phase: "implementation",
			observedAt: "2026-07-24T00:00:00.000Z",
		}, {
			artifactIds: [],
			toolResultDigests: [],
			diffDigests: [],
			failureDigests: [],
			beforeTreeDigest: digest("5"),
			afterTreeDigest: digest("5"),
		}).ok).toBe(false);
		await expect(adapter.reserve({
			kind: "provider",
			operationKey: "next-provider-request",
			estimatedUpperBound: zeroAgentOperationBudgetUsage(),
		})).rejects.toMatchObject({ code: "uncertain_operation" });
		await adapter.reconcile(reservation, digest("7"));
		const retry = new DurableRetryController({ control: recoveredControl });
		const retryDecision = await retry.decide(
			createRuntimeId("command", "safe-network-retry"),
			{
				category: "network",
				code: "connection_reset",
				definitelyNotApplied: true,
			},
			{
				attempt: 1,
				maxAttempts: 2,
				operation: "provider",
				sideEffect: "read",
				hasStableIdempotencyKey: true,
				compactionAttempts: 0,
				maxCompactionAttempts: 1,
			},
			idempotency("safe-network-retry"),
		);
		expect(retryDecision.ok && retryDecision.value.action).toBe("retry");
		expect(savePoints.value.pendingMutationCount()).toBe(0);
		expect(savePoints.value.bindings().config.revision).toBe(1);
			const next = await adapter.reserve({
				kind: "provider",
				operationKey: "next-provider-request",
				estimatedUpperBound: {
					...zeroAgentOperationBudgetUsage(),
					inputTokens: 1,
				},
			});
		await adapter.refund({ reservation: next, reason: "not_started" });
		const budgetSnapshot = await budget.snapshot();
		expect(budgetSnapshot.ok && budgetSnapshot.value.reserved).toEqual(createBudgetVector());
	});
});
