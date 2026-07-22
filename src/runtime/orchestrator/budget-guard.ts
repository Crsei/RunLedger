/** 全维度 root BudgetGuard：先 reserve，后 commit/refund，并支持延迟 reconciliation。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import {
	createRuntimeId,
	type BudgetReservationId,
	type CommandId,
	type GoalId,
} from "../protocol/v3/ids.ts";
import type {
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	OrchestratorResult,
} from "./types.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";

export const BUDGET_DIMENSIONS = [
	"inputTokens",
	"outputTokens",
	"usdMicros",
	"wallTimeMs",
	"toolCalls",
	"retries",
	"networkBytes",
	"storageBytes",
	"artifactCount",
	"verifications",
	"activeAgents",
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];
export type BudgetVector = Readonly<Record<BudgetDimension, number>>;

export interface BudgetThreshold {
	soft: number;
	hard: number;
}

export type BudgetLimits = Readonly<Record<BudgetDimension, BudgetThreshold>>;

export interface BudgetEstimationPolicy {
	tokenAllowedErrorBps: number;
	usdAllowedErrorBps: number;
}

export interface BudgetReservation {
	reservationId: BudgetReservationId;
	operationId: CommandId;
	estimatedUpperBound: BudgetVector;
	reservedAt: string;
	status: "reserved" | "committed" | "refunded";
	actual?: BudgetVector;
}

export interface BudgetHardStop {
	dimensions: readonly BudgetDimension[];
	reason: "reservation_exceeded" | "threshold_reached" | "reconciliation_overage";
	partialResults: readonly ArtifactRef[];
	stoppedAt: string;
}

export interface BudgetSnapshot {
	goalId: GoalId;
	revision: number;
	committed: BudgetVector;
	reserved: BudgetVector;
	reservations: readonly BudgetReservation[];
	softReminders: readonly BudgetDimension[];
	hardStop?: BudgetHardStop;
}

export interface BudgetReserveRequest {
	reservationId: BudgetReservationId;
	operationId: CommandId;
	idempotencyKey: IdempotencyKey;
	estimatedUpperBound: BudgetVector;
	partialResults?: readonly ArtifactRef[];
}

export type BudgetReserveOutcome =
	| { status: "granted"; reservation: BudgetReservation; snapshot: BudgetSnapshot }
	| { status: "denied"; exceeded: readonly BudgetDimension[]; snapshot: BudgetSnapshot };

export interface BudgetCommitRequest {
	reservationId: BudgetReservationId;
	idempotencyKey: IdempotencyKey;
	actual: BudgetVector;
	partialResults?: readonly ArtifactRef[];
}

export interface BudgetRefundRequest {
	reservationId: BudgetReservationId;
	idempotencyKey: IdempotencyKey;
	reason: "cancelled" | "not_started";
}

export interface BudgetReconcileRequest {
	reservationId: BudgetReservationId;
	idempotencyKey: IdempotencyKey;
	correctedActual: BudgetVector;
	partialResults?: readonly ArtifactRef[];
}

export type BudgetJournalRecord =
	| {
			kind: "budget.reserved";
			goalId: GoalId;
			reservationId: BudgetReservationId;
			operationId: CommandId;
			estimatedUpperBound: BudgetVector;
			reservedAt: string;
	  }
	| {
			kind: "budget.committed";
			goalId: GoalId;
			reservationId: BudgetReservationId;
			actual: BudgetVector;
			committedAt: string;
	  }
	| {
			kind: "budget.refunded";
			goalId: GoalId;
			reservationId: BudgetReservationId;
			amount: BudgetVector;
			reason: "unused_reservation" | "cancelled" | "not_started";
			refundedAt: string;
	  }
	| {
			kind: "budget.reconciled";
			goalId: GoalId;
			reservationId: BudgetReservationId;
			previousActual: BudgetVector;
			correctedActual: BudgetVector;
			delta: Readonly<Record<BudgetDimension, number>>;
			tokenErrorBps: number;
			usdErrorBps: number;
			withinAllowedError: boolean;
			reconciledAt: string;
	  }
	| {
			kind: "budget.soft_threshold";
			goalId: GoalId;
			dimensions: readonly BudgetDimension[];
			observed: BudgetVector;
			remindedAt: string;
	  }
	| {
			kind: "budget.reservation_denied";
			goalId: GoalId;
			reservationId: BudgetReservationId;
			operationId: CommandId;
			estimatedUpperBound: BudgetVector;
			dimensions: readonly BudgetDimension[];
			reason: "concurrency_limit" | "hard_limit";
			deniedAt: string;
	  }
	| {
			kind: "budget.hard_stopped";
			goalId: GoalId;
			dimensions: readonly BudgetDimension[];
			reason: BudgetHardStop["reason"];
			partialResults: readonly ArtifactRef[];
			stoppedAt: string;
	  };

export interface BudgetGuardOptions {
	goalId: GoalId;
	limits: BudgetLimits;
	journal: DurableOrchestratorJournalPort<BudgetJournalRecord>;
	estimationPolicy?: BudgetEstimationPolicy;
	clock?: () => Date;
}

const DEFAULT_ESTIMATION_POLICY: BudgetEstimationPolicy = {
	tokenAllowedErrorBps: 500,
	usdAllowedErrorBps: 500,
};

export function zeroBudgetVector(): BudgetVector {
	return {
		inputTokens: 0,
		outputTokens: 0,
		usdMicros: 0,
		wallTimeMs: 0,
		toolCalls: 0,
		retries: 0,
		networkBytes: 0,
		storageBytes: 0,
		artifactCount: 0,
		verifications: 0,
		activeAgents: 0,
	};
}

export function createBudgetVector(values: Partial<Record<BudgetDimension, number>> = {}): BudgetVector {
	const vector = { ...zeroBudgetVector() };
	for (const dimension of BUDGET_DIMENSIONS) vector[dimension] = values[dimension] ?? 0;
	return vector;
}

function add(left: BudgetVector, right: BudgetVector): BudgetVector {
	const result = { ...zeroBudgetVector() };
	for (const dimension of BUDGET_DIMENSIONS) result[dimension] = left[dimension] + right[dimension];
	return result;
}

function subtract(left: BudgetVector, right: BudgetVector): BudgetVector {
	const result = { ...zeroBudgetVector() };
	for (const dimension of BUDGET_DIMENSIONS) result[dimension] = left[dimension] - right[dimension];
	return result;
}

function vectorIsValid(vector: BudgetVector): boolean {
	return BUDGET_DIMENSIONS.every(
		(dimension) => Number.isSafeInteger(vector[dimension]) && vector[dimension] >= 0,
	);
}

function vectorHasWork(vector: BudgetVector): boolean {
	return BUDGET_DIMENSIONS.some((dimension) => vector[dimension] > 0);
}

function vectorsEqual(left: BudgetVector, right: BudgetVector): boolean {
	return BUDGET_DIMENSIONS.every((dimension) => left[dimension] === right[dimension]);
}

function vectorDelta(previous: BudgetVector, corrected: BudgetVector): Readonly<Record<BudgetDimension, number>> {
	const delta = { ...zeroBudgetVector() };
	for (const dimension of BUDGET_DIMENSIONS) delta[dimension] = corrected[dimension] - previous[dimension];
	return delta;
}

function limitsAreValid(limits: BudgetLimits): boolean {
	return BUDGET_DIMENSIONS.every((dimension) => {
		const threshold = limits[dimension];
		return (
			Number.isSafeInteger(threshold.soft) &&
			Number.isSafeInteger(threshold.hard) &&
			threshold.soft >= 0 &&
			threshold.hard >= threshold.soft
		);
	});
}

function errorBps(estimate: number, actual: number): number {
	if (estimate === 0) return actual === 0 ? 0 : 1_000_000;
	return Math.floor((Math.abs(actual - estimate) * 10_000) / estimate);
}

function providerTokenTotal(vector: BudgetVector): number {
	return vector.inputTokens + vector.outputTokens;
}

function cloneReservation(reservation: BudgetReservation): BudgetReservation {
	return {
		...reservation,
		estimatedUpperBound: { ...reservation.estimatedUpperBound },
		actual: reservation.actual ? { ...reservation.actual } : undefined,
	};
}

function cloneHardStop(stop: BudgetHardStop): BudgetHardStop {
	return { ...stop, dimensions: [...stop.dimensions], partialResults: [...stop.partialResults] };
}

function snapshotFromProjection(projection: BudgetProjection): BudgetSnapshot {
	return {
		goalId: projection.goalId,
		revision: projection.revision,
		committed: { ...projection.committed },
		reserved: { ...projection.reserved },
		reservations: [...projection.reservations.values()].map(cloneReservation),
		softReminders: [...projection.softReminders].sort(),
		hardStop: projection.hardStop ? cloneHardStop(projection.hardStop) : undefined,
	};
}

interface BudgetProjection {
	goalId: GoalId;
	revision: number;
	committed: BudgetVector;
	reserved: BudgetVector;
	reservations: Map<BudgetReservationId, BudgetReservation>;
	softReminders: Set<BudgetDimension>;
	hardStop?: BudgetHardStop;
}

function invalidJournal(message: string): OrchestratorResult<never> {
	return { ok: false, error: { code: "invalid_input", message, retryable: false } };
}

function reduceBudget(
	goalId: GoalId,
	snapshot: DurableJournalSnapshot<BudgetJournalRecord>,
): OrchestratorResult<BudgetProjection> {
	const projection: BudgetProjection = {
		goalId,
		revision: snapshot.revision,
		committed: zeroBudgetVector(),
		reserved: zeroBudgetVector(),
		reservations: new Map(),
		softReminders: new Set(),
	};
	for (const transaction of snapshot.transactions) {
		for (const record of transaction.records) {
			if (record.goalId !== goalId) return invalidJournal("budget journal contains a foreign goal");
			if (record.kind === "budget.reserved") {
				if (projection.reservations.has(record.reservationId) || !vectorIsValid(record.estimatedUpperBound)) {
					return invalidJournal("budget reservation record is invalid");
				}
				projection.reservations.set(record.reservationId, {
					reservationId: record.reservationId,
					operationId: record.operationId,
					estimatedUpperBound: { ...record.estimatedUpperBound },
					reservedAt: record.reservedAt,
					status: "reserved",
				});
				projection.reserved = add(projection.reserved, record.estimatedUpperBound);
			} else if (record.kind === "budget.committed") {
				const reservation = projection.reservations.get(record.reservationId);
				if (!reservation || reservation.status !== "reserved" || !vectorIsValid(record.actual)) {
					return invalidJournal("budget commit does not match a live reservation");
				}
				projection.reserved = subtract(projection.reserved, reservation.estimatedUpperBound);
				projection.committed = add(projection.committed, record.actual);
				reservation.status = "committed";
				reservation.actual = { ...record.actual };
			} else if (record.kind === "budget.refunded") {
				const reservation = projection.reservations.get(record.reservationId);
				if (!reservation || !vectorIsValid(record.amount)) return invalidJournal("budget refund is invalid");
				if (record.reason === "cancelled" || record.reason === "not_started") {
					if (reservation.status !== "reserved") return invalidJournal("cancel refund requires a live reservation");
					projection.reserved = subtract(projection.reserved, reservation.estimatedUpperBound);
					reservation.status = "refunded";
				} else if (reservation.status !== "committed") {
					return invalidJournal("unused reservation refund requires a committed reservation");
				}
			} else if (record.kind === "budget.reconciled") {
				const reservation = projection.reservations.get(record.reservationId);
				if (!reservation?.actual || reservation.status !== "committed" || !vectorIsValid(record.correctedActual)) {
					return invalidJournal("budget reconciliation requires a committed reservation");
				}
				if (canonicalDigest(reservation.actual) !== canonicalDigest(record.previousActual)) {
					return invalidJournal("budget reconciliation previous usage mismatch");
				}
				projection.committed = add(projection.committed, vectorDelta(record.previousActual, record.correctedActual));
				reservation.actual = { ...record.correctedActual };
			} else if (record.kind === "budget.soft_threshold") {
				for (const dimension of record.dimensions) projection.softReminders.add(dimension);
			} else if (record.kind === "budget.reservation_denied") {
				// Denial is audit evidence; it does not consume or permanently stop a gauge budget.
				if (!vectorIsValid(record.estimatedUpperBound) || record.dimensions.length === 0) {
					return invalidJournal("budget denial record is invalid");
				}
			} else {
				if (projection.hardStop) return invalidJournal("budget journal contains multiple hard-stop records");
				projection.hardStop = {
					dimensions: [...record.dimensions],
					reason: record.reason,
					partialResults: [...record.partialResults],
					stoppedAt: record.stoppedAt,
				};
			}
		}
	}
	if (!vectorIsValid(projection.committed) || !vectorIsValid(projection.reserved)) {
		return invalidJournal("budget journal reduced to negative or unsafe usage");
	}
	return { ok: true, value: projection };
}

/** canonical event adapter、snapshot 与 live guard 共享同一 reducer，禁止维护第二套预算算法。 */
export function projectBudgetSnapshotFromJournal(
	goalId: GoalId,
	snapshot: DurableJournalSnapshot<BudgetJournalRecord>,
): OrchestratorResult<BudgetSnapshot> {
	const projection = reduceBudget(goalId, snapshot);
	return projection.ok ? { ok: true, value: snapshotFromProjection(projection.value) } : projection;
}

