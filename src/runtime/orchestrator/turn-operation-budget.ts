/** AgentOperationBudgetPort 的 TurnOrchestrator-backed production adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type {
	AgentOperationBudgetCommitRequest,
	AgentOperationBudgetPort,
	AgentOperationBudgetRefundRequest,
	AgentOperationBudgetReservation,
	AgentOperationBudgetReserveRequest,
	AgentOperationBudgetUsage,
} from "../operation-budget.ts";
import { createBudgetVector } from "./budget-guard.ts";
import { AgentOperationBudgetError } from "./agent-loop-budget.ts";
import type { DurableControlJournal } from "./control-journal.ts";
import type { SavePointCoordinator } from "./save-point.ts";
import type { ActiveTurnOperation, TurnOrchestrator } from "./turn-orchestrator.ts";
import type { GoalPhase } from "./types.ts";

export interface TurnOrchestratorAgentOperationAdapterOptions {
	turns: TurnOrchestrator;
	savePoints: SavePointCoordinator;
	control: DurableControlJournal;
	phase: () => GoalPhase;
	clock?: () => Date;
}

const DIGEST = /^[a-f0-9]{64}$/u;

function validUsage(usage: AgentOperationBudgetUsage): boolean {
	return Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0);
}

function vector(usage: AgentOperationBudgetUsage) {
	return createBudgetVector({ ...usage, activeAgents: 0 });
}

function seed(kind: string, operationKey: string): string {
	return `${kind}-${canonicalDigest(operationKey).slice(0, 48)}`;
}

function key(action: string, identity: string) {
	return createIdempotencyKey(`turn-budget-${action}-${canonicalDigest(identity).slice(0, 48)}`);
}

/**
 * 兼容既有 AgentOperationBudgetPort，但 production 的副作用授权点同时要求
 * durable budget reservation 与 save-point。uncertain outcome 另写 control gate，
 * 重启后仍阻止后续 operation。
 */
export class TurnOrchestratorAgentOperationAdapter implements AgentOperationBudgetPort {
	readonly #turns: TurnOrchestrator;
	readonly #savePoints: SavePointCoordinator;
	readonly #control: DurableControlJournal;
	readonly #phase: () => GoalPhase;
	readonly #clock: () => Date;
	readonly #active = new Map<string, ActiveTurnOperation>();

