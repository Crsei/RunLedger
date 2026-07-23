/** Child Agent 的本地 operation budget 与 exact usage 聚合；不结算父级 child reservation。 */

import {
	AGENT_OPERATION_BUDGET_DIMENSIONS,
	zeroAgentOperationBudgetUsage,
	type AgentOperationBudgetCommitRequest,
	type AgentOperationBudgetPort,
	type AgentOperationBudgetRefundRequest,
	type AgentOperationBudgetReservation,
	type AgentOperationBudgetReserveRequest,
	type AgentOperationBudgetUsage,
} from "../../operation-budget.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../../protocol/v3/ids.ts";
import type {
	AgentBudgetRequest,
	AgentBudgetUsage,
	AgentResult,
} from "../types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_OPERATION_KEY_LENGTH = 1_024;

const BOUNDED_USAGE_DIMENSIONS = [
	"inputTokens",
	"outputTokens",
	"usdMicros",
	"wallTimeMs",
	"toolCalls",
	"networkBytes",
	"storageBytes",
] as const;

type BoundedUsageDimension = (typeof BOUNDED_USAGE_DIMENSIONS)[number];

type ChildOperationState =
	| "reserving"
	| "reserve_uncertain"
	| "reserved"
	| "committing"
	| "refunding"
	| "committed"
	| "refunded"
	| "semantic_uncertain"
	| "settlement_uncertain"
	| "accounting_uncertain";

interface ChildOperationRecord {
	request: AgentOperationBudgetReserveRequest;
	requestDigest: string;
	state: ChildOperationState;
	reservePromise?: Promise<AgentOperationBudgetReservation>;
	reservation?: AgentOperationBudgetReservation;
	settlementKind?: "commit" | "refund";
	settlementDigest?: string;
	settlementPromise?: Promise<void>;
	actual?: AgentOperationBudgetUsage;
	outcome?: AgentOperationBudgetCommitRequest["outcome"];
	terminalError?: ChildOperationBudgetError;
}

export interface ChildOperationBudgetOptions {
	budget: AgentBudgetRequest;
	/**
	 * 仅可传 child-scoped operation port。省略时使用本地 reservation identity，
	 * 避免把父级 child reservation 再次 reserve/commit 造成双计。
	 */
	delegate?: AgentOperationBudgetPort;
	clock?: () => Date;
}

export class ChildOperationBudgetError extends Error {
	public readonly code:
		| "invalid_budget"
		| "invalid_operation"
		| "budget_exhausted"
		| "idempotency_conflict"
		| "reservation_mismatch"
		| "uncertain_operation"
		| "delegate_unavailable";

	public constructor(
		code: ChildOperationBudgetError["code"],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ChildOperationBudgetError";
		this.code = code;
	}
}

function usageIsValid(value: AgentOperationBudgetUsage): boolean {
	const candidate = value as Readonly<Record<string, unknown>>;
	const keys = Object.keys(candidate);
	return (
		keys.length === AGENT_OPERATION_BUDGET_DIMENSIONS.length &&
		AGENT_OPERATION_BUDGET_DIMENSIONS.every(
			(dimension) =>
				Object.hasOwn(candidate, dimension) &&
				Number.isSafeInteger(candidate[dimension]) &&
				(candidate[dimension] as number) >= 0,
		)
	);
}

function usageHasWork(value: AgentOperationBudgetUsage): boolean {
	return AGENT_OPERATION_BUDGET_DIMENSIONS.some(
		(dimension) => value[dimension] > 0,
	);
}

function budgetIsValid(value: AgentBudgetRequest): boolean {
	return (
		Number.isSafeInteger(value.maxTurns) &&
		value.maxTurns >= 1 &&
		Number.isSafeInteger(value.maxInputTokens) &&
		value.maxInputTokens >= 0 &&
		Number.isSafeInteger(value.maxOutputTokens) &&
		value.maxOutputTokens >= 0 &&
		Number.isSafeInteger(value.maxUsdMicros) &&
		value.maxUsdMicros >= 0 &&
		Number.isSafeInteger(value.maxWallTimeMs) &&
		value.maxWallTimeMs >= 0 &&
		Number.isSafeInteger(value.maxToolCalls) &&
		value.maxToolCalls >= 0 &&
		Number.isSafeInteger(value.maxNetworkBytes) &&
		value.maxNetworkBytes >= 0 &&
		Number.isSafeInteger(value.maxStorageBytes) &&
		value.maxStorageBytes >= 0
	);
}

