/** Tenant/manifest/sink 隔离的 durable telemetry spool 与 terminal sink-ack。 */

import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withDurableStateLock } from "../durable-state-lock.ts";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type CommandId,
	type EventStreamId,
	type ReceiptId,
	type ResourceId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import {
	projectTelemetrySampleForSink,
	validateTelemetryManifest,
	type TelemetryManifest,
	type TelemetryManifestExpectation,
} from "./manifest.ts";
import {
	isTelemetrySample,
	type TelemetryError,
	type TelemetryResult,
	type TelemetrySample,
} from "./types.ts";

export const TELEMETRY_DELIVERY_SCHEMA_VERSION = 2 as const;
export const TELEMETRY_DELIVERY_STATES = [
	"enqueued",
	"spooled",
	"delivery_pending",
	"sink_acknowledged",
	"retry_scheduled",
	"failed",
	"dropped_by_policy",
	"reconciliation_required",
] as const;
export type TelemetryDeliveryState = (typeof TELEMETRY_DELIVERY_STATES)[number];

export interface TelemetryEventRange {
	streamId: EventStreamId;
	fromSequence: number;
	fromEventHash: string;
	throughSequence: number;
	throughEventHash: string;
}

export interface TelemetryDeliveryRequest {
	schemaVersion: typeof TELEMETRY_DELIVERY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	deliveryId: ReceiptId;
	idempotencyKey: CommandId;
	manifest: TelemetryManifest;
	manifestExpectation: TelemetryManifestExpectation;
	sinkId: ResourceId;
	sinkIdentityDigest: string;
	exporterId: ResourceId;
	exporterIdentityDigest: string;
	eventRange: TelemetryEventRange;
	samples: readonly TelemetrySample[];
	enqueuedAt: string;
}

export interface TelemetrySinkAckReceiptBody {
	schemaVersion: typeof TELEMETRY_DELIVERY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	deliveryId: ReceiptId;
	receiptId: ReceiptId;
	idempotencyKey: CommandId;
	manifestDigest: string;
	batchDigest: string;
	eventRange: TelemetryEventRange;
	sinkId: ResourceId;
	sinkIdentityDigest: string;
	exporterId: ResourceId;
	exporterIdentityDigest: string;
	attempt: number;
	acknowledgedAt: string;
}

export interface TelemetrySinkAckReceipt extends TelemetrySinkAckReceiptBody {
	receiptDigest: string;
}

export interface TelemetryDeliveryRecordBody {
	schemaVersion: typeof TELEMETRY_DELIVERY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	deliveryId: ReceiptId;
	idempotencyKey: CommandId;
	manifestDigest: string;
	batchDigest: string;
	sinkId: ResourceId;
	sinkIdentityDigest: string;
	exporterId: ResourceId;
	exporterIdentityDigest: string;
	eventRange: TelemetryEventRange;
	samples: readonly TelemetrySample[];
	byteLength: number;
	state: TelemetryDeliveryState;
	attempt: number;
	revision: number;
	previousRecordDigest: string | null;
	terminalReceipt?: TelemetrySinkAckReceipt;
	reasonDigest?: string;
	canonicalEventDigest?: string;
	updatedAt: string;
}

export interface TelemetryDeliveryRecord extends TelemetryDeliveryRecordBody {
	recordDigest: string;
}

export type TelemetrySinkResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				reasonDigest: string;
				retryable: boolean;
				outcomeCertain?: boolean;
			};
	  };

export interface TelemetrySinkAckPort {
	readonly idempotency: "supported" | "unsupported";
	deliver(
		record: TelemetryDeliveryRecord,
		signal?: AbortSignal,
	): Promise<TelemetrySinkResult<TelemetrySinkAckReceipt>>;
}

export interface TelemetryDeliveryCanonicalEventPort {
	recordDelivery(
		record: TelemetryDeliveryRecord,
		receipt: TelemetrySinkAckReceipt,
	): Promise<TelemetryResult<{ eventDigest: string }>>;
}

