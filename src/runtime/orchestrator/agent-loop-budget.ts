/** BudgetGuard 到 Agent loop operation port 的 fail-closed adapter。 */

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
import { createBudgetVector, type BudgetGuard, type BudgetVector } from "./budget-guard.ts";

export class AgentOperationBudgetError extends Error {
	public readonly code:
		| "budget_denied"
		| "budget_unavailable"
		| "invalid_budget_usage"
		| "uncertain_operation";

	public constructor(
		code: AgentOperationBudgetError["code"],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentOperationBudgetError";
		this.code = code;
	}
}

function validUsage(usage: AgentOperationBudgetUsage): boolean {
	return Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0);
}

function toBudgetVector(usage: AgentOperationBudgetUsage): BudgetVector {
	return createBudgetVector({ ...usage, activeAgents: 0 });
}

function stableSeed(kind: string, operationKey: string): string {
	return `${kind}-${canonicalDigest(operationKey).slice(0, 48)}`;
}

function idempotency(action: string, reservationId: string) {
	return createIdempotencyKey(`agent-budget-${action}-${canonicalDigest(reservationId).slice(0, 48)}`);
}

/**
 * BudgetGuard 仍负责 durable reserve/commit/refund 与阈值；adapter 只收敛 ID、
 * 错误语义和同进程 uncertain gate。跨重启 uncertain gate 由 canonical tool event
 * projection/recovery 决定，不能用这个内存字段替代。
 */
export class BudgetGuardAgentOperationAdapter implements AgentOperationBudgetPort {
	readonly #guard: BudgetGuard;
	readonly #clock: () => Date;
	#uncertainOperationKey: string | undefined;

	public constructor(guard: BudgetGuard, clock: () => Date = () => new Date()) {
		this.#guard = guard;
		this.#clock = clock;
	}

	public async reserve(
		request: AgentOperationBudgetReserveRequest,
	): Promise<AgentOperationBudgetReservation> {
		if (this.#uncertainOperationKey) {
			throw new AgentOperationBudgetError(
				"uncertain_operation",
				`operation ${this.#uncertainOperationKey} has an uncertain outcome`,
			);
		}
		if (request.operationKey.length === 0 || !validUsage(request.estimatedUpperBound)) {
			throw new AgentOperationBudgetError("invalid_budget_usage", "operation budget estimate is invalid");
		}
		const operationId = createRuntimeId("command", stableSeed(`${request.kind}-operation`, request.operationKey));
		const reservationId = createRuntimeId(
			"budgetReservation",
			stableSeed(`${request.kind}-reservation`, request.operationKey),
		);
		const reserved = await this.#guard.reserve({
			operationId,
			reservationId,
			idempotencyKey: idempotency("reserve", reservationId),
			estimatedUpperBound: toBudgetVector(request.estimatedUpperBound),
		});
		if (!reserved.ok) {
			throw new AgentOperationBudgetError(
				"budget_unavailable",
				`budget reservation failed: ${reserved.error.code}`,
			);
		}
		if (reserved.value.status === "denied") {
			throw new AgentOperationBudgetError(
				"budget_denied",
				`budget reservation denied: ${reserved.value.exceeded.join(",")}`,
			);
		}
		return {
			kind: request.kind,
			operationKey: request.operationKey,
			operationId,
			reservationId,
			estimatedUpperBound: { ...request.estimatedUpperBound },
			reservedAtMs: this.#clock().getTime(),
		};
	}

	public async commit(request: AgentOperationBudgetCommitRequest): Promise<void> {
		if (!validUsage(request.actual) || !/^[a-f0-9]{64}$/.test(request.resultDigest)) {
			throw new AgentOperationBudgetError("invalid_budget_usage", "operation budget settlement is invalid");
		}
		const committed = await this.#guard.commit({
			reservationId: request.reservation.reservationId,
			idempotencyKey: idempotency("commit", request.reservation.reservationId),
			actual: toBudgetVector(request.actual),
		});
		if (!committed.ok) {
			throw new AgentOperationBudgetError(
				"budget_unavailable",
				`budget commit failed: ${committed.error.code}`,
			);
		}
		if (request.outcome === "uncertain") this.#uncertainOperationKey = request.reservation.operationKey;
	}

	public async refund(request: AgentOperationBudgetRefundRequest): Promise<void> {
		const refunded = await this.#guard.refund({
			reservationId: request.reservation.reservationId,
			idempotencyKey: idempotency(`refund-${request.reason}`, request.reservation.reservationId),
			reason: request.reason,
		});
		if (!refunded.ok) {
			throw new AgentOperationBudgetError(
				"budget_unavailable",
				`budget refund failed: ${refunded.error.code}`,
			);
		}
	}

	public uncertainOperationKey(): string | undefined {
		return this.#uncertainOperationKey;
	}
}
