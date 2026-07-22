import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	BUDGET_DIMENSIONS,
	BudgetGuard,
	createBudgetReservationId,
	createBudgetVector,
	type BudgetDimension,
	type BudgetJournalRecord,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import { artifact, budgetLimits, idempotency } from "./helpers.ts";

function guard(
	journal = new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>(),
	limits = budgetLimits({ soft: 800, hard: 1_000 }),
) {
	return {
		journal,
		guard: new BudgetGuard({ goalId: createRuntimeId("goal", "budget"), limits, journal }),
	};
}

function reserveRequest(dimension: BudgetDimension, amount: number, prefix: string) {
	return {
		reservationId: createBudgetReservationId(),
		operationId: createRuntimeId("command", `${prefix}-operation`),
		idempotencyKey: idempotency(`${prefix}-reserve`),
		estimatedUpperBound: createBudgetVector({ [dimension]: amount }),
	};
}

describe("root BudgetGuard", () => {
	it.each(BUDGET_DIMENSIONS)("reserves and accounts for %s before work", async (dimension) => {
		const runtime = guard();
		const request = reserveRequest(dimension, 1, `dimension-${dimension}`);
		const reserved = await runtime.guard.reserve(request);
		expect(reserved.ok && reserved.value.status).toBe("granted");
		const snapshot = await runtime.guard.snapshot();
		expect(snapshot.ok && snapshot.value.reserved[dimension]).toBe(1);
	});

	it("emits each soft reminder once and atomically hard-stops cumulative work with partial results", async () => {
		const runtime = guard(undefined, budgetLimits({ soft: 50, hard: 100 }));
		const first = reserveRequest("inputTokens", 50, "soft-first");
		expect((await runtime.guard.reserve(first)).ok).toBe(true);
		const second = reserveRequest("inputTokens", 10, "soft-second");
		expect((await runtime.guard.reserve(second)).ok).toBe(true);
		const hard = reserveRequest("inputTokens", 50, "hard-denied");
		const hardResult = await runtime.guard.reserve({ ...hard, partialResults: [artifact("partial")] });
		expect(hardResult.ok && hardResult.value.status).toBe("denied");
		if (hardResult.ok) expect(hardResult.value.snapshot.hardStop?.partialResults).toHaveLength(1);
		const after = await runtime.guard.reserve(reserveRequest("toolCalls", 1, "after-hard"));
		expect(after.ok && after.value.status).toBe("denied");

		const raw = await runtime.journal.load();
		if (!raw.ok) throw new Error(raw.error.message);
		const records = raw.value.transactions.flatMap((transaction) => transaction.records);
		expect(records.filter((record) => record.kind === "budget.soft_threshold")).toHaveLength(1);
		expect(records.filter((record) => record.kind === "budget.hard_stopped")).toHaveLength(1);
	});

	it("commits actual usage and records the unused reservation refund", async () => {
		const runtime = guard();
		const reservationId = createBudgetReservationId();
		await runtime.guard.reserve({
			reservationId,
			operationId: createRuntimeId("command", "commit-operation"),
			idempotencyKey: idempotency("commit-reserve"),
			estimatedUpperBound: createBudgetVector({ inputTokens: 100, activeAgents: 1 }),
		});
		const committed = await runtime.guard.commit({
			reservationId,
			idempotencyKey: idempotency("commit-actual"),
			actual: createBudgetVector({ inputTokens: 60 }),
		});
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.value.committed.inputTokens).toBe(60);
		expect(committed.value.reserved.inputTokens).toBe(0);
		expect(committed.value.reserved.activeAgents).toBe(0);
		const raw = await runtime.journal.load();
		if (!raw.ok) return;
		expect(raw.value.transactions.flatMap((transaction) => transaction.records).some((record) => record.kind === "budget.refunded")).toBe(true);
	});

	it("records delayed provider reconciliation and stops subsequent work on an overage", async () => {
		const runtime = guard(undefined, budgetLimits({ soft: 80, hard: 100 }));
		const reservationId = createBudgetReservationId();
		await runtime.guard.reserve({
			reservationId,
			operationId: createRuntimeId("command", "reconcile-operation"),
			idempotencyKey: idempotency("reconcile-reserve"),
			estimatedUpperBound: createBudgetVector({ inputTokens: 70, usdMicros: 70 }),
		});
		await runtime.guard.commit({
			reservationId,
			idempotencyKey: idempotency("reconcile-commit"),
			actual: createBudgetVector({ inputTokens: 65, usdMicros: 65 }),
		});
		const reconciled = await runtime.guard.reconcile({
			reservationId,
			idempotencyKey: idempotency("reconcile-late"),
			correctedActual: createBudgetVector({ inputTokens: 110, usdMicros: 105 }),
			partialResults: [artifact("reconcile-partial")],
		});
		expect(reconciled.ok).toBe(true);
		if (!reconciled.ok) return;
		expect(reconciled.value.committed.inputTokens).toBe(110);
		expect(reconciled.value.hardStop?.reason).toBe("reconciliation_overage");
		const raw = await runtime.journal.load();
		if (!raw.ok) return;
		const reconciliation = raw.value.transactions
			.flatMap((transaction) => transaction.records)
			.find((record) => record.kind === "budget.reconciled");
		expect(reconciliation?.kind === "budget.reconciled" && reconciliation.withinAllowedError).toBe(false);
	});

	it("shares the active-agent gauge across workers without permanently stopping after release", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<BudgetJournalRecord>();
		const limits = budgetLimits({ soft: 2, hard: 2 });
		const left = new BudgetGuard({ goalId: createRuntimeId("goal", "budget"), limits, journal });
		const right = new BudgetGuard({ goalId: createRuntimeId("goal", "budget"), limits, journal });
		const first = reserveRequest("activeAgents", 1, "agent-one");
		const second = reserveRequest("activeAgents", 1, "agent-two");
		const [one, two] = await Promise.all([left.reserve(first), right.reserve(second)]);
		expect(one.ok && one.value.status).toBe("granted");
		expect(two.ok && two.value.status).toBe("granted");
		const denied = await left.reserve(reserveRequest("activeAgents", 1, "agent-three"));
		expect(denied.ok && denied.value.status).toBe("denied");
		await left.refund({ reservationId: first.reservationId, idempotencyKey: idempotency("agent-release"), reason: "cancelled" });
		const admitted = await right.reserve(reserveRequest("activeAgents", 1, "agent-four"));
		expect(admitted.ok && admitted.value.status).toBe("granted");
	});

	it("replays usage and treats retries as idempotent", async () => {
		const runtime = guard();
		const request = reserveRequest("networkBytes", 25, "replay");
		const first = await runtime.guard.reserve(request);
		const duplicate = await runtime.guard.reserve(request);
		expect(first.ok && duplicate.ok).toBe(true);
		const restored = new BudgetGuard({
			goalId: createRuntimeId("goal", "budget"),
			limits: budgetLimits({ soft: 800, hard: 1_000 }),
			journal: runtime.journal,
		});
		const snapshot = await restored.snapshot();
		expect(snapshot.ok && snapshot.value.reservations).toHaveLength(1);
		expect(snapshot.ok && snapshot.value.reserved.networkBytes).toBe(25);
	});

	it("rejects reuse of a commit idempotency key with different actual usage", async () => {
		const runtime = guard();
		const reservationId = createBudgetReservationId();
		await runtime.guard.reserve({
			reservationId,
			operationId: createRuntimeId("command", "idempotent-commit"),
			idempotencyKey: idempotency("idempotent-reserve"),
			estimatedUpperBound: createBudgetVector({ inputTokens: 10 }),
		});
		const key = idempotency("idempotent-commit");
		expect(
			(await runtime.guard.commit({ reservationId, idempotencyKey: key, actual: createBudgetVector({ inputTokens: 8 }) })).ok,
		).toBe(true);
		const conflict = await runtime.guard.commit({
			reservationId,
			idempotencyKey: key,
			actual: createBudgetVector({ inputTokens: 9 }),
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.error.code).toBe("idempotency_conflict");
	});
});
