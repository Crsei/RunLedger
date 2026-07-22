/** at-least-once event delivery、bounded client buffer 与 atomic projection checkpoint。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { EventId, SessionId } from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import { ControlPlaneError, type ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type { SessionHandleValidationPort } from "./query-service.ts";
import type {
	ControlPlaneRequestContext,
	EventSubscriptionRequest,
	StableEventDelivery,
} from "./types.ts";
import { validateEventSubscriptionRequest } from "./types.ts";

export interface EventSourceRecord {
	event: RuntimeEventV3;
	origin: "replay" | "live";
}

export interface EventSubscriptionSourcePort {
	/** afterSequence 是 exclusive；实现必须无缝衔接 backlog 与 live stream。 */
	subscribe(sessionId: SessionId, afterSequence: number, signal: AbortSignal): AsyncIterable<EventSourceRecord>;
}

interface PendingNext {
	resolve(result: IteratorResult<StableEventDelivery>): void;
	reject(error: Error): void;
}

export class BoundedEventSubscription implements AsyncIterableIterator<StableEventDelivery> {
	readonly #request: EventSubscriptionRequest;
	readonly #source: EventSubscriptionSourcePort;
	readonly #controller = new AbortController();
	readonly #buffer: StableEventDelivery[] = [];
	readonly #waiters: PendingNext[] = [];
	#closed = false;
	#terminalError: ControlPlaneError | undefined;
	#last: EventCursor | null;
	#first = true;
	readonly #pump: Promise<void>;