export interface TelemetrySpoolRepository {
	load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		deliveryId: ReceiptId,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>>;
	create(record: TelemetryDeliveryRecord): Promise<TelemetryResult<TelemetryDeliveryRecord>>;
	compareAndSet(
		current: TelemetryDeliveryRecord,
		candidate: TelemetryDeliveryRecord,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>>;
}

export interface TelemetrySpoolLimits {
	maxItems: number;
	maxBatchItems: number;
	maxTotalBytes: number;
}

const DEFAULT_LIMITS: TelemetrySpoolLimits = {
	maxItems: 10_000,
	maxBatchItems: 1_000,
	maxTotalBytes: 128 * 1024 * 1024,
};

function failure<T>(
	code: TelemetryError["code"],
	message: string,
	retryable = false,
): TelemetryResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function recordBody(record: TelemetryDeliveryRecord): TelemetryDeliveryRecordBody {
	const { recordDigest: _recordDigest, ...body } = record;
	return body;
}

function withDigest(body: TelemetryDeliveryRecordBody): TelemetryDeliveryRecord {
	return { ...body, recordDigest: canonicalDigest(body) };
}

function recordKey(authorityId: AuthorityId, tenantId: TenantId, deliveryId: ReceiptId): string {
	return `${authorityId}\u0000${tenantId}\u0000${deliveryId}`;
}

function validEventRange(range: TelemetryEventRange): boolean {
	return isRuntimeId(range.streamId, "eventStream") &&
		Number.isSafeInteger(range.fromSequence) &&
		Number.isSafeInteger(range.throughSequence) &&
		range.fromSequence >= 0 &&
		range.throughSequence >= range.fromSequence &&
		isDigest(range.fromEventHash) &&
		isDigest(range.throughEventHash);
}

function isTelemetrySinkAckReceipt(value: unknown): value is TelemetrySinkAckReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const receipt = value as Partial<TelemetrySinkAckReceipt>;
	if (
		receipt.schemaVersion !== TELEMETRY_DELIVERY_SCHEMA_VERSION ||
		!isRuntimeId(receipt.authorityId, "authority") ||
		!isRuntimeId(receipt.tenantId, "tenant") ||
		!isRuntimeId(receipt.deliveryId, "receipt") ||
		!isRuntimeId(receipt.idempotencyKey, "command") ||
		!isRuntimeId(receipt.receiptId, "receipt") ||
		!isRuntimeId(receipt.sinkId, "resource") ||
		!isRuntimeId(receipt.exporterId, "resource") ||
		!isDigest(receipt.manifestDigest) ||
		!isDigest(receipt.batchDigest) ||
		!isDigest(receipt.sinkIdentityDigest) ||
		!isDigest(receipt.exporterIdentityDigest) ||
		!isDigest(receipt.receiptDigest) ||
		!validEventRange(receipt.eventRange as TelemetryEventRange) ||
		!Number.isSafeInteger(receipt.attempt) ||
		(receipt.attempt ?? 0) < 1 ||
		typeof receipt.acknowledgedAt !== "string" ||
		!Number.isFinite(Date.parse(receipt.acknowledgedAt))
	) return false;
	const { receiptDigest: _receiptDigest, ...body } = receipt as TelemetrySinkAckReceipt;
	return receipt.receiptDigest === canonicalDigest(body);
}

function isTelemetryDeliveryRecord(value: unknown): value is TelemetryDeliveryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<TelemetryDeliveryRecord>;
	if (
		record.schemaVersion !== TELEMETRY_DELIVERY_SCHEMA_VERSION ||
		!isRuntimeId(record.authorityId, "authority") ||
		!isRuntimeId(record.tenantId, "tenant") ||
		!isRuntimeId(record.deliveryId, "receipt") ||
		!isRuntimeId(record.idempotencyKey, "command") ||
		!isRuntimeId(record.sinkId, "resource") ||
		!isRuntimeId(record.exporterId, "resource") ||
		!isDigest(record.manifestDigest) ||
		!isDigest(record.batchDigest) ||
		!isDigest(record.sinkIdentityDigest) ||
		!isDigest(record.exporterIdentityDigest) ||
		!validEventRange(record.eventRange as TelemetryEventRange) ||
		!Array.isArray(record.samples) ||
		record.samples.some((sample) => !isTelemetrySample(sample)) ||
		!Number.isSafeInteger(record.byteLength) ||
		(record.byteLength ?? 0) < 1 ||
		!TELEMETRY_DELIVERY_STATES.includes(record.state as TelemetryDeliveryState) ||
		!Number.isSafeInteger(record.attempt) ||
		(record.attempt ?? -1) < 0 ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision ?? 0) < 1 ||
		(record.previousRecordDigest !== null && !isDigest(record.previousRecordDigest)) ||
		!isDigest(record.recordDigest) ||
		typeof record.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		(record.terminalReceipt !== undefined && !isTelemetrySinkAckReceipt(record.terminalReceipt))
	) return false;
	return record.recordDigest === canonicalDigest(recordBody(record as TelemetryDeliveryRecord));
}

