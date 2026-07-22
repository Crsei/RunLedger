/** Phase 7 Orchestrator transaction 与 Session Kernel v3 event chain 的 durable adapter。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { sameRuntimeEventStream, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type PrincipalId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import {
	MAX_ORCHESTRATOR_JOURNAL_RECORDS,
	MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES,
	ORCHESTRATOR_JOURNAL_KINDS,
	type OrchestratorJournalKind,
} from "../protocol/v3/event-payloads.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type {
	DurableJournalAppendOutcome,
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	OrchestratorResult,
} from "./types.ts";

export { ORCHESTRATOR_JOURNAL_KINDS };
export type { OrchestratorJournalKind };

const JOURNAL_KIND_SET: ReadonlySet<string> = new Set(ORCHESTRATOR_JOURNAL_KINDS);
const JOURNAL_RECORD_KINDS: Readonly<Record<OrchestratorJournalKind, ReadonlySet<string>>> = {
	goal: new Set(["goal.created", "goal.transitioned"]),
	save_point: new Set([
		"save_point.created",
		"save_point.mutation_queued",
		"save_point.settled",
		"save_point.mutations_applied",
	]),
	budget: new Set([
		"budget.reserved",
		"budget.committed",
		"budget.refunded",
		"budget.reconciled",
		"budget.soft_threshold",
		"budget.reservation_denied",
		"budget.hard_stopped",
	]),
	queue: new Set(["queue.enqueued", "queue.claimed", "queue.consumed", "queue.reconciled"]),
};

interface CanonicalRecords {
	records: readonly Readonly<Record<string, unknown>>[];
	recordsJson: string;
	recordsByteLength: number;
}

interface DecodedJournalTransaction {
	journalKind: OrchestratorJournalKind;
	journalRevision: number;
	transaction: DurableJournalTransaction<Readonly<Record<string, unknown>>>;
}

export interface SessionOrchestratorJournalOptions {
	journalKind: OrchestratorJournalKind;
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	traceIdFactory?: () => TraceId;
}

interface JournalReplayState {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJournalKind(value: unknown): value is OrchestratorJournalKind {
	return typeof value === "string" && JOURNAL_KIND_SET.has(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function decodeCanonicalRecords(
	journalKind: OrchestratorJournalKind,
	recordsJson: string,
	recordCount: number,
	recordsByteLength: number,
	transactionDigest: string,
): OrchestratorResult<CanonicalRecords> {
	const actualBytes = Buffer.byteLength(recordsJson, "utf8");
	if (
		actualBytes !== recordsByteLength ||
		actualBytes > MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES
	) {
		return invalid("orchestrator journal records byte length is invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(recordsJson) as unknown;
	} catch {
		return invalid("orchestrator journal records JSON is not parseable");
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		parsed.length > MAX_ORCHESTRATOR_JOURNAL_RECORDS ||
		parsed.length !== recordCount
	) {
		return invalid("orchestrator journal record count is invalid");
	}
	if (!parsed.every(isRecord)) return invalid("orchestrator journal records must be objects");
	const allowedKinds = JOURNAL_RECORD_KINDS[journalKind];
	if (!parsed.every((record) => typeof record.kind === "string" && allowedKinds.has(record.kind))) {
		return invalid("orchestrator journal record kind does not match its journal");
	}
	let canonical: string;
	try {
		canonical = canonicalJson(parsed);
	} catch {
		return invalid("orchestrator journal records are not canonical JSON values");
	}
	if (canonical !== recordsJson) return invalid("orchestrator journal records JSON is not canonical");
	if (canonicalDigest(parsed) !== transactionDigest) {
		return invalid("orchestrator journal transaction digest mismatch");
	}
	return {
		ok: true,
		value: { records: parsed, recordsJson, recordsByteLength: actualBytes },
	};
}

function encodeTransaction<TRecord>(
	journalKind: OrchestratorJournalKind,
	transaction: DurableJournalTransaction<TRecord>,
): OrchestratorResult<{
	canonical: CanonicalRecords;
	transaction: DurableJournalTransaction<TRecord>;
}> {
	if (!parseRuntimeId("command", transaction.transactionId)) {
		return invalid("orchestrator journal transactionId is invalid");
	}
	if (!parseIdempotencyKey(transaction.idempotencyKey)) {
		return invalid("orchestrator journal idempotency key is invalid");
	}
	if (!isCanonicalTimestamp(transaction.committedAt)) {
		return invalid("orchestrator journal committedAt is invalid");
	}
	let recordsJson: string;
	try {
		recordsJson = canonicalJson(transaction.records);
	} catch {
		return invalid("orchestrator journal records are not canonical");
	}
	const decoded = decodeCanonicalRecords(
		journalKind,
		recordsJson,
		transaction.records.length,
		Buffer.byteLength(recordsJson, "utf8"),
		transaction.transactionDigest,
	);
	if (!decoded.ok) return decoded;
	return {
		ok: true,
		value: {
			canonical: decoded.value,
			transaction: {
				transactionId: transaction.transactionId,
				idempotencyKey: transaction.idempotencyKey,
				transactionDigest: transaction.transactionDigest,
				committedAt: transaction.committedAt,
				records: decoded.value.records as unknown as readonly TRecord[],
			},
		},
	};
}

function decodeJournalEvent(
	event: Extract<RuntimeEventV3, { type: "orchestrator.journal_committed" }>,
): OrchestratorResult<DecodedJournalTransaction> {
	const payload = event.payload;
	if (!isJournalKind(payload.journalKind)) return invalid("orchestrator journal kind is invalid");
	const transactionId = parseRuntimeId("command", payload.transactionId);
	const idempotencyKey = parseIdempotencyKey(payload.idempotencyKey);
	if (!transactionId || !idempotencyKey) {
		return invalid("orchestrator journal transaction identity is invalid");
	}
	const records = decodeCanonicalRecords(
		payload.journalKind,
		payload.recordsJson,
		payload.recordCount,
		payload.recordsByteLength,
		payload.transactionDigest,
	);
	if (!records.ok) return records;
	return {
		ok: true,
		value: {
			journalKind: payload.journalKind,
			journalRevision: payload.journalRevision,
			transaction: {
				transactionId,
				idempotencyKey,
				transactionDigest: payload.transactionDigest,
				committedAt: event.timestamp,
				records: records.value.records,
			},
		},
	};
}

function journalEvents(events: readonly RuntimeEventV3[]): readonly Extract<RuntimeEventV3, { type: "orchestrator.journal_committed" }>[] {
	return events.filter(
		(event): event is Extract<RuntimeEventV3, { type: "orchestrator.journal_committed" }> =>
			event.type === "orchestrator.journal_committed",
	);
}

/**
 * 每个 transaction 恰好对应一个 v3 event。EventWriter 的 session-head CAS 是 durable
 * write serialization point；payload 内的 journalRevision 是每种 journal 的独立 CAS revision。
 */