	public constructor(request: EventSubscriptionRequest, source: EventSubscriptionSourcePort) {
		this.#request = request;
		this.#source = source;
		this.#last = request.fromCursor;
		// 重连时从前一个 sequence 开始，允许稳定 cursor 对应事件再次投递。
		const afterSequence = request.fromCursor ? Math.max(-1, request.fromCursor.sequence - 1) : -1;
		this.#pump = this.#run(afterSequence);
		this.#pump.catch(() => undefined);
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<StableEventDelivery> {
		return this;
	}

	public next(): Promise<IteratorResult<StableEventDelivery>> {
		const buffered = this.#buffer.shift();
		if (buffered) return Promise.resolve({ done: false, value: buffered });
		if (this.#terminalError) return Promise.reject(this.#terminalError);
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
	}

	public async return(): Promise<IteratorResult<StableEventDelivery>> {
		this.#finish();
		await this.#pump;
		return { done: true, value: undefined };
	}

	public close(): void {
		this.#finish();
	}

	async #run(afterSequence: number): Promise<void> {
		try {
			for await (const record of this.#source.subscribe(this.#request.sessionId, afterSequence, this.#controller.signal)) {
				if (this.#closed) break;
				const checked = this.#validateRecord(record);
				if (!checked.ok) {
					this.#fail(new ControlPlaneError(checked.error));
					return;
				}
				const delivery = checked.value;
				const waiter = this.#waiters.shift();
				if (waiter) waiter.resolve({ done: false, value: delivery });
				else if (this.#buffer.length >= this.#request.bufferCapacity) {
					this.#fail(
						new ControlPlaneError({
							code: "slow_consumer",
							message: "subscription buffer capacity was exceeded; reconnect from the last acknowledged cursor",
							retryable: true,
							details: { bufferCapacity: this.#request.bufferCapacity },
						}),
					);
					return;
				} else this.#buffer.push(delivery);
			}
			this.#finish();
		} catch (error) {
			if (this.#closed && this.#controller.signal.aborted) return;
			this.#fail(
				error instanceof ControlPlaneError
					? error
					: new ControlPlaneError({
							code: "adapter_unavailable",
							message: "event subscription source failed",
							retryable: true,
							details: { errorName: error instanceof Error ? error.name : "UnknownError" },
						}),
			);
		}
	}

	#validateRecord(record: EventSourceRecord): ControlPlaneResult<StableEventDelivery> {
		const validated = validateRuntimeEvent(record.event);
		if (!validated.ok) return controlPlaneFailure("adapter_contract_violation", "event source returned an invalid v3 event");
		const event = validated.value;
		if (event.stream.scope !== "session" || event.stream.sessionId !== this.#request.sessionId) {
			return controlPlaneFailure("cursor_mismatch", "event source crossed a session boundary");
		}
		if (this.#first && this.#request.fromCursor) {
			this.#first = false;
			if (
				event.sequence !== this.#request.fromCursor.sequence ||
				event.eventId !== this.#request.fromCursor.eventId ||
				event.currentEventHash !== this.#request.fromCursor.eventHash
			) return controlPlaneFailure("cursor_mismatch", "replay did not reproduce the requested stable cursor");
		} else {
			this.#first = false;
			const expectedSequence = this.#last ? this.#last.sequence + 1 : 0;
			if (event.sequence === this.#last?.sequence && event.eventId === this.#last.eventId) {
				// source 允许重复同一 event；client 仍按 eventId 去重。
			} else if (event.sequence !== expectedSequence) {
				return controlPlaneFailure("cursor_mismatch", "event source produced a sequence gap or divergent duplicate", false, {
					expectedSequence,
					actualSequence: event.sequence,
				});
			}
		}
		const cursor: EventCursor = {
			stream: event.stream,
			sequence: event.sequence,
			eventId: event.eventId,
			eventHash: event.currentEventHash,
		};
		this.#last = cursor;
		return {
			ok: true,
			value: {
				subscriptionId: this.#request.subscriptionId,
				delivery: record.origin,
				eventId: event.eventId,
				sequence: event.sequence,
				cursor,
				event,
			},
		};
	}

	#finish(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort();
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	#fail(error: ControlPlaneError): void {
		if (this.#closed) return;
		this.#terminalError = error;
		this.#buffer.splice(0);
		this.#closed = true;
		this.#controller.abort(error);
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

export interface EventSubscriptionServiceOptions {
	source: EventSubscriptionSourcePort;
	handles: SessionHandleValidationPort;
}

export class EventSubscriptionService {
	readonly #source: EventSubscriptionSourcePort;
	readonly #handles: SessionHandleValidationPort;

	public constructor(options: EventSubscriptionServiceOptions) {
		this.#source = options.source;
		this.#handles = options.handles;
	}

	public open(input: unknown, _context: ControlPlaneRequestContext): ControlPlaneResult<BoundedEventSubscription> {
		const validated = validateEventSubscriptionRequest(input);
		if (!validated.ok) return { ok: false, error: validated.error, effect: "none" };
		const current = this.#handles.validate(validated.value.sessionHandle);
		if (!current.ok) return current;
		return { ok: true, value: new BoundedEventSubscription(validated.value, this.#source) };
	}
}

/** 普通轻客户端使用的 bounded eventId 去重器。 */
export class EventIdDedupe {
	readonly #capacity: number;
	readonly #seen = new Set<EventId>();
	readonly #order: EventId[] = [];

	public constructor(capacity = 4096) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("event dedupe capacity must be positive");
		this.#capacity = capacity;
	}

	public accept(eventId: EventId): boolean {
		if (this.#seen.has(eventId)) return false;
		this.#seen.add(eventId);
		this.#order.push(eventId);
		while (this.#order.length > this.#capacity) {
			const removed = this.#order.shift();
			if (removed) this.#seen.delete(removed);
		}
		return true;
	}
}

export interface DurableConsumerCheckpoint<TState> {
	consumerId: string;
	sessionId: SessionId;
	revision: number;
	cursor: EventCursor | null;
	projection: TState;
	projectionDigest: string;
}

export interface ProjectionCheckpointMutation<TState> {
	consumerId: string;
	sessionId: SessionId;
	expectedRevision: number;
	expectedCursor: EventCursor | null;
	event: RuntimeEventV3;
	nextProjection: TState;
	nextProjectionDigest: string;
}

export type ProjectionCheckpointOutcome<TState> =
	| { status: "committed"; checkpoint: DurableConsumerCheckpoint<TState> }
	| { status: "duplicate"; checkpoint: DurableConsumerCheckpoint<TState> }
	| { status: "conflict"; actualRevision: number };

/** applyAndCheckpoint 必须在一个 durable transaction/CAS 中更新 projection 与 cursor。 */
export interface DurableProjectionCheckpointStore<TState> {
	load(consumerId: string, sessionId: SessionId): Promise<ControlPlaneResult<DurableConsumerCheckpoint<TState>>>;
	applyAndCheckpoint(
		mutation: ProjectionCheckpointMutation<TState>,
	): Promise<ControlPlaneResult<ProjectionCheckpointOutcome<TState>>>;
}

export class InMemoryDurableProjectionCheckpointStore<TState> implements DurableProjectionCheckpointStore<TState> {
	readonly #states = new Map<string, DurableConsumerCheckpoint<TState>>();
	readonly #initial: (consumerId: string, sessionId: SessionId) => TState;
	#serial: Promise<void> = Promise.resolve();

	public constructor(initial: (consumerId: string, sessionId: SessionId) => TState) {
		this.#initial = initial;
	}

	#key(consumerId: string, sessionId: SessionId): string {
		return `${consumerId}/${sessionId}`;
	}

	#exclusive<T>(operation: () => ControlPlaneResult<T>): Promise<ControlPlaneResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#current(consumerId: string, sessionId: SessionId): DurableConsumerCheckpoint<TState> {
		const key = this.#key(consumerId, sessionId);
		const existing = this.#states.get(key);
		if (existing) return existing;
		const projection = this.#initial(consumerId, sessionId);
		const initial: DurableConsumerCheckpoint<TState> = {
			consumerId,
			sessionId,
			revision: 0,
			cursor: null,
			projection,
			projectionDigest: canonicalDigest(projection),
		};
		this.#states.set(key, initial);
		return initial;
	}

	public load(consumerId: string, sessionId: SessionId): Promise<ControlPlaneResult<DurableConsumerCheckpoint<TState>>> {
		return this.#exclusive(() => ({ ok: true, value: this.#current(consumerId, sessionId) }));
	}

	public applyAndCheckpoint(
		mutation: ProjectionCheckpointMutation<TState>,
	): Promise<ControlPlaneResult<ProjectionCheckpointOutcome<TState>>> {
		return this.#exclusive<ProjectionCheckpointOutcome<TState>>(() => {
			const current = this.#current(mutation.consumerId, mutation.sessionId);
			if (
				current.cursor &&
				mutation.event.sequence === current.cursor.sequence &&
				mutation.event.eventId === current.cursor.eventId &&
				mutation.event.currentEventHash === current.cursor.eventHash
			) return { ok: true, value: { status: "duplicate", checkpoint: current } };
			if (mutation.expectedRevision !== current.revision || !sameCursor(mutation.expectedCursor, current.cursor)) {
				return { ok: true, value: { status: "conflict", actualRevision: current.revision } };
			}
			const expectedSequence = current.cursor ? current.cursor.sequence + 1 : 0;
			if (
				mutation.event.stream.scope !== "session" ||
				mutation.event.stream.sessionId !== mutation.sessionId ||
				mutation.event.sequence !== expectedSequence
			) {
				return controlPlaneFailure("cursor_mismatch", "projection checkpoint event is not the next session event");
			}
			if (canonicalDigest(mutation.nextProjection) !== mutation.nextProjectionDigest) {
				return controlPlaneFailure("adapter_contract_violation", "projection digest does not match next state");
			}
			const checkpoint: DurableConsumerCheckpoint<TState> = {
				consumerId: mutation.consumerId,
				sessionId: mutation.sessionId,
				revision: current.revision + 1,
				cursor: {
					stream: mutation.event.stream,
					sequence: mutation.event.sequence,
					eventId: mutation.event.eventId,
					eventHash: mutation.event.currentEventHash,
				},
				projection: mutation.nextProjection,
				projectionDigest: mutation.nextProjectionDigest,
			};
			this.#states.set(this.#key(mutation.consumerId, mutation.sessionId), checkpoint);
			return { ok: true, value: { status: "committed", checkpoint } };
		});
	}
}

function sameCursor(left: EventCursor | null, right: EventCursor | null): boolean {
	if (!left || !right) return left === right;
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash
	);
}

