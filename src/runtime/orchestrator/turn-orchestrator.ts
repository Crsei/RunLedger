/** 最小 operation 编排门；queue 真源统一由 Session Kernel 持有。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { BudgetReservationId, CommandId } from "../protocol/v3/ids.ts";
import type { BudgetGuard, BudgetVector } from "./budget-guard.ts";
import type { LoopBreaker, LoopBreakerState, LoopObservation } from "./loop-breaker.ts";
import type {
	ControlJournalRecord,
	DurableControlJournal,
} from "./control-journal.ts";
import type { OperationSettlement, SavePointCoordinator } from "./save-point.ts";
import type {
	DurableJournalAppendOutcome,
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	GoalPhase,
	OperationSavePoint,
	OrchestratorResult,
} from "./types.ts";

/** 测试/嵌入式 reference store；生产必须注入真正 durable、跨进程 CAS 的实现。 */
export class InMemoryDurableOrchestratorJournal<TRecord>
	implements DurableOrchestratorJournalPort<TRecord>
{
	private readonly transactions: DurableJournalTransaction<TRecord>[] = [];

	public async load(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>> {
		try {
			return {
				ok: true,
				value: { revision: this.transactions.length, transactions: structuredClone(this.transactions) },
			};
		} catch {
			return { ok: false, error: { code: "journal_unavailable", message: "journal snapshot is not cloneable", retryable: false } };
		}
	}

	public async append(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>> {
		let recordsDigest: string;
		try {
			recordsDigest = canonicalDigest(transaction.records);
		} catch {
			return { ok: false, error: { code: "invalid_input", message: "journal records are not canonical", retryable: false } };
		}
		if (recordsDigest !== transaction.transactionDigest) {
			return {
				ok: false,
				error: { code: "invalid_input", message: "journal transaction digest mismatch", retryable: false },
			};
		}
		const previous = this.transactions.find((candidate) => candidate.idempotencyKey === transaction.idempotencyKey);
		if (previous) {
			if (previous.transactionDigest !== transaction.transactionDigest) {
				return {
					ok: false,
					error: {
						code: "idempotency_conflict",
						message: "idempotency key was reused for a different transaction",
						retryable: false,
					},
				};
			}
			return {
				ok: true,
				value: { status: "duplicate", revision: this.transactions.length, transaction: structuredClone(previous) },
			};
		}
		if (expectedRevision !== this.transactions.length) {
			return { ok: true, value: { status: "conflict", actualRevision: this.transactions.length } };
		}
		let stored: DurableJournalTransaction<TRecord>;
		try {
			stored = structuredClone(transaction);
		} catch {
			return { ok: false, error: { code: "invalid_input", message: "journal transaction is not cloneable", retryable: false } };
		}
		this.transactions.push(stored);
		return {
			ok: true,
			value: { status: "committed", revision: this.transactions.length, transaction: structuredClone(stored) },
		};
	}
}

const OPERATION_PHASES: ReadonlySet<GoalPhase> = new Set([
	"planning",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"remediation",
	"reverification",
]);

export interface TurnOrchestratorOptions {
	budget: BudgetGuard;
	savePoints: SavePointCoordinator;
	loopBreaker: LoopBreaker;
	control?: DurableControlJournal;
}

export interface BeginOperationRequest {
	phase: GoalPhase;
	operationKind?: "provider" | "tool" | "verification" | "governed";
	operationId: CommandId;
	reservationId: BudgetReservationId;
	estimatedUpperBound: BudgetVector;
	budgetIdempotencyKey: IdempotencyKey;
	savePointIdempotencyKey: IdempotencyKey;
	rollbackIdempotencyKey: IdempotencyKey;
}

export interface ActiveTurnOperation {
	operationId: CommandId;
	reservationId: BudgetReservationId;
	savePoint: OperationSavePoint;
}

export interface SettleOperationRequest {
	operation: ActiveTurnOperation;
	outcome: OperationSettlement["outcome"];
	resultDigest: string;
	actual: BudgetVector;
	budgetIdempotencyKey: IdempotencyKey;
	settlementIdempotencyKey: IdempotencyKey;
	safePointIdempotencyKey: IdempotencyKey;
}

/**
 * begin 的返回即“可以开始副作用”的唯一授权点：预算已 durable reserve，且
 * operation save-point 已写入。settle 在 budget commit、所有 listener settlement
 * 和 safe-point mutation apply 完成前不会返回。
 */
export class TurnOrchestrator {
	private readonly budget: BudgetGuard;
	private readonly savePoints: SavePointCoordinator;
	private readonly loopBreaker: LoopBreaker;
	private readonly control: DurableControlJournal | undefined;

	public constructor(options: TurnOrchestratorOptions) {
		this.budget = options.budget;
		this.savePoints = options.savePoints;
		this.loopBreaker = options.loopBreaker;
		this.control = options.control;
	}

	public async beginOperation(request: BeginOperationRequest): Promise<OrchestratorResult<ActiveTurnOperation>> {
		if (
			!OPERATION_PHASES.has(request.phase) ||
			(request.phase === "planning" && request.operationKind !== "provider")
		) {
			return {
				ok: false,
				error: { code: "invalid_transition", message: `phase ${request.phase} cannot start a side effect`, retryable: false },
			};
		}
		const loop = this.loopBreaker.canStartWork();
		if (!loop.ok) return loop;
		const reservation = await this.budget.reserve({
			reservationId: request.reservationId,
			operationId: request.operationId,
			idempotencyKey: request.budgetIdempotencyKey,
			estimatedUpperBound: request.estimatedUpperBound,
		});
		if (!reservation.ok) return reservation;
		if (reservation.value.status === "denied") {
			return {
				ok: false,
				error: {
					code: reservation.value.snapshot.hardStop ? "budget_stopped" : "budget_exhausted",
					message: `budget denied: ${reservation.value.exceeded.join(",")}`,
					retryable: false,
				},
			};
		}
		if (reservation.value.reservation.status !== "reserved") {
			return {
				ok: false,
				error: { code: "reservation_settled", message: "operation reservation has already settled", retryable: false },
			};
		}
		const savePoint = await this.savePoints.begin(request.operationId, request.savePointIdempotencyKey);
		if (!savePoint.ok) {
			const refunded = await this.budget.refund({
				reservationId: request.reservationId,
				idempotencyKey: request.rollbackIdempotencyKey,
				reason: "not_started",
			});
			return refunded.ok
				? savePoint
				: {
						ok: false,
						error: {
							code: "journal_unavailable",
							message: "save-point failed and reservation refund was not durable",
							retryable: true,
						},
					};
		}
		if (this.savePoints.activeSavePoint()?.savePointId !== savePoint.value.savePointId) {
			return {
				ok: false,
				error: { code: "operation_not_active", message: "operation save-point has already settled", retryable: false },
			};
		}
		return {
			ok: true,
			value: {
				operationId: request.operationId,
				reservationId: request.reservationId,
				savePoint: savePoint.value,
			},
		};
	}

	public async settleOperation(request: SettleOperationRequest): Promise<OrchestratorResult<void>> {
		const committed = await this.budget.commit({
			reservationId: request.operation.reservationId,
			idempotencyKey: request.budgetIdempotencyKey,
			actual: request.actual,
		});
		if (!committed.ok) return committed;
		const settled = await this.savePoints.settle(
			{
				operationId: request.operation.operationId,
				savePoint: request.operation.savePoint,
				outcome: request.outcome,
				resultDigest: request.resultDigest,
			},
			request.settlementIdempotencyKey,
		);
		if (!settled.ok) return settled;
		if (request.outcome === "uncertain") return { ok: true, value: undefined };
		const applied = await this.savePoints.applyPendingAtSafePoint(request.safePointIdempotencyKey);
		return applied.ok ? { ok: true, value: undefined } : applied;
	}

	public async abortOperationBeforeStart(
		operation: ActiveTurnOperation,
		reason: "cancelled" | "not_started",
		budgetIdempotencyKey: IdempotencyKey,
		settlementIdempotencyKey: IdempotencyKey,
		safePointIdempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<void>> {
		const refunded = await this.budget.refund({
			reservationId: operation.reservationId,
			idempotencyKey: budgetIdempotencyKey,
			reason,
		});
		if (!refunded.ok) return refunded;
		const settled = await this.savePoints.settle({
			operationId: operation.operationId,
			savePoint: operation.savePoint,
			outcome: "cancelled",
			resultDigest: canonicalDigest({ operationId: operation.operationId, reason }),
		}, settlementIdempotencyKey);
		if (!settled.ok) return settled;
		const applied = await this.savePoints.applyPendingAtSafePoint(safePointIdempotencyKey);
		return applied.ok ? { ok: true, value: undefined } : applied;
	}

	public recoverActiveOperation(
		operationId: CommandId,
		reservationId: BudgetReservationId,
	): OrchestratorResult<ActiveTurnOperation> {
		const savePoint = this.savePoints.activeSavePoint();
		return savePoint?.operationId === operationId
			? { ok: true, value: { operationId, reservationId, savePoint } }
			: {
					ok: false,
					error: { code: "operation_not_active", message: "operation save-point is not active", retryable: false },
				};
	}

	public observeLoop(observation: LoopObservation): OrchestratorResult<LoopBreakerState> {
		if (this.control) {
			return {
				ok: false,
				error: {
					code: "invalid_input",
					message: "production loop observation requires durable Artifact evidence",
					retryable: false,
				},
			};
		}
		return this.loopBreaker.observe(observation);
	}

	public async observeDurableLoop(
		record: Extract<ControlJournalRecord, { kind: "control.loop_observed" }>,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<LoopBreakerState>> {
		if (!this.control) {
			return {
				ok: false,
				error: { code: "journal_unavailable", message: "durable loop control journal is not configured", retryable: false },
			};
		}
		const committed = await this.control.recordLoopObservation(record, idempotencyKey);
		return committed.ok ? this.loopBreaker.observe(record.observation) : committed;
	}
}