export class BudgetGuard {
	private readonly goalId: GoalId;
	private readonly limits: BudgetLimits;
	private readonly journal: DurableOrchestratorJournalPort<BudgetJournalRecord>;
	private readonly estimationPolicy: BudgetEstimationPolicy;
	private readonly clock: () => Date;
	private serial: Promise<void> = Promise.resolve();

	public constructor(options: BudgetGuardOptions) {
		this.goalId = options.goalId;
		this.limits = options.limits;
		this.journal = options.journal;
		this.estimationPolicy = options.estimationPolicy ?? DEFAULT_ESTIMATION_POLICY;
		this.clock = options.clock ?? (() => new Date());
	}

	private exclusive<T>(operation: () => Promise<OrchestratorResult<T>>): Promise<OrchestratorResult<T>> {
		const result = this.serial.then(operation);
		this.serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async load(): Promise<OrchestratorResult<BudgetProjection>> {
		if (!limitsAreValid(this.limits)) {
			return {
				ok: false,
				error: { code: "invalid_input", message: "budget limits are invalid", retryable: false },
			};
		}
		const loaded = await this.journal.load();
		if (!loaded.ok) return loaded;
		return reduceBudget(this.goalId, loaded.value);
	}

	private async append(
		projection: BudgetProjection,
		idempotencyKey: IdempotencyKey,
		records: readonly BudgetJournalRecord[],
	): Promise<OrchestratorResult<"committed" | "duplicate" | "conflict">> {
		const transaction: DurableJournalTransaction<BudgetJournalRecord> = {
			transactionId: createRuntimeId("command"),
			idempotencyKey,
			transactionDigest: canonicalDigest(records),
			committedAt: this.clock().toISOString(),
			records,
		};
		const appended = await this.journal.append(projection.revision, transaction);
		if (!appended.ok) return appended;
		return { ok: true, value: appended.value.status === "conflict" ? "conflict" : appended.value.status };
	}

	private previousTransaction(
		snapshot: DurableJournalSnapshot<BudgetJournalRecord>,
		idempotencyKey: IdempotencyKey,
	): DurableJournalTransaction<BudgetJournalRecord> | undefined {
		return snapshot.transactions.find((transaction) => transaction.idempotencyKey === idempotencyKey);
	}

	private async rawSnapshot(): Promise<OrchestratorResult<DurableJournalSnapshot<BudgetJournalRecord>>> {
		return this.journal.load();
	}

	public snapshot(): Promise<OrchestratorResult<BudgetSnapshot>> {
		return this.exclusive(async () => {
			const projection = await this.load();
			return projection.ok ? { ok: true, value: snapshotFromProjection(projection.value) } : projection;
		});
	}

	public reserve(request: BudgetReserveRequest): Promise<OrchestratorResult<BudgetReserveOutcome>> {
		return this.exclusive<BudgetReserveOutcome>(async () => {
			if (!vectorIsValid(request.estimatedUpperBound) || !vectorHasWork(request.estimatedUpperBound)) {
				return {
					ok: false,
					error: { code: "invalid_input", message: "reservation estimate must be non-negative work", retryable: false },
				};
			}
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const raw = await this.rawSnapshot();
				if (!raw.ok) return raw;
				const previous = this.previousTransaction(raw.value, request.idempotencyKey);
				const projectionResult = reduceBudget(this.goalId, raw.value);
				if (!projectionResult.ok) return projectionResult;
				const projection = projectionResult.value;
				if (previous) {
					const record = previous.records.find(
						(entry): entry is Extract<BudgetJournalRecord, { kind: "budget.reserved" }> =>
							entry.kind === "budget.reserved" && entry.reservationId === request.reservationId,
					);
					if (!record) {
						const denied = previous.records.find((entry) => entry.kind === "budget.reservation_denied");
						if (
							denied &&
							denied.reservationId === request.reservationId &&
							denied.operationId === request.operationId &&
							vectorsEqual(denied.estimatedUpperBound, request.estimatedUpperBound)
						) {
							return {
								ok: true,
								value: { status: "denied", exceeded: denied.dimensions, snapshot: snapshotFromProjection(projection) },
							};
						}
						return {
							ok: false,
							error: { code: "idempotency_conflict", message: "idempotency key belongs to another action", retryable: false },
						};
					}
					if (record.operationId !== request.operationId || !vectorsEqual(record.estimatedUpperBound, request.estimatedUpperBound)) {
						return { ok: false, error: { code: "idempotency_conflict", message: "reservation key was reused", retryable: false } };
					}
					const reservation = projection.reservations.get(request.reservationId);
					if (!reservation) return invalidJournal("reserved transaction is not replayable");
					return {
						ok: true,
						value: { status: "granted", reservation: cloneReservation(reservation), snapshot: snapshotFromProjection(projection) },
					};
				}
				if (projection.hardStop) {
					return {
						ok: true,
						value: {
							status: "denied",
							exceeded: projection.hardStop.dimensions,
							snapshot: snapshotFromProjection(projection),
						},
					};
				}
				if (projection.reservations.has(request.reservationId)) {
					return {
						ok: false,
						error: { code: "idempotency_conflict", message: "reservationId already exists", retryable: false },
					};
				}
				const projected = add(add(projection.committed, projection.reserved), request.estimatedUpperBound);
				if (!vectorIsValid(projected)) {
					return { ok: false, error: { code: "invalid_input", message: "projected budget is unsafe", retryable: false } };
				}
				const exceeded = BUDGET_DIMENSIONS.filter(
					(dimension) => request.estimatedUpperBound[dimension] > 0 && projected[dimension] > this.limits[dimension].hard,
				);
				const reached = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						dimension !== "activeAgents" &&
						request.estimatedUpperBound[dimension] > 0 &&
						projected[dimension] >= this.limits[dimension].hard,
				);
				const soft = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						request.estimatedUpperBound[dimension] > 0 &&
						projected[dimension] >= this.limits[dimension].soft &&
						!projection.softReminders.has(dimension),
				);
				const now = this.clock().toISOString();
				const records: BudgetJournalRecord[] = [];
				if (exceeded.length === 0) {
					records.push({
						kind: "budget.reserved",
						goalId: this.goalId,
						reservationId: request.reservationId,
						operationId: request.operationId,
						estimatedUpperBound: { ...request.estimatedUpperBound },
						reservedAt: now,
					});
					if (soft.length > 0) {
						records.push({
							kind: "budget.soft_threshold",
							goalId: this.goalId,
							dimensions: soft,
							observed: projected,
							remindedAt: now,
						});
					}
				}
				if (exceeded.length > 0) {
					records.push({
						kind: "budget.reservation_denied",
						goalId: this.goalId,
						reservationId: request.reservationId,
						operationId: request.operationId,
						estimatedUpperBound: { ...request.estimatedUpperBound },
						dimensions: exceeded,
						reason: exceeded.every((dimension) => dimension === "activeAgents") ? "concurrency_limit" : "hard_limit",
						deniedAt: now,
					});
				}
				const terminalExceeded = exceeded.filter((dimension) => dimension !== "activeAgents");
				const hardDimensions = terminalExceeded.length > 0 ? terminalExceeded : reached;
				if (hardDimensions.length > 0) {
					records.push({
						kind: "budget.hard_stopped",
						goalId: this.goalId,
						dimensions: hardDimensions,
						reason: exceeded.length > 0 ? "reservation_exceeded" : "threshold_reached",
						partialResults: [...(request.partialResults ?? [])],
						stoppedAt: now,
					});
				}
				const appended = await this.append(projection, request.idempotencyKey, records);
				if (!appended.ok) return appended;
				if (appended.value === "conflict") continue;
				const updated = await this.load();
				if (!updated.ok) return updated;
				if (exceeded.length > 0) {
					return {
						ok: true,
						value: { status: "denied", exceeded, snapshot: snapshotFromProjection(updated.value) },
					};
				}
				const reservation = updated.value.reservations.get(request.reservationId);
				if (!reservation) return invalidJournal("committed reservation is missing");
				return {
					ok: true,
					value: { status: "granted", reservation: cloneReservation(reservation), snapshot: snapshotFromProjection(updated.value) },
				};
			}
			return {
				ok: false,
				error: { code: "journal_conflict", message: "budget reservation CAS did not converge", retryable: true },
			};
		});
	}

	public commit(request: BudgetCommitRequest): Promise<OrchestratorResult<BudgetSnapshot>> {
		return this.exclusive(async () => {
			if (!vectorIsValid(request.actual) || request.actual.activeAgents !== 0) {
				return { ok: false, error: { code: "invalid_input", message: "actual usage is invalid", retryable: false } };
			}
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const raw = await this.rawSnapshot();
				if (!raw.ok) return raw;
				const projectionResult = reduceBudget(this.goalId, raw.value);
				if (!projectionResult.ok) return projectionResult;
				const projection = projectionResult.value;
				const previous = this.previousTransaction(raw.value, request.idempotencyKey);
				if (previous) {
					const record = previous.records.find(
						(entry): entry is Extract<BudgetJournalRecord, { kind: "budget.committed" }> =>
							entry.kind === "budget.committed",
					);
					return record && record.reservationId === request.reservationId && vectorsEqual(record.actual, request.actual)
						? { ok: true, value: snapshotFromProjection(projection) }
						: { ok: false, error: { code: "idempotency_conflict", message: "commit key was reused", retryable: false } };
				}
				const reservation = projection.reservations.get(request.reservationId);
				if (!reservation) {
					return { ok: false, error: { code: "reservation_not_found", message: "reservation was not found", retryable: false } };
				}
				if (reservation.status !== "reserved") {
					return { ok: false, error: { code: "reservation_settled", message: "reservation is already settled", retryable: false } };
				}
				const now = this.clock().toISOString();
				const unused = { ...zeroBudgetVector() };
				for (const dimension of BUDGET_DIMENSIONS) {
					unused[dimension] = Math.max(0, reservation.estimatedUpperBound[dimension] - request.actual[dimension]);
				}
				const records: BudgetJournalRecord[] = [
					{
						kind: "budget.committed",
						goalId: this.goalId,
						reservationId: request.reservationId,
						actual: { ...request.actual },
						committedAt: now,
					},
				];
				if (vectorHasWork(unused)) {
					records.push({
						kind: "budget.refunded",
						goalId: this.goalId,
						reservationId: request.reservationId,
						amount: unused,
						reason: "unused_reservation",
						refundedAt: now,
					});
				}
				const otherReserved = subtract(projection.reserved, reservation.estimatedUpperBound);
				const projected = add(add(projection.committed, request.actual), otherReserved);
				if (!vectorIsValid(projected)) {
					return { ok: false, error: { code: "invalid_input", message: "committed budget would be unsafe", retryable: false } };
				}
				const soft = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						projected[dimension] > 0 &&
						projected[dimension] >= this.limits[dimension].soft &&
						!projection.softReminders.has(dimension),
				);
				if (soft.length > 0) {
					records.push({
						kind: "budget.soft_threshold",
						goalId: this.goalId,
						dimensions: soft,
						observed: projected,
						remindedAt: now,
					});
				}
				const overage = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						dimension !== "activeAgents" &&
						projected[dimension] >= this.limits[dimension].hard &&
						request.actual[dimension] > 0,
				);
				if (overage.length > 0 && !projection.hardStop) {
					records.push({
						kind: "budget.hard_stopped",
						goalId: this.goalId,
						dimensions: overage,
						reason: "reconciliation_overage",
						partialResults: [...(request.partialResults ?? [])],
						stoppedAt: now,
					});
				}
				const appended = await this.append(projection, request.idempotencyKey, records);
				if (!appended.ok) return appended;
				if (appended.value === "conflict") continue;
				const updated = await this.load();
				return updated.ok ? { ok: true, value: snapshotFromProjection(updated.value) } : updated;
			}
			return { ok: false, error: { code: "journal_conflict", message: "budget commit CAS did not converge", retryable: true } };
		});
	}

	public refund(request: BudgetRefundRequest): Promise<OrchestratorResult<BudgetSnapshot>> {
		return this.exclusive(async () => {
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const raw = await this.rawSnapshot();
				if (!raw.ok) return raw;
				const projectionResult = reduceBudget(this.goalId, raw.value);
				if (!projectionResult.ok) return projectionResult;
				const projection = projectionResult.value;
				const previous = this.previousTransaction(raw.value, request.idempotencyKey);
				if (previous) {
					const record = previous.records.find(
						(entry): entry is Extract<BudgetJournalRecord, { kind: "budget.refunded" }> =>
							entry.kind === "budget.refunded" && entry.reason !== "unused_reservation",
					);
					return record && record.reservationId === request.reservationId && record.reason === request.reason
						? { ok: true, value: snapshotFromProjection(projection) }
						: { ok: false, error: { code: "idempotency_conflict", message: "refund key was reused", retryable: false } };
				}
				const reservation = projection.reservations.get(request.reservationId);
				if (!reservation) return { ok: false, error: { code: "reservation_not_found", message: "reservation was not found", retryable: false } };
				if (reservation.status !== "reserved") return { ok: false, error: { code: "reservation_settled", message: "reservation is already settled", retryable: false } };
				const appended = await this.append(projection, request.idempotencyKey, [
					{
						kind: "budget.refunded",
						goalId: this.goalId,
						reservationId: request.reservationId,
						amount: { ...reservation.estimatedUpperBound },
						reason: request.reason,
						refundedAt: this.clock().toISOString(),
					},
				]);
				if (!appended.ok) return appended;
				if (appended.value === "conflict") continue;
				const updated = await this.load();
				return updated.ok ? { ok: true, value: snapshotFromProjection(updated.value) } : updated;
			}
			return { ok: false, error: { code: "journal_conflict", message: "budget refund CAS did not converge", retryable: true } };
		});
	}

	public reconcile(request: BudgetReconcileRequest): Promise<OrchestratorResult<BudgetSnapshot>> {
		return this.exclusive(async () => {
			if (!vectorIsValid(request.correctedActual) || request.correctedActual.activeAgents !== 0) {
				return { ok: false, error: { code: "invalid_input", message: "corrected usage is invalid", retryable: false } };
			}
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const raw = await this.rawSnapshot();
				if (!raw.ok) return raw;
				const projectionResult = reduceBudget(this.goalId, raw.value);
				if (!projectionResult.ok) return projectionResult;
				const projection = projectionResult.value;
				const previous = this.previousTransaction(raw.value, request.idempotencyKey);
				if (previous) {
					const record = previous.records.find(
						(entry): entry is Extract<BudgetJournalRecord, { kind: "budget.reconciled" }> =>
							entry.kind === "budget.reconciled",
					);
					return record &&
						record.reservationId === request.reservationId &&
						vectorsEqual(record.correctedActual, request.correctedActual)
						? { ok: true, value: snapshotFromProjection(projection) }
						: { ok: false, error: { code: "idempotency_conflict", message: "reconcile key was reused", retryable: false } };
				}
				const reservation = projection.reservations.get(request.reservationId);
				if (!reservation?.actual || reservation.status !== "committed") {
					return { ok: false, error: { code: "reservation_not_found", message: "committed reservation was not found", retryable: false } };
				}
				const tokenError = errorBps(
					providerTokenTotal(reservation.estimatedUpperBound),
					providerTokenTotal(request.correctedActual),
				);
				const usdError = errorBps(reservation.estimatedUpperBound.usdMicros, request.correctedActual.usdMicros);
				const now = this.clock().toISOString();
				const records: BudgetJournalRecord[] = [
					{
						kind: "budget.reconciled",
						goalId: this.goalId,
						reservationId: request.reservationId,
						previousActual: { ...reservation.actual },
						correctedActual: { ...request.correctedActual },
						delta: vectorDelta(reservation.actual, request.correctedActual),
						tokenErrorBps: tokenError,
						usdErrorBps: usdError,
						withinAllowedError:
							tokenError <= this.estimationPolicy.tokenAllowedErrorBps &&
							usdError <= this.estimationPolicy.usdAllowedErrorBps,
						reconciledAt: now,
					},
				];
				const projected = add(add(subtract(projection.committed, reservation.actual), request.correctedActual), projection.reserved);
				if (!vectorIsValid(projected)) {
					return { ok: false, error: { code: "invalid_input", message: "reconciled budget would be unsafe", retryable: false } };
				}
				const soft = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						projected[dimension] > 0 &&
						projected[dimension] >= this.limits[dimension].soft &&
						!projection.softReminders.has(dimension),
				);
				if (soft.length > 0) {
					records.push({
						kind: "budget.soft_threshold",
						goalId: this.goalId,
						dimensions: soft,
						observed: projected,
						remindedAt: now,
					});
				}
				const hard = BUDGET_DIMENSIONS.filter(
					(dimension) =>
						dimension !== "activeAgents" &&
						projected[dimension] >= this.limits[dimension].hard &&
						request.correctedActual[dimension] > 0,
				);
				if (hard.length > 0 && !projection.hardStop) {
					records.push({
						kind: "budget.hard_stopped",
						goalId: this.goalId,
						dimensions: hard,
						reason: "reconciliation_overage",
						partialResults: [...(request.partialResults ?? [])],
						stoppedAt: now,
					});
				}
				const appended = await this.append(projection, request.idempotencyKey, records);
				if (!appended.ok) return appended;
				if (appended.value === "conflict") continue;
				const updated = await this.load();
				return updated.ok ? { ok: true, value: snapshotFromProjection(updated.value) } : updated;
			}
			return { ok: false, error: { code: "journal_conflict", message: "budget reconcile CAS did not converge", retryable: true } };
		});
	}
}

export function createBudgetReservationId(): BudgetReservationId {
	return createRuntimeId("budgetReservation");
}