export class SessionDurableOrchestratorJournal<TRecord>
	implements DurableOrchestratorJournalPort<TRecord>
{
	readonly #journalKind: OrchestratorJournalKind;
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #principalId: PrincipalId;
	readonly #traceIdFactory: () => TraceId;

	public constructor(options: SessionOrchestratorJournalOptions) {
		this.#journalKind = options.journalKind;
		this.#writer = options.writer;
		this.#store = options.store;
		this.#principalId = options.principalId;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
	}

	async #verifiedEvents(): Promise<OrchestratorResult<readonly RuntimeEventV3[]>> {
		let verified;
		try {
			verified = await this.#store.verify(this.#store.streamRef());
		} catch {
			return unavailable("orchestrator journal event-store verification failed");
		}
		if (!verified.ok) {
			return unavailable("orchestrator journal event-store verification failed", verified.error.retryable);
		}
		if (verified.value.integrity !== "valid") {
			return invalid("orchestrator journal event chain is not complete and valid");
		}
		const replay = await readAllRuntimeEvents(this.#store);
		if (!replay.ok) {
			return unavailable("orchestrator journal event replay failed", replay.error.retryable);
		}
		const first = replay.value[0];
		if (!first) {
			return verified.value.eventCount === 0
				? { ok: true, value: [] }
				: invalid("orchestrator journal verification and replay disagree");
		}
		const chain = verifyRuntimeEventChain(replay.value, {
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			stream: first.stream,
		});
		if (
			chain.integrity !== "valid" ||
			verified.value.authorityId !== first.authorityId ||
			verified.value.tenantId !== first.tenantId ||
			!sameRuntimeEventStream(verified.value.stream, first.stream)
		) {
			return invalid("orchestrator journal event chain failed canonical verification");
		}
		return { ok: true, value: replay.value };
	}

	async #loadSafely(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>> {
		if (!isJournalKind(this.#journalKind)) return invalid("orchestrator journal adapter kind is invalid");
		const replay = await this.#verifiedEvents();
		if (!replay.ok) return replay;
		const states = new Map<OrchestratorJournalKind, JournalReplayState>(
			ORCHESTRATOR_JOURNAL_KINDS.map((kind) => [
				kind,
				{ revision: 0, transactionIds: new Set<string>(), idempotencyKeys: new Set<string>() },
			]),
		);
		const selected: DurableJournalTransaction<TRecord>[] = [];
		for (const event of journalEvents(replay.value)) {
			const decoded = decodeJournalEvent(event);
			if (!decoded.ok) return decoded;
			const state = states.get(decoded.value.journalKind);
			if (!state) return invalid("orchestrator journal replay kind is unavailable");
			if (decoded.value.journalRevision !== state.revision + 1) {
				return invalid("orchestrator journal revision is discontinuous");
			}
			if (state.transactionIds.has(decoded.value.transaction.transactionId)) {
				return invalid("orchestrator journal transactionId is duplicated");
			}
			if (state.idempotencyKeys.has(decoded.value.transaction.idempotencyKey)) {
				return invalid("orchestrator journal idempotency key is duplicated");
			}
			state.revision = decoded.value.journalRevision;
			state.transactionIds.add(decoded.value.transaction.transactionId);
			state.idempotencyKeys.add(decoded.value.transaction.idempotencyKey);
			if (decoded.value.journalKind === this.#journalKind) {
				selected.push(decoded.value.transaction as unknown as DurableJournalTransaction<TRecord>);
			}
		}
		const selectedState = states.get(this.#journalKind);
		if (!selectedState) return invalid("orchestrator journal replay state is unavailable");
		return { ok: true, value: { revision: selectedState.revision, transactions: selected } };
	}

	public async load(): Promise<OrchestratorResult<DurableJournalSnapshot<TRecord>>> {
		try {
			return await this.#loadSafely();
		} catch {
			return invalid("orchestrator journal replay raised an unexpected error");
		}
	}

	async #appendSafely(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>> {
		const encoded = encodeTransaction(this.#journalKind, transaction);
		if (!encoded.ok) return encoded;
		const loaded = await this.#loadSafely();
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
						message: "idempotency key was reused for a different transaction",
						retryable: false,
					},
				};
			}
			return {
				ok: true,
				value: { status: "duplicate", revision: loaded.value.revision, transaction: previous },
			};
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			return invalid("orchestrator journal expected revision is invalid");
		}
		if (expectedRevision !== loaded.value.revision) {
			return { ok: true, value: { status: "conflict", actualRevision: loaded.value.revision } };
		}
		const appended = await this.#writer.append({
			type: "orchestrator.journal_committed",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			timestamp: encoded.value.transaction.committedAt,
			payload: {
				journalKind: this.#journalKind,
				journalRevision: expectedRevision + 1,
				transactionId: encoded.value.transaction.transactionId,
				idempotencyKey: encoded.value.transaction.idempotencyKey,
				transactionDigest: encoded.value.transaction.transactionDigest,
				recordCount: encoded.value.canonical.records.length,
				recordsByteLength: encoded.value.canonical.recordsByteLength,
				recordsJson: encoded.value.canonical.recordsJson,
			},
		});
		if (!appended.ok) {
			return unavailable("orchestrator journal durable event append failed", appended.error.retryable);
		}
		return {
			ok: true,
			value: {
				status: "committed",
				revision: expectedRevision + 1,
				transaction: encoded.value.transaction,
			},
		};
	}

	public append(
		expectedRevision: number,
		transaction: DurableJournalTransaction<TRecord>,
	): Promise<OrchestratorResult<DurableJournalAppendOutcome<TRecord>>> {
		return serializeWriter(this.#writer, async () => {
			try {
				return await this.#appendSafely(expectedRevision, transaction);
			} catch {
				return unavailable("orchestrator journal append raised an unexpected error");
			}
		});
	}
}