export type ProjectionFunction<TState> = (state: TState, event: RuntimeEventV3) => TState;

export class DurableProjectionConsumer<TState> {
	readonly #consumerId: string;
	readonly #sessionId: SessionId;
	readonly #store: DurableProjectionCheckpointStore<TState>;
	readonly #project: ProjectionFunction<TState>;

	public constructor(options: {
		consumerId: string;
		sessionId: SessionId;
		store: DurableProjectionCheckpointStore<TState>;
		project: ProjectionFunction<TState>;
	}) {
		this.#consumerId = options.consumerId;
		this.#sessionId = options.sessionId;
		this.#store = options.store;
		this.#project = options.project;
	}

	public async process(event: RuntimeEventV3): Promise<ControlPlaneResult<"applied" | "duplicate">> {
		const validated = validateRuntimeEvent(event);
		if (
			!validated.ok ||
			validated.value.stream.scope !== "session" ||
			validated.value.stream.sessionId !== this.#sessionId
		) {
			return controlPlaneFailure("cursor_mismatch", "projection consumer event is invalid or crossed a session boundary");
		}
		event = validated.value;
		for (let attempt = 0; attempt < 32; attempt += 1) {
			const current = await this.#store.load(this.#consumerId, this.#sessionId);
			if (!current.ok) return current;
			if (
				current.value.cursor &&
				event.sequence === current.value.cursor.sequence &&
				event.eventId === current.value.cursor.eventId &&
				event.currentEventHash === current.value.cursor.eventHash
			) return { ok: true, value: "duplicate" };
			let next: TState;
			try {
				next = this.#project(current.value.projection, event);
			} catch (error) {
				return controlPlaneFailure("adapter_contract_violation", "projection function failed", false, {
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
			}
			const applied = await this.#store.applyAndCheckpoint({
				consumerId: this.#consumerId,
				sessionId: this.#sessionId,
				expectedRevision: current.value.revision,
				expectedCursor: current.value.cursor,
				event,
				nextProjection: next,
				nextProjectionDigest: canonicalDigest(next),
			});
			if (!applied.ok) return applied;
			if (applied.value.status === "conflict") continue;
			return { ok: true, value: applied.value.status === "duplicate" ? "duplicate" : "applied" };
		}
		return controlPlaneFailure("checkpoint_conflict", "projection checkpoint CAS did not converge", true);
	}
}