function requestIsValid(request: AgentOperationBudgetReserveRequest): boolean {
	return (
		(request.kind === "provider" || request.kind === "tool") &&
		request.operationKey.length > 0 &&
		request.operationKey.length <= MAX_OPERATION_KEY_LENGTH &&
		!request.operationKey.includes("\0") &&
		usageIsValid(request.estimatedUpperBound) &&
		usageHasWork(request.estimatedUpperBound)
	);
}

function commitIsValid(request: AgentOperationBudgetCommitRequest): boolean {
	return (
		["succeeded", "failed", "cancelled", "uncertain"].includes(
			request.outcome,
		) &&
		usageIsValid(request.actual) &&
		DIGEST_PATTERN.test(request.resultDigest)
	);
}

function refundIsValid(request: AgentOperationBudgetRefundRequest): boolean {
	return request.reason === "cancelled" || request.reason === "not_started";
}

function reservationIsValid(
	reservation: AgentOperationBudgetReservation,
): boolean {
	return (
		(reservation.kind === "provider" || reservation.kind === "tool") &&
		reservation.operationKey.length > 0 &&
		reservation.operationKey.length <= MAX_OPERATION_KEY_LENGTH &&
		isRuntimeId(reservation.operationId, "command") &&
		isRuntimeId(reservation.reservationId, "budgetReservation") &&
		usageIsValid(reservation.estimatedUpperBound) &&
		Number.isSafeInteger(reservation.reservedAtMs) &&
		reservation.reservedAtMs >= 0
	);
}

function safeAdd(left: number, right: number): number | undefined {
	const sum = left + right;
	return Number.isSafeInteger(sum) && sum >= 0 ? sum : undefined;
}

function addUsage(
	left: AgentOperationBudgetUsage,
	right: AgentOperationBudgetUsage,
): AgentOperationBudgetUsage | undefined {
	const next = { ...zeroAgentOperationBudgetUsage() };
	for (const dimension of AGENT_OPERATION_BUDGET_DIMENSIONS) {
		const sum = safeAdd(left[dimension], right[dimension]);
		if (sum === undefined) return undefined;
		next[dimension] = sum;
	}
	return next;
}

function maxUsage(
	left: AgentOperationBudgetUsage,
	right: AgentOperationBudgetUsage,
): AgentOperationBudgetUsage {
	const next = { ...zeroAgentOperationBudgetUsage() };
	for (const dimension of AGENT_OPERATION_BUDGET_DIMENSIONS) {
		next[dimension] = Math.max(left[dimension], right[dimension]);
	}
	return next;
}

function boundedLimit(
	budget: AgentBudgetRequest,
	dimension: BoundedUsageDimension,
): number {
	switch (dimension) {
		case "inputTokens":
			return budget.maxInputTokens;
		case "outputTokens":
			return budget.maxOutputTokens;
		case "usdMicros":
			return budget.maxUsdMicros;
		case "wallTimeMs":
			return budget.maxWallTimeMs;
		case "toolCalls":
			return budget.maxToolCalls;
		case "networkBytes":
			return budget.maxNetworkBytes;
		case "storageBytes":
			return budget.maxStorageBytes;
	}
}

function usageExceedsBudget(
	usage: AgentOperationBudgetUsage,
	budget: AgentBudgetRequest,
): readonly BoundedUsageDimension[] {
	return BOUNDED_USAGE_DIMENSIONS.filter(
		(dimension) => usage[dimension] > boundedLimit(budget, dimension),
	);
}

function cloneReservation(
	reservation: AgentOperationBudgetReservation,
): AgentOperationBudgetReservation {
	return {
		...reservation,
		estimatedUpperBound: { ...reservation.estimatedUpperBound },
	};
}

function cloneReserveRequest(
	request: AgentOperationBudgetReserveRequest,
): AgentOperationBudgetReserveRequest {
	return {
		...request,
		estimatedUpperBound: { ...request.estimatedUpperBound },
	};
}

function cloneCommitRequest(
	request: AgentOperationBudgetCommitRequest,
): AgentOperationBudgetCommitRequest {
	return {
		...request,
		reservation: cloneReservation(request.reservation),
		actual: { ...request.actual },
	};
}

