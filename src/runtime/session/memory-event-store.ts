/** RuntimeEventStore 的严格内存合同实现，供 reducer/adapter contract tests 使用。 */

import {
	sameRuntimeEventStream,
	type ExpectedRevision,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type { AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import { reduceAuthorityLifecycleEvents } from "./authority-lifecycle-projection.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import { reduceSessionEvents } from "./reducer.ts";
import type { RuntimeEventStore, WriterFenceValidator } from "./event-store.ts";
import type {
	AcceptedEventCursor,
	DurableEventReceipt,
	EventLogVerification,
	EventPage,
	EventPageQuery,
	SessionResult,
	WriterFence,
} from "./types.ts";

function fail<T>(
	code: "invalid_event" | "sequence_conflict" | "identity_mismatch" | "writer_fenced" | "store_closed",
	message: string,
): SessionResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

class MemorySubscription implements AsyncIterableIterator<RuntimeEventV3> {
	private readonly buffered: RuntimeEventV3[] = [];
	private readonly waiters: Array<(result: IteratorResult<RuntimeEventV3>) => void> = [];
	private ended = false;

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
		for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
	}
}

export interface MemoryEventStoreOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
	validateFence: WriterFenceValidator;
	clock?: () => Date;
}

export class MemoryEventStore implements RuntimeEventStore {
	private readonly authorityId: AuthorityId;
	private readonly tenantId: TenantId;
	private readonly stream: RuntimeEventStreamRef;
	private readonly validateFence: WriterFenceValidator;
	private readonly clock: () => Date;
	private readonly eventLog: RuntimeEventV3[] = [];
	private readonly subscriptions = new Set<MemorySubscription>();
	private lastAcceptedCursor: AcceptedEventCursor | undefined;
	private publishedThroughSequence = -1;
	private closed = false;

	public constructor(options: MemoryEventStoreOptions) {
		this.authorityId = options.authorityId;
		this.tenantId = options.tenantId;
		this.stream = options.stream;
		this.validateFence = options.validateFence;
		this.clock = options.clock ?? (() => new Date());
	}

	public streamRef(): RuntimeEventStreamRef {
		return { ...this.stream };
	}

	public async append(
		stream: RuntimeEventStreamRef,
		event: RuntimeEventV3,
		expected: ExpectedRevision | null,
		fence: WriterFence,
	): Promise<SessionResult<AcceptedEventCursor>> {
		if (this.closed) return fail("store_closed", "event store is closed");
		if (
			!sameRuntimeEventStream(stream, this.stream) ||
			fence.authorityId !== this.authorityId ||
			fence.tenantId !== this.tenantId ||
			!sameRuntimeEventStream(fence.stream, this.stream) ||
			!(await this.validateFence(fence))
		) {
			return fail("writer_fenced", "writer fence is not current");
		}
		const current = this.eventLog.at(-1);
		if (!current && expected !== null) return fail("sequence_conflict", "genesis append requires an empty expected revision");
		if (
			current &&
			(!expected ||
					!sameRuntimeEventStream(expected.stream, current.stream) ||
				expected.sequence !== current.sequence ||
				expected.eventHash !== current.currentEventHash)
		) {
			return fail("sequence_conflict", "expected revision does not match the durable head");
		}

		const verification = verifyRuntimeEventChain([...this.eventLog, event], {
			authorityId: this.authorityId,
			tenantId: this.tenantId,
			stream: this.stream,
		});
		if (verification.integrity === "corrupted") {
			return { ok: false, error: verification.error ?? { code: "invalid_event", message: "invalid event", retryable: false } };
		}
		if (this.stream.scope === "session") {
			const projection = reduceSessionEvents([...this.eventLog, event]);
			if (!projection.ok) return projection;
		} else {
			const projection = reduceAuthorityLifecycleEvents([...this.eventLog, event], {
				authorityId: this.authorityId,
				tenantId: this.tenantId,
				stream: this.stream,
			});
			if (!projection.ok) return projection;
		}

		this.eventLog.push(event);
		const cursor: AcceptedEventCursor = {
			stream: event.stream,
			sequence: event.sequence,
			eventId: event.eventId,
			eventHash: event.currentEventHash,
			writerEpoch: fence.writerEpoch,
		};
		this.lastAcceptedCursor = cursor;
		return { ok: true, value: cursor };
	}