const transitions: Readonly<Record<TelemetryDeliveryState, readonly TelemetryDeliveryState[]>> = {
	enqueued: ["spooled", "failed", "dropped_by_policy"],
	spooled: ["delivery_pending", "dropped_by_policy"],
	delivery_pending: ["sink_acknowledged", "retry_scheduled", "failed", "reconciliation_required"],
	sink_acknowledged: ["sink_acknowledged"],
	retry_scheduled: ["delivery_pending", "dropped_by_policy"],
	failed: [],
	dropped_by_policy: [],
	reconciliation_required: [],
};

function transition(
	current: TelemetryDeliveryRecord,
	state: TelemetryDeliveryState,
	updatedAt: string,
	patch: Partial<Pick<
		TelemetryDeliveryRecordBody,
		"attempt" | "terminalReceipt" | "reasonDigest" | "canonicalEventDigest"
	>> = {},
): TelemetryResult<TelemetryDeliveryRecord> {
	if (!transitions[current.state].includes(state)) {
		return failure("conflict", `invalid telemetry delivery transition ${current.state} -> ${state}`);
	}
	return {
		ok: true,
		value: withDigest({
			...recordBody(current),
			...patch,
			state,
			revision: current.revision + 1,
			previousRecordDigest: current.recordDigest,
			updatedAt,
		}),
	};
}

export class MemoryTelemetrySpoolRepository implements TelemetrySpoolRepository {
	readonly #records = new Map<string, TelemetryDeliveryRecord>();
	readonly #limits: TelemetrySpoolLimits;

	public constructor(limits: Partial<TelemetrySpoolLimits> = {}) {
		this.#limits = { ...DEFAULT_LIMITS, ...limits };
	}

	public async load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		deliveryId: ReceiptId,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const record = this.#records.get(recordKey(authorityId, tenantId, deliveryId));
		return record ? { ok: true, value: structuredClone(record) } : failure("invalid_schema", "delivery record was not found");
	}

	public async create(record: TelemetryDeliveryRecord): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		if (!isTelemetryDeliveryRecord(record) || record.state !== "enqueued" || record.revision !== 1) {
			return failure("invalid_schema", "delivery record is invalid");
		}
		if (record.samples.length > this.#limits.maxBatchItems) return failure("spool_full", "telemetry batch exceeds item limit");
		const key = recordKey(record.authorityId, record.tenantId, record.deliveryId);
		const existing = this.#records.get(key);
		if (existing) {
			return existing.batchDigest === record.batchDigest && existing.manifestDigest === record.manifestDigest
				? { ok: true, value: structuredClone(existing) }
				: failure("conflict", "delivery id was reused with changed input");
		}
		const scoped = [...this.#records.values()].filter((candidate) =>
			candidate.authorityId === record.authorityId && candidate.tenantId === record.tenantId);
		const totalBytes = scoped.reduce((sum, candidate) => sum + candidate.byteLength, 0);
		if (scoped.length >= this.#limits.maxItems || totalBytes + record.byteLength > this.#limits.maxTotalBytes) {
			return failure("spool_full", "telemetry spool capacity exceeded");
		}
		this.#records.set(key, structuredClone(record));
		return { ok: true, value: structuredClone(record) };
	}

	public async compareAndSet(
		current: TelemetryDeliveryRecord,
		candidate: TelemetryDeliveryRecord,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		if (!isTelemetryDeliveryRecord(current) || !isTelemetryDeliveryRecord(candidate)) {
			return failure("invalid_schema", "delivery CAS record is invalid");
		}
		const key = recordKey(current.authorityId, current.tenantId, current.deliveryId);
		const stored = this.#records.get(key);
		if (!stored || stored.recordDigest !== current.recordDigest || candidate.previousRecordDigest !== current.recordDigest) {
			return failure("conflict", "delivery CAS expectation is stale");
		}
		this.#records.set(key, structuredClone(candidate));
		return { ok: true, value: structuredClone(candidate) };
	}
}

export class FileTelemetrySpoolRepository implements TelemetrySpoolRepository {
	readonly #root: string;
	readonly #limits: TelemetrySpoolLimits;

	public constructor(root: string, limits: Partial<TelemetrySpoolLimits> = {}) {
		this.#root = resolve(root);
		this.#limits = { ...DEFAULT_LIMITS, ...limits };
	}

