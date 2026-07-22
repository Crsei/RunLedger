/** Goal/Budget 对 Session v3 exact events 的 durable journal adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { sameRuntimeEventStream, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type GoalId,
	type PrincipalId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import {
	BUDGET_DIMENSIONS,
	type BudgetJournalRecord,
	type BudgetLimits,
} from "./budget-guard.ts";
import type { GoalJournalRecord } from "./goal-state-machine.ts";
import type {
	DurableJournalAppendOutcome,
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	GoalState,
	OrchestratorResult,
} from "./types.ts";

export interface SessionCanonicalJournalOptions {
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	traceIdFactory?: () => TraceId;
}

export interface SessionCanonicalBudgetJournalOptions extends SessionCanonicalJournalOptions {
	goalId: GoalId;
	limits: BudgetLimits;
}

export interface CanonicalBudgetTruth {
	goalId: GoalId | null;
	limits: BudgetLimits | null;
	limitsDigest: string | null;
	journal: DurableJournalSnapshot<BudgetJournalRecord>;
}

interface JournalReplayIdentity {
	revision: number;
	transactionIds: Set<string>;
	idempotencyKeys: Set<string>;
}

const WRITER_QUEUES = new WeakMap<EventWriter, Promise<void>>();

function serializeWriter<T>(writer: EventWriter, operation: () => Promise<T>): Promise<T> {
	const previous = WRITER_QUEUES.get(writer) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	WRITER_QUEUES.set(
		writer,
		result.then(
			() => undefined,
			() => undefined,
		),
	);
	return result;
}

function invalid<T>(message: string): OrchestratorResult<T> {
	return { ok: false, error: { code: "invalid_input", message, retryable: false } };
}

function unavailable<T>(message: string, retryable = false): OrchestratorResult<T> {
	return { ok: false, error: { code: "journal_unavailable", message, retryable } };
}

function isCanonicalTimestamp(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

export async function readVerifiedCanonicalEvents(store: RuntimeEventStore): Promise<OrchestratorResult<readonly RuntimeEventV3[]>> {
	let verified;
	try {
		verified = await store.verify(store.streamRef());
	} catch {
		return unavailable("canonical orchestrator Event Store verification failed");
	}
	if (!verified.ok) return unavailable("canonical orchestrator Event Store verification failed", verified.error.retryable);
	if (verified.value.integrity !== "valid") return invalid("canonical orchestrator event chain is not complete and valid");
	const events: RuntimeEventV3[] = [];
	let afterSequence: number | undefined;
	for (;;) {
		let page;
		try {
			page = await store.readPage(store.streamRef(), {
				...(afterSequence === undefined ? {} : { afterSequence }),
				limit: 1_000,
			});
		} catch {
			return unavailable("canonical orchestrator event replay failed");
		}
		if (!page.ok) return unavailable("canonical orchestrator event replay failed", page.error.retryable);
		for (const event of page.value.events) {
			const validated = validateRuntimeEvent(event);
			if (!validated.ok) return invalid("canonical orchestrator replay contains an invalid event");
			events.push(validated.value);
		}
		if (!page.value.hasMore) break;
		const last = page.value.events.at(-1);
		if (!last) return invalid("canonical orchestrator replay page did not advance");
		afterSequence = last.sequence;
	}
	const first = events[0];
	if (!first) return verified.value.eventCount === 0
		? { ok: true, value: [] }
		: invalid("canonical orchestrator verification and replay disagree");
	const chain = verifyRuntimeEventChain(events, {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
	});
	if (
		chain.integrity !== "valid" ||
		verified.value.authorityId !== first.authorityId ||
		verified.value.tenantId !== first.tenantId ||
		!sameRuntimeEventStream(verified.value.stream, first.stream)
	) return invalid("canonical orchestrator event replay failed chain verification");
	return { ok: true, value: events };
}

function replayIdentity(
	state: JournalReplayIdentity,
	input: {
		journalRevision: number;
		transactionId: string;
		idempotencyKey: string;
	},
): OrchestratorResult<{ transactionId: DurableJournalTransaction<never>["transactionId"]; idempotencyKey: DurableJournalTransaction<never>["idempotencyKey"] }> {
	const transactionId = parseRuntimeId("command", input.transactionId);
	const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
	if (!transactionId || !idempotencyKey) return invalid("canonical orchestrator transaction identity is invalid");
	if (input.journalRevision !== state.revision + 1) return invalid("canonical orchestrator journal revision is discontinuous");
	if (state.transactionIds.has(transactionId)) return invalid("canonical orchestrator transactionId is duplicated");
	if (state.idempotencyKeys.has(idempotencyKey)) return invalid("canonical orchestrator idempotency key is duplicated");
	state.revision = input.journalRevision;
	state.transactionIds.add(transactionId);
	state.idempotencyKeys.add(idempotencyKey);
	return { ok: true, value: { transactionId, idempotencyKey } };
}

function legacyJournalExists(events: readonly RuntimeEventV3[], journalKind: "goal" | "budget"): boolean {
	return events.some(
		(event) => event.type === "orchestrator.journal_committed" && event.payload.journalKind === journalKind,
	);
}

export function goalJournalSnapshotFromCanonicalEvents(
	events: readonly RuntimeEventV3[],
): OrchestratorResult<DurableJournalSnapshot<GoalJournalRecord>> {
	if (legacyJournalExists(events, "goal")) {
		return invalid("legacy opaque goal journal requires explicit migration before governed resume");
	}
	const identity: JournalReplayIdentity = { revision: 0, transactionIds: new Set(), idempotencyKeys: new Set() };
	const transactions: DurableJournalTransaction<GoalJournalRecord>[] = [];
	for (const event of events) {
		if (event.type !== "goal.created" && event.type !== "goal.transitioned") continue;
		const replayed = replayIdentity(identity, event.payload);
		if (!replayed.ok) return replayed;
		const state = event.payload.state as unknown as GoalState;
		if (event.payload.stateDigest !== canonicalDigest(state)) return invalid("canonical goal state digest mismatch");
		let record: GoalJournalRecord;
		if (event.type === "goal.created") {
			record = {
					kind: "goal.created",
					state,
					stateDigest: event.payload.stateDigest,
					createdAt: event.timestamp,
				};
		} else {
			record = {
					kind: "goal.transitioned",
					request: event.payload.request as unknown as Extract<GoalJournalRecord, { kind: "goal.transitioned" }>["request"],
					state,
					stateDigest: event.payload.stateDigest,
					transitionedAt: event.timestamp,
				};
		}
		if (canonicalDigest([record]) !== event.payload.transactionDigest) {
			return invalid("canonical goal transaction digest mismatch");
		}
		transactions.push({
			transactionId: replayed.value.transactionId,
			idempotencyKey: replayed.value.idempotencyKey,
			transactionDigest: event.payload.transactionDigest,
			committedAt: event.timestamp,
			records: [record],
		});
	}
	return { ok: true, value: { revision: identity.revision, transactions } };
}

export function latestCanonicalGoalState(events: readonly RuntimeEventV3[]): OrchestratorResult<GoalState | undefined> {
	const snapshot = goalJournalSnapshotFromCanonicalEvents(events);
	if (!snapshot.ok) return snapshot;
	const last = snapshot.value.transactions.at(-1)?.records.at(-1);
	return { ok: true, value: last?.state };
}

export function budgetTruthFromCanonicalEvents(
	events: readonly RuntimeEventV3[],
): OrchestratorResult<CanonicalBudgetTruth> {
	if (legacyJournalExists(events, "budget")) {
		return invalid("legacy opaque budget journal requires explicit migration before governed resume");
	}
	const identity: JournalReplayIdentity = { revision: 0, transactionIds: new Set(), idempotencyKeys: new Set() };
	const transactions: DurableJournalTransaction<BudgetJournalRecord>[] = [];
	let goalId: GoalId | undefined;
	let limits: BudgetLimits | undefined;
	let limitsDigest: string | undefined;
	for (const event of events) {
		if (event.type !== "budget.transaction_committed") continue;
		const replayed = replayIdentity(identity, event.payload);
		if (!replayed.ok) return replayed;
		const parsedGoalId = parseRuntimeId("goal", event.payload.goalId);
		if (!parsedGoalId) return invalid("canonical budget goalId is invalid");
		if (goalId !== undefined && goalId !== parsedGoalId) return invalid("canonical budget journal contains a foreign goal");
		goalId = parsedGoalId;
		const eventLimits = event.payload.limits as unknown as BudgetLimits;
		if (
			BUDGET_DIMENSIONS.some((dimension) => eventLimits[dimension].hard < eventLimits[dimension].soft) ||
			canonicalDigest(eventLimits) !== event.payload.limitsDigest
		) return invalid("canonical budget limits or limits digest is invalid");
		if (limitsDigest !== undefined && limitsDigest !== event.payload.limitsDigest) {
			return invalid("canonical budget limits changed without a new budget domain");
		}
		limits = eventLimits;
		limitsDigest = event.payload.limitsDigest;
		const records = event.payload.records as unknown as readonly BudgetJournalRecord[];
		if (records.some((record) => record.goalId !== parsedGoalId)) {
			return invalid("canonical budget transaction records contain a foreign goal");
		}
		if (canonicalDigest(records) !== event.payload.transactionDigest) {
			return invalid("canonical budget transaction digest mismatch");
		}
		transactions.push({
			transactionId: replayed.value.transactionId,
			idempotencyKey: replayed.value.idempotencyKey,
			transactionDigest: event.payload.transactionDigest,
			committedAt: event.timestamp,
			records,
		});
	}
	return {
		ok: true,
		value: {
			goalId: goalId ?? null,
			limits: limits ?? null,
			limitsDigest: limitsDigest ?? null,
			journal: { revision: identity.revision, transactions },
		},
	};
}

export function budgetJournalSnapshotFromCanonicalEvents(
	events: readonly RuntimeEventV3[],
): OrchestratorResult<DurableJournalSnapshot<BudgetJournalRecord>> {
	const truth = budgetTruthFromCanonicalEvents(events);
	return truth.ok ? { ok: true, value: truth.value.journal } : truth;
}

abstract class SessionCanonicalJournal<TRecord> implements DurableOrchestratorJournalPort<TRecord> {
	protected readonly writer: EventWriter;
	protected readonly store: RuntimeEventStore;
	protected readonly principalId: PrincipalId;
	protected readonly traceIdFactory: () => TraceId;

	protected constructor(options: SessionCanonicalJournalOptions) {
		this.writer = options.writer;
		this.store = options.store;
		this.principalId = options.principalId;
		this.traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
	}

	protected abstract decode(events: readonly RuntimeEventV3[]): OrchestratorResult<DurableJournalSnapshot<TRecord>>;
	protected abstract appendCanonical(
		journalRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<void>>;

	private async loadSafely(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>> {
		const flushed = await this.writer.flush();
		if (!flushed.ok) return unavailable("canonical orchestrator writer flush failed", flushed.error.retryable);
		const events = await readVerifiedCanonicalEvents(this.store);
		return events.ok ? this.decode(events.value) : events;
	}

	public async load(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>> {
		try {
			return await this.loadSafely();
		} catch {
			return invalid("canonical orchestrator journal replay raised an unexpected error");
		}
	}

	private async appendSafely(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>> {
		if (!parseRuntimeId("command", transaction.transactionId) || !parseIdempotencyKey(transaction.idempotencyKey)) {
			return invalid("canonical orchestrator transaction identity is invalid");
		}
		if (!isCanonicalTimestamp(transaction.committedAt)) {
			return invalid("canonical orchestrator transaction timestamp is invalid");
		}
		if (canonicalDigest(transaction.records) !== transaction.transactionDigest) {
			return invalid("canonical orchestrator transaction digest mismatch");
		}
		const loaded = await this.loadSafely();
		if (!loaded.ok) return loaded;
		const previous = loaded.value.transactions.find(
			(candidate) => candidate.idempotencyKey === transaction.idempotencyKey,
		);
		if (previous) {
			if (previous.transactionDigest !== transaction.transactionDigest) {
				return {
					ok: false,
					error: {
						code: "idempotency_conflict",
						message: "idempotency key was reused for a different canonical transaction",
						retryable: false,
					},
				};
			}
			return { ok: true, value: { status: "duplicate", revision: loaded.value.revision, transaction: previous } };
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			return invalid("canonical orchestrator expected revision is invalid");
		}
		if (expectedRevision !== loaded.value.revision) {
			return { ok: true, value: { status: "conflict", actualRevision: loaded.value.revision } };
		}
		const appended = await this.appendCanonical(expectedRevision + 1, transaction);
		if (!appended.ok) return appended;
		return { ok: true, value: { status: "committed", revision: expectedRevision + 1, transaction } };
	}

	public append(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>> {
		return serializeWriter(this.writer, async () => {
			try {
				return await this.appendSafely(expectedRevision, transaction);
			} catch {
				return unavailable("canonical orchestrator append raised an unexpected error");
			}
		});
	}

	protected appendFailure(message: string, retryable: boolean): OrchestratorResult<never> {
		return unavailable(message, retryable);
	}
}

export class SessionCanonicalGoalJournal extends SessionCanonicalJournal<GoalJournalRecord> {
	public constructor(options: SessionCanonicalJournalOptions) {
		super(options);
	}

	protected decode(events: readonly RuntimeEventV3[]): OrchestratorResult<DurableJournalSnapshot<GoalJournalRecord>> {
		return goalJournalSnapshotFromCanonicalEvents(events);
	}

	protected async appendCanonical(
		journalRevision: number,
		transaction: DurableJournalTransaction<GoalJournalRecord>,
	): Promise<OrchestratorResult<void>> {
		const record = transaction.records[0];
		if (!record || transaction.records.length !== 1) return invalid("canonical goal transaction must contain exactly one record");
		const common = {
			journalRevision,
			transactionId: transaction.transactionId,
			idempotencyKey: transaction.idempotencyKey,
			transactionDigest: transaction.transactionDigest,
			state: record.state,
			stateDigest: record.stateDigest,
		} as const;
		const appended = record.kind === "goal.created"
			? await this.writer.append({
					type: "goal.created",
					principalId: this.principalId,
					traceId: this.traceIdFactory(),
					timestamp: transaction.committedAt,
					payload: common,
				})
			: await this.writer.append({
					type: "goal.transitioned",
					principalId: this.principalId,
					traceId: this.traceIdFactory(),
					timestamp: transaction.committedAt,
					payload: { ...common, request: record.request },
				});
		return appended.ok
			? { ok: true, value: undefined }
			: this.appendFailure("canonical goal event append failed", appended.error.retryable);
	}
}

export class SessionCanonicalBudgetJournal extends SessionCanonicalJournal<BudgetJournalRecord> {
	readonly #goalId: GoalId;
	readonly #limits: BudgetLimits;
	readonly #limitsDigest: string;

	public constructor(options: SessionCanonicalBudgetJournalOptions) {
		super(options);
		this.#goalId = options.goalId;
		this.#limits = options.limits;
		this.#limitsDigest = canonicalDigest(options.limits);
	}

	protected decode(events: readonly RuntimeEventV3[]): OrchestratorResult<DurableJournalSnapshot<BudgetJournalRecord>> {
		const truth = budgetTruthFromCanonicalEvents(events);
		if (!truth.ok) return truth;
		if (
			truth.value.goalId !== null &&
			(truth.value.goalId !== this.#goalId || truth.value.limitsDigest !== this.#limitsDigest)
		) return invalid("configured budget identity or limits do not match canonical truth");
		return { ok: true, value: truth.value.journal };
	}

	protected async appendCanonical(
		journalRevision: number,
		transaction: DurableJournalTransaction<BudgetJournalRecord>,
	): Promise<OrchestratorResult<void>> {
		const first = transaction.records[0];
		if (!first || transaction.records.length > 64) return invalid("canonical budget transaction record count is invalid");
		if (first.goalId !== this.#goalId || transaction.records.some((record) => record.goalId !== first.goalId)) {
			return invalid("canonical budget transaction contains multiple goals");
		}
		const appended = await this.writer.append({
			type: "budget.transaction_committed",
			principalId: this.principalId,
			traceId: this.traceIdFactory(),
			timestamp: transaction.committedAt,
			payload: {
				journalRevision,
				transactionId: transaction.transactionId,
				idempotencyKey: transaction.idempotencyKey,
				transactionDigest: transaction.transactionDigest,
				goalId: first.goalId,
				limits: this.#limits,
				limitsDigest: this.#limitsDigest,
				records: transaction.records,
			},
		});
		return appended.ok
			? { ok: true, value: undefined }
			: this.appendFailure("canonical budget event append failed", appended.error.retryable);
	}
}