	public constructor(options: TurnOrchestratorAgentOperationAdapterOptions) {
		this.#turns = options.turns;
		this.#savePoints = options.savePoints;
		this.#control = options.control;
		this.#phase = options.phase;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async reserve(request: AgentOperationBudgetReserveRequest): Promise<AgentOperationBudgetReservation> {
		if (!request.operationKey || !validUsage(request.estimatedUpperBound)) {
			throw new AgentOperationBudgetError("invalid_budget_usage", "operation budget estimate is invalid");
		}
		const control = await this.#control.snapshot();
		if (!control.ok) {
			throw new AgentOperationBudgetError("budget_unavailable", `control journal failed: ${control.error.code}`);
		}
		if (control.value.uncertainOperations.length > 0) {
			throw new AgentOperationBudgetError(
				"uncertain_operation",
				`operation ${control.value.uncertainOperations[0]!.operationId} requires reconciliation`,
			);
		}
		const operationId = createRuntimeId("command", seed(`${request.kind}-operation`, request.operationKey));
		const reservationId = createRuntimeId(
			"budgetReservation",
			seed(`${request.kind}-reservation`, request.operationKey),
		);
		const begun = await this.#turns.beginOperation({
			phase: this.#phase(),
			operationKind: request.kind,
			operationId,
			reservationId,
			estimatedUpperBound: vector(request.estimatedUpperBound),
			budgetIdempotencyKey: key("reserve", reservationId),
			savePointIdempotencyKey: key("save-point", operationId),
			rollbackIdempotencyKey: key("rollback", reservationId),
		});
		if (!begun.ok) {
			throw new AgentOperationBudgetError(
				begun.error.code === "budget_exhausted" || begun.error.code === "budget_stopped"
					? "budget_denied"
					: "budget_unavailable",
				`governed operation reservation failed: ${begun.error.code}`,
			);
		}
		this.#active.set(request.operationKey, begun.value);
		return {
			kind: request.kind,
			operationKey: request.operationKey,
			operationId,
			reservationId,
			estimatedUpperBound: { ...request.estimatedUpperBound },
			reservedAtMs: this.#clock().getTime(),
		};
	}

	#operation(reservation: AgentOperationBudgetReservation): ActiveTurnOperation {
		const active = this.#active.get(reservation.operationKey);
		if (
			active?.operationId === reservation.operationId &&
			active.reservationId === reservation.reservationId
		) return active;
		const recovered = this.#turns.recoverActiveOperation(
			reservation.operationId,
			reservation.reservationId,
		);
		if (!recovered.ok) {
			throw new AgentOperationBudgetError("budget_unavailable", "operation save-point cannot be recovered");
		}
		return recovered.value;
	}

	public async commit(request: AgentOperationBudgetCommitRequest): Promise<void> {
		if (!validUsage(request.actual) || !DIGEST.test(request.resultDigest)) {
			throw new AgentOperationBudgetError("invalid_budget_usage", "operation budget settlement is invalid");
		}
		const operation = this.#operation(request.reservation);
		const identityDigest = canonicalDigest({
			kind: request.reservation.kind,
			operationKey: request.reservation.operationKey,
			operationId: request.reservation.operationId,
			reservationId: request.reservation.reservationId,
		});
		if (request.outcome === "uncertain") {
			// gate 必须先于 budget/save-point terminal；任一边界 crash 都只能多阻塞，
			// 不能在 outcome unknown 时短暂开放下一副作用。
			const gated = await this.#control.gateUncertainOperation(
				request.reservation.operationId,
				identityDigest,
				request.resultDigest,
				key("uncertain", request.reservation.operationId),
			);
			if (!gated.ok) {
				throw new AgentOperationBudgetError("budget_unavailable", `uncertain gate failed: ${gated.error.code}`);
			}
		}
		const settled = await this.#turns.settleOperation({
			operation,
			outcome: request.outcome,
			resultDigest: request.resultDigest,
			actual: vector(request.actual),
			budgetIdempotencyKey: key("commit", request.reservation.reservationId),
			settlementIdempotencyKey: key("settle", request.reservation.operationId),
			safePointIdempotencyKey: key("safe-point", request.reservation.operationId),
		});
		if (!settled.ok) {
			throw new AgentOperationBudgetError("budget_unavailable", `operation settlement failed: ${settled.error.code}`);
		}
		this.#active.delete(request.reservation.operationKey);
	}

	public async refund(request: AgentOperationBudgetRefundRequest): Promise<void> {
		const operation = this.#operation(request.reservation);
		const aborted = await this.#turns.abortOperationBeforeStart(
			operation,
			request.reason,
			key(`refund-${request.reason}`, request.reservation.reservationId),
			key(`cancel-${request.reason}`, request.reservation.operationId),
			key(`cancel-safe-point-${request.reason}`, request.reservation.operationId),
		);
		if (!aborted.ok) {
			throw new AgentOperationBudgetError("budget_unavailable", `operation refund failed: ${aborted.error.code}`);
		}
		this.#active.delete(request.reservation.operationKey);
	}

	public async reconcile(
		reservation: AgentOperationBudgetReservation,
		reconciliationReceiptDigest: string,
	): Promise<void> {
		if (!DIGEST.test(reconciliationReceiptDigest)) {
			throw new AgentOperationBudgetError("invalid_budget_usage", "reconciliation receipt digest is invalid");
		}
		const identityDigest = canonicalDigest({
			kind: reservation.kind,
			operationKey: reservation.operationKey,
			operationId: reservation.operationId,
			reservationId: reservation.reservationId,
		});
		if (this.#savePoints.pendingMutationCount() > 0) {
			const discarded = await this.#savePoints.discardPendingAfterReconciliation(
				reservation.operationId,
				reconciliationReceiptDigest,
				key("discard-uncertain-mutations", reservation.operationId),
			);
			if (!discarded.ok) {
				throw new AgentOperationBudgetError("budget_unavailable", `mutation reconciliation failed: ${discarded.error.code}`);
			}
		}
		const reconciled = await this.#control.reconcileUncertainOperation(
			reservation.operationId,
			identityDigest,
			reconciliationReceiptDigest,
			key("reconcile-uncertain", reservation.operationId),
		);
		if (!reconciled.ok) {
			throw new AgentOperationBudgetError("budget_unavailable", `uncertain reconciliation failed: ${reconciled.error.code}`);
		}
	}
}