function cloneRefundRequest(
	request: AgentOperationBudgetRefundRequest,
): AgentOperationBudgetRefundRequest {
	return {
		...request,
		reservation: cloneReservation(request.reservation),
	};
}

function exactReservation(
	left: AgentOperationBudgetReservation,
	right: AgentOperationBudgetReservation,
): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function localReservation(
	request: AgentOperationBudgetReserveRequest,
	clock: () => Date,
): AgentOperationBudgetReservation {
	const requestDigest = canonicalDigest(request);
	const reservedAtMs = clock().getTime();
	if (!Number.isSafeInteger(reservedAtMs) || reservedAtMs < 0) {
		throw new ChildOperationBudgetError(
			"invalid_operation",
			"child operation reservation clock is invalid",
		);
	}
	return {
		kind: request.kind,
		operationKey: request.operationKey,
		operationId: createRuntimeId(
			"command",
			`child-operation-${requestDigest.slice(0, 48)}`,
		),
		reservationId: createRuntimeId(
			"budgetReservation",
			`child-operation-${requestDigest.slice(0, 48)}`,
		),
		estimatedUpperBound: { ...request.estimatedUpperBound },
		reservedAtMs,
	};
}

function usageResultFailure(message: string): AgentResult<AgentBudgetUsage> {
	return {
		ok: false,
		error: {
			code: "reference_unavailable",
			message,
			retryable: true,
		},
	};
}

/**
 * Agent loop 可直接使用的 child-scoped port。它只聚合 child operation usage；
 * 父级 `AgentBudgetReservationRef` 仍由 Supervisor 在语义终态之后唯一结算。
 */
export class ChildOperationBudget implements AgentOperationBudgetPort {
	readonly #budget: AgentBudgetRequest;
	readonly #delegate: AgentOperationBudgetPort | undefined;
	readonly #clock: () => Date;
	readonly #records = new Map<string, ChildOperationRecord>();
	#exhausted = false;

	public constructor(options: ChildOperationBudgetOptions) {
		if (!budgetIsValid(options.budget)) {
			throw new ChildOperationBudgetError(
				"invalid_budget",
				"child operation budget limits must be safe non-negative integers",
			);
		}
		this.#budget = { ...options.budget };
		this.#delegate = options.delegate;
		this.#clock = options.clock ?? (() => new Date());
	}