	#scopePath(authorityId: AuthorityId, tenantId: TenantId): string {
		return join(this.#root, canonicalDigest({ authorityId, tenantId }));
	}

	#path(record: TelemetryDeliveryRecord): string {
		const sinkScope = canonicalDigest({
			sinkId: record.sinkId,
			sinkIdentityDigest: record.sinkIdentityDigest,
			exporterId: record.exporterId,
			exporterIdentityDigest: record.exporterIdentityDigest,
		});
		return join(
			this.#scopePath(record.authorityId, record.tenantId),
			`${record.manifestDigest}.${sinkScope}.${canonicalDigest({ deliveryId: record.deliveryId })}.json`,
		);
	}

	async #recordPaths(authorityId: AuthorityId, tenantId: TenantId): Promise<TelemetryResult<readonly string[]>> {
		const scope = this.#scopePath(authorityId, tenantId);
		try {
			const names = await readdir(scope);
			return {
				ok: true,
				value: names
					.filter((name) => /^[a-f0-9]{64}\.[a-f0-9]{64}\.[a-f0-9]{64}\.json$/u.test(name))
					.map((name) => join(scope, name))
					.sort(),
			};
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? { ok: true, value: [] }
				: failure("durable_write_failed", "delivery spool scope could not be scanned", true);
		}
	}

	async #findPath(
		authorityId: AuthorityId,
		tenantId: TenantId,
		deliveryId: ReceiptId,
	): Promise<TelemetryResult<string | undefined>> {
		const paths = await this.#recordPaths(authorityId, tenantId);
		if (!paths.ok) return paths;
		const suffix = `.${canonicalDigest({ deliveryId })}.json`;
		const matches = paths.value.filter((path) => path.endsWith(suffix));
		return matches.length <= 1
			? { ok: true, value: matches[0] }
			: failure("corrupt_record", "delivery id resolves to multiple isolated spool records");
	}

	async #read(path: string): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		try {
			const bytes = await readFile(path);
			if (bytes.byteLength > 16 * 1024 * 1024) return failure("corrupt_record", "delivery record exceeds limit");
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return isTelemetryDeliveryRecord(value)
				? { ok: true, value }
				: failure("corrupt_record", "delivery record failed integrity validation");
		} catch (error) {
			if (error instanceof SyntaxError) return failure("corrupt_record", "delivery record is not valid JSON");
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? failure("invalid_schema", "delivery record was not found")
				: failure("durable_write_failed", "delivery record could not be read", true);
		}
	}

	async #write(path: string, record: TelemetryDeliveryRecord): Promise<TelemetryResult<void>> {
		const directory = dirname(path);
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(canonicalJson(record), "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, path);
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
			return { ok: true, value: undefined };
		} catch {
			if (handle) await handle.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			return failure("durable_write_failed", "delivery record could not be published", true);
		}
	}

	public async load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		deliveryId: ReceiptId,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const path = await this.#findPath(authorityId, tenantId, deliveryId);
		return path.ok && path.value
			? this.#read(path.value)
			: path.ok
				? failure("invalid_schema", "delivery record was not found")
				: path;
	}

	public async create(record: TelemetryDeliveryRecord): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		if (!isTelemetryDeliveryRecord(record) || record.state !== "enqueued" || record.revision !== 1) {
			return failure("invalid_schema", "delivery record is invalid");
		}
		if (record.samples.length > this.#limits.maxBatchItems) {
			return failure("spool_full", "telemetry batch exceeds item limit");
		}
		const scopePath = this.#scopePath(record.authorityId, record.tenantId);
		try {
			return await withDurableStateLock(join(scopePath, ".spool"), async () => {
				const existingPath = await this.#findPath(record.authorityId, record.tenantId, record.deliveryId);
				if (!existingPath.ok) return existingPath;
				if (existingPath.value) {
					const existing = await this.#read(existingPath.value);
					if (!existing.ok) return existing;
					return existing.value.batchDigest === record.batchDigest &&
						existing.value.manifestDigest === record.manifestDigest &&
						existing.value.sinkId === record.sinkId &&
						existing.value.exporterId === record.exporterId
						? existing
						: failure("conflict", "delivery id was reused with changed input");
				}
				const paths = await this.#recordPaths(record.authorityId, record.tenantId);
				if (!paths.ok) return paths;
				let totalBytes = 0;
				for (const path of paths.value) {
					const current = await this.#read(path);
					if (!current.ok) return current;
					totalBytes += current.value.byteLength;
				}
				if (paths.value.length >= this.#limits.maxItems ||
					totalBytes + record.byteLength > this.#limits.maxTotalBytes) {
					return failure("spool_full", "telemetry spool capacity exceeded");
				}
				const written = await this.#write(this.#path(record), record);
				return written.ok ? { ok: true, value: record } : written;
			});
		} catch {
			return failure("durable_write_failed", "delivery spool lock is unavailable", true);
		}
	}

	public async compareAndSet(
		current: TelemetryDeliveryRecord,
		candidate: TelemetryDeliveryRecord,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		if (!isTelemetryDeliveryRecord(current) || !isTelemetryDeliveryRecord(candidate)) {
			return failure("invalid_schema", "delivery CAS record is invalid");
		}
		const scopePath = this.#scopePath(current.authorityId, current.tenantId);
		try {
			return await withDurableStateLock(join(scopePath, ".spool"), async () => {
				const path = await this.#findPath(current.authorityId, current.tenantId, current.deliveryId);
				if (!path.ok || !path.value) return failure("conflict", "delivery CAS expectation is stale");
				const stored = await this.#read(path.value);
				if (!stored.ok || stored.value.recordDigest !== current.recordDigest ||
					candidate.previousRecordDigest !== current.recordDigest ||
					this.#path(candidate) !== path.value) {
					return failure("conflict", "delivery CAS expectation is stale");
				}
				const written = await this.#write(path.value, candidate);
				return written.ok ? { ok: true, value: candidate } : written;
			});
		} catch {
			return failure("durable_write_failed", "delivery spool lock is unavailable", true);
		}
	}
}