	public async flushThrough(
		stream: RuntimeEventStreamRef,
		cursor: AcceptedEventCursor,
		fence: WriterFence,
	): Promise<SessionResult<DurableEventReceipt>> {
		if (this.closed) return fail("store_closed", "event store is closed");
		if (
			!sameRuntimeEventStream(stream, this.stream) ||
			!sameRuntimeEventStream(cursor.stream, this.stream) ||
			!sameRuntimeEventStream(fence.stream, this.stream) ||
			cursor.writerEpoch !== fence.writerEpoch ||
			!(await this.validateFence(fence))
		) return fail("writer_fenced", "flush cursor or writer fence is not current");
		const event = this.eventLog[cursor.sequence];
		if (!event || event.eventId !== cursor.eventId || event.currentEventHash !== cursor.eventHash) {
			return fail("sequence_conflict", "flush cursor is not accepted by this stream");
		}
		for (let sequence = this.publishedThroughSequence + 1; sequence <= cursor.sequence; sequence += 1) {
			const durableEvent = this.eventLog[sequence];
			if (!durableEvent) return fail("sequence_conflict", "flush range is not contiguous");
			for (const subscription of this.subscriptions) subscription.push(durableEvent);
		}
		this.publishedThroughSequence = Math.max(this.publishedThroughSequence, cursor.sequence);
		return {
			ok: true,
			value: {
				streamScope: stream.scope,
				streamId: stream.streamId,
				cursor: { stream, sequence: cursor.sequence, eventId: cursor.eventId, eventHash: cursor.eventHash },
				sequence: cursor.sequence,
				eventHash: cursor.eventHash,
				writerEpoch: fence.writerEpoch,
				durableAt: this.clock().toISOString(),
			},
		};
	}

	public readPage(stream: RuntimeEventStreamRef, query: EventPageQuery): Promise<SessionResult<EventPage>> {
		if (this.closed) return Promise.resolve(fail("store_closed", "event store is closed"));
		if (!sameRuntimeEventStream(stream, this.stream)) return Promise.resolve(fail("identity_mismatch", "stream does not match store"));
		if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
			return Promise.resolve(fail("invalid_event", "page limit must be between 1 and 1000"));
		}
		const start = query.afterSequence === undefined ? 0 : query.afterSequence + 1;
		if (!Number.isInteger(start) || start < 0) return Promise.resolve(fail("invalid_event", "afterSequence is invalid"));
		const events = this.eventLog.slice(start, start + query.limit);
		const last = events.at(-1);
		return Promise.resolve({
			ok: true,
			value: {
				events,
				hasMore: start + events.length < this.eventLog.length,
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
		});
	}

	public verify(stream: RuntimeEventStreamRef): Promise<SessionResult<EventLogVerification>> {
		if (this.closed) return Promise.resolve(fail("store_closed", "event store is closed"));
		if (!sameRuntimeEventStream(stream, this.stream)) return Promise.resolve(fail("identity_mismatch", "stream does not match store"));
		return Promise.resolve({
			ok: true as const,
			value: verifyRuntimeEventChain(this.eventLog, {
				authorityId: this.authorityId,
				tenantId: this.tenantId,
					stream: this.stream,
			}),
		});
	}

	public subscribe(stream: RuntimeEventStreamRef, afterSequence = -1): AsyncIterable<RuntimeEventV3> {
		const subscription = new MemorySubscription();
		if (!sameRuntimeEventStream(stream, this.stream)) {
			subscription.close();
			return subscription;
		}
		for (const event of this.eventLog) {
			if (event.sequence > afterSequence && event.sequence <= this.publishedThroughSequence) subscription.push(event);
		}
		if (this.closed) subscription.close();
		else this.subscriptions.add(subscription);
		return subscription;
	}

	public close(): Promise<SessionResult<void>> {
		if (this.closed) return Promise.resolve({ ok: true, value: undefined });
		this.closed = true;
		for (const subscription of this.subscriptions) subscription.close();
		this.subscriptions.clear();
		return Promise.resolve({ ok: true, value: undefined });
	}
}