export interface DurableProjectionPumpResult {
	applied: number;
	duplicates: number;
	cursor: EventCursor | null;
}

/**
 * 从 durable checkpoint 的 exclusive cursor 继续消费。source 可 at-least-once 重投，
 * 但 projection 与 cursor 仍由 store 的单次 CAS/transaction 原子提交。
 */
export class DurableProjectionPump<TState> {
	readonly #consumerId: string;
	readonly #sessionId: SessionId;
	readonly #store: DurableProjectionCheckpointStore<TState>;
	readonly #source: EventSubscriptionSourcePort;
	readonly #consumer: DurableProjectionConsumer<TState>;

	public constructor(options: {
		consumerId: string;
		sessionId: SessionId;
		store: DurableProjectionCheckpointStore<TState>;
		source: EventSubscriptionSourcePort;
		project: ProjectionFunction<TState>;
	}) {
		this.#consumerId = options.consumerId;
		this.#sessionId = options.sessionId;
		this.#store = options.store;
		this.#source = options.source;
		this.#consumer = new DurableProjectionConsumer({
			consumerId: options.consumerId,
			sessionId: options.sessionId,
			store: options.store,
			project: options.project,
		});
	}

	public async run(signal?: AbortSignal): Promise<ControlPlaneResult<DurableProjectionPumpResult>> {
		const initial = await this.#store.load(this.#consumerId, this.#sessionId);
		if (!initial.ok) return initial;
		let applied = 0;
		let duplicates = 0;
		const controller = signal ? undefined : new AbortController();
		const activeSignal = signal ?? controller?.signal;
		if (!activeSignal) return controlPlaneFailure("internal_error", "projection pump signal initialization failed");
		try {
			for await (const record of this.#source.subscribe(
				this.#sessionId,
				initial.value.cursor?.sequence ?? -1,
				activeSignal,
			)) {
				if (activeSignal.aborted) break;
				const processed = await this.#consumer.process(record.event);
				if (!processed.ok) return processed;
				if (processed.value === "applied") applied += 1;
				else duplicates += 1;
			}
		} catch (error) {
			if (activeSignal.aborted) {
				const checkpoint = await this.#store.load(this.#consumerId, this.#sessionId);
				return checkpoint.ok
					? { ok: true, value: { applied, duplicates, cursor: checkpoint.value.cursor } }
					: checkpoint;
			}
			if (error instanceof ControlPlaneError) return { ok: false, error, effect: "none" };
			return controlPlaneFailure("adapter_unavailable", "projection event source failed", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
		const checkpoint = await this.#store.load(this.#consumerId, this.#sessionId);
		return checkpoint.ok
			? { ok: true, value: { applied, duplicates, cursor: checkpoint.value.cursor } }
			: checkpoint;
	}
}