function ackMatches(record: TelemetryDeliveryRecord, receipt: TelemetrySinkAckReceipt): boolean {
	return isTelemetrySinkAckReceipt(receipt) &&
		receipt.authorityId === record.authorityId &&
		receipt.tenantId === record.tenantId &&
		receipt.deliveryId === record.deliveryId &&
		receipt.idempotencyKey === record.idempotencyKey &&
		receipt.manifestDigest === record.manifestDigest &&
		receipt.batchDigest === record.batchDigest &&
		receipt.sinkId === record.sinkId &&
		receipt.sinkIdentityDigest === record.sinkIdentityDigest &&
		receipt.exporterId === record.exporterId &&
		receipt.exporterIdentityDigest === record.exporterIdentityDigest &&
		receipt.attempt === record.attempt &&
		canonicalDigest(receipt.eventRange) === canonicalDigest(record.eventRange);
}

export class DurableTelemetryDeliveryService {
	readonly #repository: TelemetrySpoolRepository;
	readonly #sink: TelemetrySinkAckPort;
	readonly #events: TelemetryDeliveryCanonicalEventPort;
	readonly #clock: () => Date;

	public constructor(options: {
		repository: TelemetrySpoolRepository;
		sink: TelemetrySinkAckPort;
		events: TelemetryDeliveryCanonicalEventPort;
		clock?: () => Date;
	}) {
		this.#repository = options.repository;
		this.#sink = options.sink;
		this.#events = options.events;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #transition(
		current: TelemetryDeliveryRecord,
		state: TelemetryDeliveryState,
		patch?: Partial<Pick<
			TelemetryDeliveryRecordBody,
			"attempt" | "terminalReceipt" | "reasonDigest" | "canonicalEventDigest"
		>>,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const candidate = transition(current, state, this.#clock().toISOString(), patch);
		return candidate.ok ? this.#repository.compareAndSet(current, candidate.value) : candidate;
	}

	public async enqueue(request: TelemetryDeliveryRequest): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const manifest = validateTelemetryManifest(
			request.manifest,
			request.manifestExpectation,
			this.#clock(),
		);
		if (!manifest.ok) return manifest;
		if (!validEventRange(request.eventRange) || request.samples.length === 0) {
			return failure("invalid_schema", "delivery request event range or batch is invalid");
		}
		const projected: TelemetrySample[] = [];
		for (const sample of request.samples) {
			if (!isTelemetrySample(sample) || sample.authorityId !== request.authorityId ||
				sample.tenantId !== request.tenantId) {
				return failure("scope_mismatch", "delivery sample scope mismatch");
			}
			const selected = projectTelemetrySampleForSink(manifest.value, request.sinkId, sample);
			if (!selected.ok) return selected;
			projected.push(selected.value);
		}
		const batchDigest = canonicalDigest(projected);
		const body: TelemetryDeliveryRecordBody = {
			schemaVersion: TELEMETRY_DELIVERY_SCHEMA_VERSION,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			deliveryId: request.deliveryId,
			idempotencyKey: request.idempotencyKey,
			manifestDigest: manifest.value.manifestDigest,
			batchDigest,
			sinkId: request.sinkId,
			sinkIdentityDigest: request.sinkIdentityDigest,
			exporterId: request.exporterId,
			exporterIdentityDigest: request.exporterIdentityDigest,
			eventRange: request.eventRange,
			samples: projected,
			byteLength: Buffer.byteLength(canonicalJson(projected), "utf8"),
			state: "enqueued",
			attempt: 0,
			revision: 1,
			previousRecordDigest: null,
			updatedAt: request.enqueuedAt,
		};
		const created = await this.#repository.create(withDigest(body));
		if (!created.ok) return created;
		if (created.value.state !== "enqueued") return created;
		return this.#transition(created.value, "spooled");
	}