	#uncertainRecord(): ChildOperationRecord | undefined {
		return [...this.#records.values()].find((record) =>
			record.state === "reserve_uncertain" ||
			record.state === "semantic_uncertain" ||
			record.state === "settlement_uncertain" ||
			record.state === "accounting_uncertain"
		);
	}

	#turnsInUse(): number {
		let turns = 0;
		for (const record of this.#records.values()) {
			if (
				record.request.kind === "provider" &&
				record.state !== "refunded"
			) {
				turns += 1;
			}
		}
		return turns;
	}

	#recordProjection(record: ChildOperationRecord): AgentOperationBudgetUsage {
		if (
			(record.state === "committed" ||
				record.state === "semantic_uncertain" ||
				record.state === "accounting_uncertain") &&
			record.actual
		) {
			return record.actual;
		}
		if (
			(record.state === "committing" ||
				record.state === "settlement_uncertain") &&
			record.actual
		) {
			return maxUsage(
				record.request.estimatedUpperBound,
				record.actual,
			);
		}
		return record.request.estimatedUpperBound;
	}

	#projectedUsage(
		additional?: AgentOperationBudgetUsage,
	): AgentOperationBudgetUsage | undefined {
		let projected = zeroAgentOperationBudgetUsage();
		for (const record of this.#records.values()) {
			if (record.state === "refunded") continue;
			const next = addUsage(projected, this.#recordProjection(record));
			if (!next) return undefined;
			projected = next;
		}
		return additional ? addUsage(projected, additional) : projected;
	}

	#assertAdmission(request: AgentOperationBudgetReserveRequest): void {
		if (this.#exhausted) {
			throw new ChildOperationBudgetError(
				"budget_exhausted",
				"child operation budget is already exhausted",
			);
		}
		const uncertain = this.#uncertainRecord();
		if (uncertain) {
			throw new ChildOperationBudgetError(
				"uncertain_operation",
				`child operation ${uncertain.request.operationKey} is uncertain`,
			);
		}
		if (
			request.kind === "provider" &&
			this.#turnsInUse() >= this.#budget.maxTurns
		) {
			throw new ChildOperationBudgetError(
				"budget_exhausted",
				"child Agent maxTurns is exhausted",
			);
		}
		const projected = this.#projectedUsage(
			request.estimatedUpperBound,
		);
		if (!projected) {
			throw new ChildOperationBudgetError(
				"invalid_operation",
				"child operation estimated usage accumulation is unsafe",
			);
		}
		const exceeded = usageExceedsBudget(projected, this.#budget);
		if (exceeded.length > 0) {
			throw new ChildOperationBudgetError(
				"budget_exhausted",
				`child operation estimate exceeds ${exceeded.join(",")}`,
			);
		}
	}

	async #reserveRecord(
		record: ChildOperationRecord,
	): Promise<AgentOperationBudgetReservation> {
		try {
			const reservation = this.#delegate
				? await this.#delegate.reserve(cloneReserveRequest(record.request))
				: localReservation(record.request, this.#clock);
			if (
				!reservationIsValid(reservation) ||
				reservation.kind !== record.request.kind ||
				reservation.operationKey !== record.request.operationKey ||
				canonicalDigest(reservation.estimatedUpperBound) !==
					canonicalDigest(record.request.estimatedUpperBound)
			) {
				record.state = "reserve_uncertain";
				throw new ChildOperationBudgetError(
					"reservation_mismatch",
					"child operation delegate returned an uncorrelated reservation",
				);
			}
			record.reservation = cloneReservation(reservation);
			record.state = "reserved";
			return cloneReservation(reservation);
		} catch (error) {
			record.state = "reserve_uncertain";
			if (error instanceof ChildOperationBudgetError) throw error;
			throw new ChildOperationBudgetError(
				"delegate_unavailable",
				"child operation reservation delegate is unavailable",
				{ cause: error },
			);
		}
	}

	public reserve(
		request: AgentOperationBudgetReserveRequest,
	): Promise<AgentOperationBudgetReservation> {
		if (!requestIsValid(request)) {
			return Promise.reject(
				new ChildOperationBudgetError(
					"invalid_operation",
					"child operation reservation request is invalid",
				),
			);
		}
		const requestDigest = canonicalDigest(request);
		const existing = this.#records.get(request.operationKey);
		if (existing) {
			if (existing.requestDigest !== requestDigest) {
				return Promise.reject(
					new ChildOperationBudgetError(
						"idempotency_conflict",
						"child operation key was reused with another reservation request",
					),
				);
			}
			if (
				existing.state === "reserve_uncertain" &&
				this.#delegate
			) {
				existing.state = "reserving";
				existing.reservePromise = this.#reserveRecord(existing);
			}
			if (!existing.reservePromise) {
				return Promise.reject(
					new ChildOperationBudgetError(
						"uncertain_operation",
						"child operation reservation has no replayable result",
					),
				);
			}
			return existing.reservePromise.then(cloneReservation);
		}
		try {
			this.#assertAdmission(request);
		} catch (error) {
			return Promise.reject(error);
		}
		const record: ChildOperationRecord = {
			request: cloneReserveRequest(request),
			requestDigest,
			state: "reserving",
		};
		this.#records.set(request.operationKey, record);
		record.reservePromise = this.#reserveRecord(record);
		return record.reservePromise.then(cloneReservation);
	}

	async #reservationFor(
		record: ChildOperationRecord,
	): Promise<AgentOperationBudgetReservation> {
		if (record.reservation) return cloneReservation(record.reservation);
		if (!record.reservePromise) {
			throw new ChildOperationBudgetError(
				"reservation_mismatch",
				"child operation reservation is unavailable",
			);
		}
		return cloneReservation(await record.reservePromise);
	}

	#assertActualAggregate(
		record: ChildOperationRecord,
		actual: AgentOperationBudgetUsage,
	): {
		unsafe: boolean;
		exceeded: readonly BoundedUsageDimension[];
	} {
		let aggregate = zeroAgentOperationBudgetUsage();
		for (const candidate of this.#records.values()) {
			if (candidate === record || !candidate.actual) continue;
			if (
				candidate.state !== "committed" &&
				candidate.state !== "semantic_uncertain" &&
				candidate.state !== "accounting_uncertain"
			) {
				continue;
			}
			const next = addUsage(aggregate, candidate.actual);
			if (!next) return { unsafe: true, exceeded: [] };
			aggregate = next;
		}
		const next = addUsage(aggregate, actual);
		return next
			? {
					unsafe: false,
					exceeded: usageExceedsBudget(next, this.#budget),
				}
			: { unsafe: true, exceeded: [] };
	}

	#settlementConflict(
		record: ChildOperationRecord,
		kind: "commit" | "refund",
		digest: string,
	): ChildOperationBudgetError | undefined {
		if (
			record.settlementKind === undefined &&
			record.settlementDigest === undefined
		) {
			return undefined;
		}
		return record.settlementKind === kind &&
			record.settlementDigest === digest
			? undefined
			: new ChildOperationBudgetError(
					"idempotency_conflict",
					"child operation settlement conflicts with its durable identity",
				);
	}

	#repeatTerminal(record: ChildOperationRecord): Promise<void> {
		return record.terminalError
			? Promise.reject(record.terminalError)
			: Promise.resolve();
	}

	async #commitRecord(
		record: ChildOperationRecord,
		request: AgentOperationBudgetCommitRequest,
		aggregate: {
			unsafe: boolean;
			exceeded: readonly BoundedUsageDimension[];
		},
	): Promise<void> {
		try {
			await this.#delegate?.commit(cloneCommitRequest(request));
		} catch (error) {
			record.state = "settlement_uncertain";
			record.terminalError = new ChildOperationBudgetError(
				"delegate_unavailable",
				"child operation commit delegate is unavailable",
				{ cause: error },
			);
			throw record.terminalError;
		}
		record.actual = { ...request.actual };
		record.outcome = request.outcome;
		record.terminalError = undefined;
		if (request.outcome === "uncertain") {
			record.state = "semantic_uncertain";
			return;
		}
		if (aggregate.unsafe) {
			record.state = "accounting_uncertain";
			record.terminalError = new ChildOperationBudgetError(
				"invalid_operation",
				"child operation actual usage accumulation is unsafe",
			);
			throw record.terminalError;
		}
		record.state = "committed";
		if (aggregate.exceeded.length > 0) {
			this.#exhausted = true;
			record.terminalError = new ChildOperationBudgetError(
				"budget_exhausted",
				`child operation actual usage exceeds ${aggregate.exceeded.join(",")}`,
			);
			throw record.terminalError;
		}
	}

	public async commit(
		request: AgentOperationBudgetCommitRequest,
	): Promise<void> {
		if (!commitIsValid(request)) {
			throw new ChildOperationBudgetError(
				"invalid_operation",
				"child operation commit request is invalid",
			);
		}
		const record = this.#records.get(request.reservation.operationKey);
		if (!record) {
			throw new ChildOperationBudgetError(
				"reservation_mismatch",
				"child operation commit references an unknown reservation",
			);
		}
		const reservation = await this.#reservationFor(record);
		if (
			!reservationIsValid(request.reservation) ||
			!exactReservation(reservation, request.reservation)
		) {
			throw new ChildOperationBudgetError(
				"reservation_mismatch",
				"child operation commit reservation is stale or forged",
			);
		}
		const digest = canonicalDigest({
			kind: "commit",
			request,
		});
		const conflict = this.#settlementConflict(record, "commit", digest);
		if (conflict) throw conflict;
		if (
			record.state === "committed" ||
			record.state === "semantic_uncertain" ||
			record.state === "accounting_uncertain"
		) {
			return this.#repeatTerminal(record);
		}
		if (record.state === "committing") {
			return record.settlementPromise ?? Promise.reject(
				new ChildOperationBudgetError(
					"uncertain_operation",
					"child operation commit is missing its in-flight settlement",
				),
			);
		}
		if (
			record.state === "refunding" ||
			record.state === "refunded"
		) {
			throw new ChildOperationBudgetError(
				"idempotency_conflict",
				"child operation was already refunded",
			);
		}
		if (
			record.state !== "reserved" &&
			record.state !== "settlement_uncertain"
		) {
			throw new ChildOperationBudgetError(
				"uncertain_operation",
				"child operation cannot be committed from its current state",
			);
		}
		const aggregate = this.#assertActualAggregate(record, request.actual);
		record.actual = { ...request.actual };
		record.outcome = request.outcome;
		record.settlementKind = "commit";
		record.settlementDigest = digest;
		record.state = "committing";
		record.terminalError = undefined;
		record.settlementPromise = this.#commitRecord(
			record,
			cloneCommitRequest(request),
			aggregate,
		);
		return record.settlementPromise;
	}

	async #refundRecord(
		record: ChildOperationRecord,
		request: AgentOperationBudgetRefundRequest,
	): Promise<void> {
		try {
			await this.#delegate?.refund(cloneRefundRequest(request));
		} catch (error) {
			record.state = "settlement_uncertain";
			record.terminalError = new ChildOperationBudgetError(
				"delegate_unavailable",
				"child operation refund delegate is unavailable",
				{ cause: error },
			);
			throw record.terminalError;
		}
		record.state = "refunded";
		record.terminalError = undefined;
	}

	public async refund(
		request: AgentOperationBudgetRefundRequest,
	): Promise<void> {
		if (!refundIsValid(request)) {
			throw new ChildOperationBudgetError(
				"invalid_operation",
				"child operation refund request is invalid",
			);
		}
		const record = this.#records.get(request.reservation.operationKey);
		if (!record) {
			throw new ChildOperationBudgetError(
				"reservation_mismatch",
				"child operation refund references an unknown reservation",
			);
		}
		const reservation = await this.#reservationFor(record);
		if (
			!reservationIsValid(request.reservation) ||
			!exactReservation(reservation, request.reservation)
		) {
			throw new ChildOperationBudgetError(
				"reservation_mismatch",
				"child operation refund reservation is stale or forged",
			);
		}
		const digest = canonicalDigest({
			kind: "refund",
			request,
		});
		const conflict = this.#settlementConflict(record, "refund", digest);
		if (conflict) throw conflict;
		if (record.state === "refunded") return this.#repeatTerminal(record);
		if (record.state === "refunding") {
			return record.settlementPromise ?? Promise.reject(
				new ChildOperationBudgetError(
					"uncertain_operation",
					"child operation refund is missing its in-flight settlement",
				),
			);
		}
		if (
			record.state === "committing" ||
			record.state === "committed" ||
			record.state === "semantic_uncertain" ||
			record.state === "accounting_uncertain"
		) {
			throw new ChildOperationBudgetError(
				"idempotency_conflict",
				"child operation was already committed",
			);
		}
		if (
			record.state !== "reserved" &&
			record.state !== "settlement_uncertain"
		) {
			throw new ChildOperationBudgetError(
				"uncertain_operation",
				"child operation cannot be refunded from its current state",
			);
		}
		record.settlementKind = "refund";
		record.settlementDigest = digest;
		record.state = "refunding";
		record.terminalError = undefined;
		record.settlementPromise = this.#refundRecord(
			record,
			cloneRefundRequest(request),
		);
		return record.settlementPromise;
	}

	public async usage(): Promise<AgentResult<AgentBudgetUsage>> {
		const unsettled = [...this.#records.values()].find(
			(record) =>
				record.state !== "committed" &&
				record.state !== "refunded",
		);
		if (unsettled) {
			return usageResultFailure(
				`child operation ${unsettled.request.operationKey} is live, uncertain, or unsettled`,
			);
		}
		let aggregate = zeroAgentOperationBudgetUsage();
		for (const record of this.#records.values()) {
			if (record.state !== "committed" || !record.actual) continue;
			const next = addUsage(aggregate, record.actual);
			if (!next) {
				return usageResultFailure(
					"child operation usage accumulation is unsafe",
				);
			}
			aggregate = next;
		}
		return {
			ok: true,
			value: {
				inputTokens: aggregate.inputTokens,
				outputTokens: aggregate.outputTokens,
				usdMicros: aggregate.usdMicros,
				wallTimeMs: aggregate.wallTimeMs,
				toolCalls: aggregate.toolCalls,
				networkBytes: aggregate.networkBytes,
				storageBytes: aggregate.storageBytes,
				artifactCount: aggregate.artifactCount,
				verifications: aggregate.verifications,
			},
		};
	}
}
