/** 严格 LF JSONL RuntimeEventV3 store；坏链只报告，不自动修复。 */

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../protocol/v3/canonical-json.ts";
import { computeRuntimeEventHash, computeRuntimeEventPayloadDigest } from "../protocol/v3/event-hash.ts";
import {
	sameRuntimeEventStream,
	type ExpectedRevision,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type { AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import {
	MAX_RUNTIME_EVENT_BYTES,
	isExpectedRevision,
	validateRuntimeEvent,
} from "../protocol/v3/schemas.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import { reduceSessionEvents } from "./reducer.ts";
import type { RuntimeEventStore, WriterFenceValidator } from "./event-store.ts";
import { reduceAuthorityLifecycleEvents } from "./authority-lifecycle-projection.ts";
import type {
	AcceptedEventCursor,
	DurableEventReceipt,
	EventLogVerification,
	EventPage,
	EventPageQuery,
	SessionKernelError,
	SessionKernelErrorCode,
	SessionResult,
	WriterFence,
} from "./types.ts";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LF = 0x0a;
const CR = 0x0d;

export interface JsonlV3EventStoreOptions {
	filePath: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
	validateFence: WriterFenceValidator;
	onWritePhase?: (phase: JsonlV3WritePhase) => Promise<void> | void;
}

export type JsonlV3WritePhase =
	| "before_create_sync"
	| "before_event_write"
	| "after_event_write_before_sync"
	| "before_event_sync"
	| "before_flush_sync"
	| "after_flush_sync_before_receipt";

export interface JsonlV3EventLogScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
}

export interface JsonlV3ScanError {
	code: SessionKernelErrorCode;
	message: string;
	/** 0-based JSONL line。 */
	line: number;
	/** 0-based raw byte offset。 */
	byteOffset: number;
}

export interface JsonlV3ScanResult {
	/** 首个错误前已完整验证的事件前缀。 */
	events: readonly RuntimeEventV3[];
	tornTail: boolean;
	firstError?: JsonlV3ScanError;
}

interface DiskSnapshot {
	events: RuntimeEventV3[];
	byteLength: number;
}

type StoreLifecycle = "open" | "closing" | "closed";

function fail<T>(
	code: SessionKernelErrorCode,
	message: string,
	retryable = false,
	details?: Readonly<Record<string, string | number | boolean>>,
	effect: "none" | "committed" | "uncertain" = "none",
): SessionResult<T> {
	return {
		ok: false,
		error: { code, message, retryable, effect, ...(details ? { details } : {}) },
	};
}

function unexpectedFailure<T>(
	message: string,
	error: unknown,
	effect: "none" | "committed" | "uncertain" = "none",
): SessionResult<T> {
	return fail("durable_write_failed", message, false, {
		errorName: error instanceof Error ? error.name : "UnknownError",
	}, effect);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function validationFailure<T>(validation: Exclude<ReturnType<typeof validateRuntimeEvent>, { ok: true }>): SessionResult<T> {
	return fail(
		validation.code === "oversized_payload" ? "oversized_event" : "invalid_event",
		validation.message,
	);
}

function isContentFailure(code: SessionKernelErrorCode): boolean {
	return (
		code === "invalid_event" ||
		code === "oversized_event" ||
		code === "sequence_conflict" ||
		code === "hash_mismatch" ||
		code === "identity_mismatch" ||
		code === "corrupted_log" ||
		code === "torn_tail"
	);
}

function scanError(
	events: readonly RuntimeEventV3[],
	tornTail: boolean,
	code: SessionKernelErrorCode,
	message: string,
	line: number,
	byteOffset: number,
): JsonlV3ScanResult {
	return {
		events,
		tornTail,
		firstError: { code, message, line, byteOffset },
	};
}

function isContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/** 返回首个不符合 RFC 3629 的 byte offset；避免替换字符掩盖日志损坏。 */
function findInvalidUtf8Offset(bytes: Uint8Array): number | undefined {
	for (let index = 0; index < bytes.byteLength; index += 1) {
		const first = bytes[index] ?? 0;
		if (first <= 0x7f) continue;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const fourth = bytes[index + 3];
		if (first >= 0xc2 && first <= 0xdf && isContinuationByte(second)) {
			index += 1;
			continue;
		}
		if (
			((first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf) ||
				(first >= 0xe1 && first <= 0xec && isContinuationByte(second)) ||
				(first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f) ||
				(first >= 0xee && first <= 0xef && isContinuationByte(second))) &&
			isContinuationByte(third)
		) {
			index += 2;
			continue;
		}
		if (
			((first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf) ||
				(first >= 0xf1 && first <= 0xf3 && isContinuationByte(second)) ||
				(first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f)) &&
			isContinuationByte(third) &&
			isContinuationByte(fourth)
		) {
			index += 3;
			continue;
		}
		return index;
	}
	return undefined;
}

/**
 * 纯只读 scanner。保留首个坏行前的可信前缀，供 verify/recovery/salvage 共用；
 * scanner 本身不写入、截断或修复任何字节。
 */
export function scanJsonlV3EventLog(
	bytes: Uint8Array,
	scope: JsonlV3EventLogScope,
): JsonlV3ScanResult {
	if (bytes.byteLength === 0) return { events: [], tornTail: false };
	const tornTail = bytes[bytes.byteLength - 1] !== LF;
	const events: RuntimeEventV3[] = [];
	let line = 0;
	let lineStart = 0;
	let previousHash: string | null = null;

	for (let offset = 0; offset < bytes.byteLength; offset += 1) {
		if (bytes[offset] !== LF) continue;
		const lineBytes = bytes.subarray(lineStart, offset);
		if (lineBytes.byteLength === 0) {
			return scanError(events, tornTail, "corrupted_log", "event log contains an empty line", line, lineStart);
		}
		const crOffset = lineBytes.indexOf(CR);
		if (crOffset >= 0) {
			return scanError(
				events,
				tornTail,
				"corrupted_log",
				"event log contains CR framing",
				line,
				lineStart + crOffset,
			);
		}
		const invalidUtf8Offset = findInvalidUtf8Offset(lineBytes);
		if (invalidUtf8Offset !== undefined) {
			return scanError(
				events,
				tornTail,
				"corrupted_log",
				"event log is not valid UTF-8",
				line,
				lineStart + invalidUtf8Offset,
			);
		}
		if (lineBytes.byteLength > MAX_RUNTIME_EVENT_BYTES) {
			return scanError(
				events,
				tornTail,
				"oversized_event",
				"event log line exceeds the event byte limit",
				line,
				lineStart,
			);
		}

		const lineText = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
		let parsed: unknown;
		try {
			parsed = JSON.parse(lineText) as unknown;
		} catch {
			return scanError(events, tornTail, "corrupted_log", "event log contains malformed JSON", line, lineStart);
		}
		const validation = validateRuntimeEvent(parsed);
		if (!validation.ok) {
			return scanError(
				events,
				tornTail,
				validation.code === "oversized_payload" ? "oversized_event" : "invalid_event",
				validation.message,
				line,
				lineStart,
			);
		}
		const event = validation.value;
			if (
				event.authorityId !== scope.authorityId ||
				event.tenantId !== scope.tenantId ||
				!sameRuntimeEventStream(event.stream, scope.stream)
			) {
			return scanError(
				events,
				tornTail,
				"identity_mismatch",
					"event authority, tenant, or stream does not match the store",
				line,
				lineStart,
			);
		}
		if (event.sequence !== events.length || event.previousEventHash !== previousHash) {
			return scanError(
				events,
				tornTail,
				"sequence_conflict",
				"event sequence or previous hash is discontinuous",
				line,
				lineStart,
			);
		}
		if (
			event.payloadDigest !== computeRuntimeEventPayloadDigest(event.payload) ||
			event.currentEventHash !== computeRuntimeEventHash(event)
		) {
			return scanError(
				events,
				tornTail,
				"hash_mismatch",
				"payload or event hash does not match canonical content",
				line,
				lineStart,
			);
		}

		events.push(event);
		previousHash = event.currentEventHash;
		line += 1;
		lineStart = offset + 1;
	}

	if (tornTail) {
		return scanError(
			events,
			true,
			"torn_tail",
			"event log does not end with LF",
			line,
			lineStart,
		);
	}
	return { events, tornTail: false };
}

class JsonlSubscription implements AsyncIterableIterator<RuntimeEventV3> {
	private readonly buffered: RuntimeEventV3[] = [];
	private readonly waiters: Array<(result: IteratorResult<RuntimeEventV3>) => void> = [];
	private readonly onClose: (subscription: JsonlSubscription) => void;
	private ended = false;

	public constructor(onClose: (subscription: JsonlSubscription) => void) {
		this.onClose = onClose;
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<RuntimeEventV3> {
		return this;
	}

	public push(event: RuntimeEventV3): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ done: false, value: event });
		else this.buffered.push(event);
	}

	public next(): Promise<IteratorResult<RuntimeEventV3>> {
		const event = this.buffered.shift();
		if (event) return Promise.resolve({ done: false, value: event });
		if (this.ended) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	public return(): Promise<IteratorResult<RuntimeEventV3>> {
		this.close();
		return Promise.resolve({ done: true, value: undefined });
	}

	public close(): void {
		if (this.ended) return;
		this.ended = true;
		this.onClose(this);
		for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
	}
}

export class JsonlV3EventStore implements RuntimeEventStore {
	private readonly filePath: string;
	private readonly authorityId: AuthorityId;
	private readonly tenantId: TenantId;
	private readonly stream: RuntimeEventStreamRef;
	private readonly validateFence: WriterFenceValidator;
	private readonly onWritePhase: JsonlV3EventStoreOptions["onWritePhase"];
	private readonly handle: FileHandle;
	private readonly subscriptions = new Set<JsonlSubscription>();
	private eventLog: RuntimeEventV3[] = [];
	private lastDurableSequence = -1;
	private terminalError: SessionKernelError | undefined;
	private lifecycle: StoreLifecycle = "open";
	private queue: Promise<void> = Promise.resolve();
	private closePromise: Promise<SessionResult<void>> | undefined;

	private constructor(options: JsonlV3EventStoreOptions, handle: FileHandle) {
		this.filePath = options.filePath;
		this.authorityId = options.authorityId;
		this.tenantId = options.tenantId;
		this.stream = options.stream;
		this.validateFence = options.validateFence;
		this.onWritePhase = options.onWritePhase;
		this.handle = handle;
	}

	public streamRef(): RuntimeEventStreamRef {
		return { ...this.stream };
	}

	public static create(options: JsonlV3EventStoreOptions): Promise<SessionResult<JsonlV3EventStore>> {
		return JsonlV3EventStore.initialize(options, true);
	}

	public static open(options: JsonlV3EventStoreOptions): Promise<SessionResult<JsonlV3EventStore>> {
		return JsonlV3EventStore.initialize(options, false);
	}

	private static async initialize(
		options: JsonlV3EventStoreOptions,
		create: boolean,
	): Promise<SessionResult<JsonlV3EventStore>> {
		let handle: FileHandle | undefined;
		try {
			if (create) await mkdir(dirname(options.filePath), { recursive: true, mode: DIRECTORY_MODE });
			const flags = create
				? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND
				: constants.O_RDWR | constants.O_APPEND;
			handle = await open(options.filePath, flags, FILE_MODE);
			const fileStat = await handle.stat();
			if (!fileStat.isFile()) {
				await handle.close();
				return fail("durable_write_failed", "event store path is not a regular file");
			}
			if (create) {
				await handle.chmod(FILE_MODE);
				await options.onWritePhase?.("before_create_sync");
				await syncDirectory(dirname(options.filePath));
			}

			const store = new JsonlV3EventStore(options, handle);
			const snapshot = await store.readDiskSnapshot();
			if (!snapshot.ok) {
				await handle.close().catch(() => undefined);
				return { ok: false, error: snapshot.error };
			}
			const verification = verifyRuntimeEventChain(snapshot.value.events, store.scope());
			if (verification.integrity === "corrupted") {
				await handle.close().catch(() => undefined);
				return {
					ok: false,
					error: verification.error ?? {
						code: "corrupted_log",
						message: "event log projection is invalid",
						retryable: false,
					},
				};
			}
			if (store.stream.scope === "authority_tenant") {
				const projection = reduceAuthorityLifecycleEvents(snapshot.value.events, {
					authorityId: options.authorityId,
					tenantId: options.tenantId,
					stream: store.stream,
				});
				if (!projection.ok) {
					await handle.close().catch(() => undefined);
					return projection;
				}
			}
			store.eventLog = snapshot.value.events;
			store.lastDurableSequence = snapshot.value.events.length - 1;
			return { ok: true, value: store };
		} catch (error) {
			if (handle) await handle.close().catch(() => undefined);
			return unexpectedFailure(create ? "failed to create event store" : "failed to open event store", error);
		}
	}

	public append(
		stream: RuntimeEventStreamRef,
		event: RuntimeEventV3,
		expected: ExpectedRevision | null,
		fence: WriterFence,
	): Promise<SessionResult<AcceptedEventCursor>> {
		if (this.lifecycle !== "open") return Promise.resolve(fail("store_closed", "event store is closed"));
		return this.serialize(() => this.appendOne(stream, event, expected, fence), "event append failed");
	}

	private async appendOne(
		stream: RuntimeEventStreamRef,
		event: RuntimeEventV3,
		expected: ExpectedRevision | null,
		fence: WriterFence,
	): Promise<SessionResult<AcceptedEventCursor>> {
		if (this.terminalError) return { ok: false, error: this.terminalError };
		if (!sameRuntimeEventStream(stream, this.stream)) return fail("identity_mismatch", "append stream does not match store");
		if (!(await this.fenceIsCurrent(fence))) {
			return fail("writer_fenced", "writer fence is not current");
		}
		if (expected !== null && !isExpectedRevision(expected)) {
			return fail("invalid_event", "expected revision is invalid");
		}

		let validation: ReturnType<typeof validateRuntimeEvent>;
		try {
			validation = validateRuntimeEvent(event);
		} catch {
			return fail("invalid_event", "event could not be validated");
		}
		if (!validation.ok) return validationFailure(validation);

		const snapshot = await this.readDiskSnapshot();
		if (!snapshot.ok) return snapshot;
		const current = snapshot.value.events.at(-1);
		if (!current && expected !== null) {
			return fail("sequence_conflict", "genesis append requires an empty expected revision");
		}
		if (
			current &&
			(!expected ||
					!sameRuntimeEventStream(expected.stream, current.stream) ||
				expected.sequence !== current.sequence ||
				expected.eventHash !== current.currentEventHash)
		) {
			return fail("sequence_conflict", "expected revision does not match the durable head");
		}

		const candidateLog = [...snapshot.value.events, validation.value];
		const verification = verifyRuntimeEventChain(candidateLog, this.scope());
		if (verification.integrity === "corrupted") {
			return {
				ok: false,
				error: verification.error ?? {
					code: "invalid_event",
					message: "event does not extend the durable chain",
					retryable: false,
				},
			};
		}
		if (this.stream.scope === "session") {
			const projection = reduceSessionEvents(candidateLog);
			if (!projection.ok) return projection;
		} else {
			const projection = reduceAuthorityLifecycleEvents(candidateLog, {
				authorityId: this.authorityId,
				tenantId: this.tenantId,
				stream: this.stream,
			});
			if (!projection.ok) return projection;
		}

		let encoded: Buffer;
		try {
			encoded = Buffer.from(`${canonicalJson(validation.value)}\n`, "utf8");
		} catch {
			return fail("invalid_event", "event is not canonical JSON");
		}
		const currentStat = await this.safeStat();
		if (!currentStat.ok) return currentStat;
		if (currentStat.value !== snapshot.value.byteLength) {
			return fail("sequence_conflict", "event log changed while append was being validated", true);
		}

		let wroteAnyBytes = false;
		try {
			await this.onWritePhase?.("before_event_write");
			let offset = 0;
			while (offset < encoded.byteLength) {
				const write = await this.handle.write(encoded, offset, encoded.byteLength - offset, null);
				if (write.bytesWritten < 1) throw new Error("zero-byte append");
				wroteAnyBytes = true;
				offset += write.bytesWritten;
			}
			await this.onWritePhase?.("after_event_write_before_sync");
		} catch (error) {
			const failed = unexpectedFailure<AcceptedEventCursor>(
				"event append was not accepted completely",
				error,
				wroteAnyBytes ? "uncertain" : "none",
			);
			if (!failed.ok) this.terminalError = failed.error;
			return failed;
		}

		this.eventLog = candidateLog;
		const cursor: AcceptedEventCursor = {
			stream: validation.value.stream,
			sequence: validation.value.sequence,
			eventId: validation.value.eventId,
			eventHash: validation.value.currentEventHash,
			writerEpoch: fence.writerEpoch,
		};
		return { ok: true, value: cursor };
	}

	public flushThrough(
		stream: RuntimeEventStreamRef,
		cursor: AcceptedEventCursor,
		fence: WriterFence,
	): Promise<SessionResult<DurableEventReceipt>> {
		if (this.lifecycle !== "open") return Promise.resolve(fail("store_closed", "event store is closed"));
		return this.serialize(() => this.flushOne(stream, cursor, fence), "event store flush failed");
	}

	private async flushOne(
		stream: RuntimeEventStreamRef,
		cursor: AcceptedEventCursor,
		fence: WriterFence,
	): Promise<SessionResult<DurableEventReceipt>> {
		if (this.terminalError) return { ok: false, error: this.terminalError };
		if (
			!sameRuntimeEventStream(stream, this.stream) ||
			!sameRuntimeEventStream(cursor.stream, this.stream) ||
			cursor.writerEpoch !== fence.writerEpoch ||
			!(await this.fenceIsCurrent(fence))
		) return fail("writer_fenced", "flush cursor or writer fence is not current");
		const accepted = this.eventLog[cursor.sequence];
		if (!accepted || accepted.eventId !== cursor.eventId || accepted.currentEventHash !== cursor.eventHash) {
			return fail("sequence_conflict", "flush cursor is not accepted by this stream");
		}
		try {
			await this.onWritePhase?.("before_event_sync");
			await this.onWritePhase?.("before_flush_sync");
			await this.handle.sync();
			await this.onWritePhase?.("after_flush_sync_before_receipt");
			const previousDurableSequence = this.lastDurableSequence;
			this.lastDurableSequence = this.eventLog.length - 1;
			for (let sequence = previousDurableSequence + 1; sequence <= this.lastDurableSequence; sequence += 1) {
				const event = this.eventLog[sequence];
				if (event) for (const subscription of this.subscriptions) subscription.push(event);
			}
			return {
				ok: true,
				value: {
					streamScope: stream.scope,
					streamId: stream.streamId,
					cursor: { stream, sequence: cursor.sequence, eventId: cursor.eventId, eventHash: cursor.eventHash },
					sequence: cursor.sequence,
					eventHash: cursor.eventHash,
					writerEpoch: fence.writerEpoch,
					durableAt: new Date().toISOString(),
				},
			};
		} catch (error) {
			const failed = unexpectedFailure<DurableEventReceipt>("event store flush failed without a receipt", error, "uncertain");
			if (!failed.ok) this.terminalError = failed.error;
			return failed;
		}
	}

	public readPage(stream: RuntimeEventStreamRef, query: EventPageQuery): Promise<SessionResult<EventPage>> {
		if (this.lifecycle !== "open") return Promise.resolve(fail("store_closed", "event store is closed"));
		if (!sameRuntimeEventStream(stream, this.stream)) return Promise.resolve(fail("identity_mismatch", "stream does not match store"));
		if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
			return Promise.resolve(fail("invalid_event", "page limit must be between 1 and 1000"));
		}
		const start = query.afterSequence === undefined ? 0 : query.afterSequence + 1;
		if (!Number.isInteger(start) || start < 0) {
			return Promise.resolve(fail("invalid_event", "afterSequence is invalid"));
		}
		return this.serialize(async () => {
			const snapshot = await this.readDiskSnapshot();
			if (!snapshot.ok) return snapshot;
			this.eventLog = snapshot.value.events;
			const durableEvents = snapshot.value.events.slice(0, this.lastDurableSequence + 1);
			const events = durableEvents.slice(start, start + query.limit);
			const last = events.at(-1);
			return {
				ok: true,
				value: {
					events,
					hasMore: start + events.length < durableEvents.length,
					...(last
						? {
								nextCursor: {
								stream: last.stream,
									sequence: last.sequence,
									eventId: last.eventId,
									eventHash: last.currentEventHash,
								},
							}
						: {}),
				},
			};
		}, "event store read failed");
	}

	public verify(stream: RuntimeEventStreamRef): Promise<SessionResult<EventLogVerification>> {
		if (this.lifecycle !== "open") return Promise.resolve(fail("store_closed", "event store is closed"));
		if (!sameRuntimeEventStream(stream, this.stream)) return Promise.resolve(fail("identity_mismatch", "stream does not match store"));
		return this.serialize(async () => {
			const snapshot = await this.readDiskSnapshot();
			if (snapshot.ok) {
				this.eventLog = snapshot.value.events;
				return {
					ok: true,
					value: verifyRuntimeEventChain(snapshot.value.events, this.scope()),
				};
			}
			if (!isContentFailure(snapshot.error.code)) return snapshot;
			return { ok: true, value: this.corruptedVerification(snapshot.error) };
		}, "event store verification failed");
	}

	public subscribe(stream: RuntimeEventStreamRef, afterSequence = -1): AsyncIterable<RuntimeEventV3> {
		const subscription = new JsonlSubscription((closed) => this.subscriptions.delete(closed));
		if (
			!sameRuntimeEventStream(stream, this.stream) ||
			!Number.isInteger(afterSequence) ||
			afterSequence < -1 ||
			this.lifecycle !== "open"
		) {
			subscription.close();
			return subscription;
		}
		for (const event of this.eventLog.slice(0, this.lastDurableSequence + 1)) {
			if (event.sequence > afterSequence) subscription.push(event);
		}
		this.subscriptions.add(subscription);
		return subscription;
	}

	public close(): Promise<SessionResult<void>> {
		if (this.closePromise) return this.closePromise;
		if (this.lifecycle === "closed") return Promise.resolve({ ok: true, value: undefined });
		this.lifecycle = "closing";
		this.closePromise = this.serialize(() => this.closeOne(), "event store close failed");
		return this.closePromise;
	}

	private async closeOne(): Promise<SessionResult<void>> {
		let failure: SessionKernelError | undefined = this.terminalError;
		try {
			await this.handle.sync();
		} catch (error) {
			const result = unexpectedFailure<void>("event store close sync failed", error);
			if (!result.ok) failure ??= result.error;
		}
		try {
			await this.handle.close();
		} catch (error) {
			const result = unexpectedFailure<void>("event store close failed", error);
			if (!result.ok) failure ??= result.error;
		}
		this.lifecycle = "closed";
		for (const subscription of this.subscriptions) subscription.close();
		this.subscriptions.clear();
		return failure ? { ok: false, error: failure } : { ok: true, value: undefined };
	}

	private async fenceIsCurrent(fence: WriterFence): Promise<boolean> {
		if (
			fence.authorityId !== this.authorityId ||
			fence.tenantId !== this.tenantId ||
			!sameRuntimeEventStream(fence.stream, this.stream)
		) {
			return false;
		}
		try {
			return (await this.validateFence(fence)) === true;
		} catch {
			return false;
		}
	}

	private async readDiskSnapshot(): Promise<SessionResult<DiskSnapshot>> {
		try {
			const initialStat = await this.handle.stat();
			if (!initialStat.isFile()) return fail("corrupted_log", "event store is not a regular file");
			const bytes = Buffer.alloc(initialStat.size);
			let offset = 0;
			while (offset < bytes.byteLength) {
				const read = await this.handle.read(bytes, offset, bytes.byteLength - offset, offset);
				if (read.bytesRead < 1) {
					return fail("torn_tail", "event log ended while it was being read", false, {
						eventCount: 0,
						firstBadSequence: 0,
					});
				}
				offset += read.bytesRead;
			}
			const finalStat = await this.handle.stat();
			if (finalStat.size !== initialStat.size) {
				return fail("sequence_conflict", "event log changed while it was being read", true, {
					eventCount: 0,
					firstBadSequence: 0,
				});
			}
			return this.decodeSnapshot(bytes);
		} catch (error) {
			return unexpectedFailure("failed to read event store", error);
		}
	}

	private decodeSnapshot(bytes: Buffer): SessionResult<DiskSnapshot> {
		const scan = scanJsonlV3EventLog(bytes, this.scope());
		if (!scan.firstError) {
			return { ok: true, value: { events: [...scan.events], byteLength: bytes.byteLength } };
		}
		return fail(scan.firstError.code, scan.firstError.message, false, {
			eventCount: scan.events.length,
			firstBadSequence: scan.firstError.line,
			byteOffset: scan.firstError.byteOffset,
			tornTail: scan.tornTail,
		});
	}

	private corruptedVerification(error: SessionKernelError): EventLogVerification {
		const eventCount =
			typeof error.details?.eventCount === "number" ? error.details.eventCount : 0;
		const firstBadSequence =
			typeof error.details?.firstBadSequence === "number"
				? error.details.firstBadSequence
				: eventCount;
		return {
			...this.scope(),
			integrity: "corrupted",
			attestation: "unattested",
			eventCount,
			firstBadSequence,
			error,
		};
	}

	private async safeStat(): Promise<SessionResult<number>> {
		try {
			const fileStat = await this.handle.stat();
			if (!fileStat.isFile()) return fail("corrupted_log", "event store is not a regular file");
			return { ok: true, value: fileStat.size };
		} catch (error) {
			return unexpectedFailure("failed to inspect event store", error);
		}
	}

	private scope(): JsonlV3EventLogScope {
		return {
			authorityId: this.authorityId,
			tenantId: this.tenantId,
			stream: this.stream,
		};
	}

	private serialize<T>(
		operation: () => Promise<SessionResult<T>>,
		failureMessage: string,
	): Promise<SessionResult<T>> {
		const scheduled = this.queue.then(async () => {
			try {
				return await operation();
			} catch (error) {
				return unexpectedFailure<T>(failureMessage, error);
			}
		});
		this.queue = scheduled.then(() => undefined);
		return scheduled;
	}
}