	async #recordAck(record: TelemetryDeliveryRecord): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const receipt = record.terminalReceipt;
		if (!receipt) return failure("corrupt_record", "acknowledged delivery lacks terminal receipt");
		if (record.canonicalEventDigest) return { ok: true, value: record };
		const event = await this.#events.recordDelivery(record, receipt);
		if (!event.ok) return event;
		return this.#transition(record, "sink_acknowledged", {
			canonicalEventDigest: event.value.eventDigest,
		});
	}

	public async deliver(
		authorityId: AuthorityId,
		tenantId: TenantId,
		deliveryId: ReceiptId,
		signal?: AbortSignal,
	): Promise<TelemetryResult<TelemetryDeliveryRecord>> {
		const loaded = await this.#repository.load(authorityId, tenantId, deliveryId);
		if (!loaded.ok) return loaded;
		let record = loaded.value;
		if (record.state === "sink_acknowledged") return this.#recordAck(record);
		if (record.state === "reconciliation_required") {
			return failure("reconciliation_required", "delivery requires operator reconciliation");
		}
		if (record.state === "delivery_pending" && this.#sink.idempotency === "unsupported") {
			const reconciled = await this.#transition(record, "reconciliation_required", {
				reasonDigest: canonicalDigest("non-idempotent sink outcome is unknown after restart"),
			});
			return reconciled.ok
				? failure("reconciliation_required", "non-idempotent sink outcome is unknown")
				: reconciled;
		}
		if (record.state !== "spooled" && record.state !== "retry_scheduled" &&
			!(record.state === "delivery_pending" && this.#sink.idempotency === "supported")) {
			return failure("conflict", `delivery cannot run from ${record.state}`);
		}
		if (record.state !== "delivery_pending") {
			const pending = await this.#transition(record, "delivery_pending", { attempt: record.attempt + 1 });
			if (!pending.ok) return pending;
			record = pending.value;
		}
		let delivered: TelemetrySinkResult<TelemetrySinkAckReceipt>;
		try {
			delivered = await this.#sink.deliver(record, signal);
		} catch {
			delivered = {
				ok: false,
				error: {
					reasonDigest: canonicalDigest("telemetry sink threw after effect boundary"),
					retryable: false,
					outcomeCertain: false,
				},
			};
		}
		if (!delivered.ok) {
			const certain = delivered.error.outcomeCertain === true;
			const state: TelemetryDeliveryState =
				!certain ? "reconciliation_required" :
				delivered.error.retryable ? "retry_scheduled" :
				"failed";
			const updated = await this.#transition(record, state, {
				reasonDigest: delivered.error.reasonDigest,
			});
			return updated.ok && state === "reconciliation_required"
				? failure("reconciliation_required", "telemetry sink outcome is unknown")
				: updated;
		}
		if (!ackMatches(record, delivered.value)) {
			const reconciled = await this.#transition(record, "reconciliation_required", {
				reasonDigest: canonicalDigest("telemetry sink returned an uncorrelated receipt"),
			});
			return reconciled.ok
				? failure("reconciliation_required", "telemetry sink receipt is uncorrelated")
				: reconciled;
		}
		const acknowledged = await this.#transition(record, "sink_acknowledged", {
			terminalReceipt: delivered.value,
		});
		return acknowledged.ok ? this.#recordAck(acknowledged.value) : acknowledged;
	}
}

export function telemetrySinkAckReceiptDigest(body: TelemetrySinkAckReceiptBody): string {
	return canonicalDigest(body);
}
