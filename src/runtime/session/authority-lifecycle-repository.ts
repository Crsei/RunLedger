/** authority/tenant lifecycle Event Store repository；不创建 sidecar 状态真源。 */

import {
	createAuthorityTenantEventStreamRef,
	isRuntimeEventTypeAllowedInStream,
	sameRuntimeEventStream,
	type AuthorityTenantEventStreamRef,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import type { AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import {
	reduceAuthorityLifecycleEvents,
	type AuthorityLifecycleEventType,
	type AuthorityLifecycleProjection,
} from "./authority-lifecycle-projection.ts";
import type { RuntimeEventStore } from "./event-store.ts";
import type { EventWriter } from "./event-writer.ts";
import type {
	AcceptedRuntimeEvent,
	DurableEventReceipt,
	RuntimeEventDraft,
	SessionKernelError,
	SessionResult,
} from "./types.ts";

export interface AuthorityLifecycleRepositoryOptions {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly store: RuntimeEventStore;
	readonly writer: EventWriter;
}

export interface AuthorityLifecycleReplay {
	readonly events: readonly RuntimeEventV3[];
	readonly projection: AuthorityLifecycleProjection;
}

export interface AuthorityEventCommit<TType extends RuntimeEventType> {
	readonly accepted: AcceptedRuntimeEvent<TType>;
	readonly durableReceipt: DurableEventReceipt;
	readonly projection: AuthorityLifecycleProjection;
}

export type AuthorityLifecycleCommit<TType extends AuthorityLifecycleEventType> = AuthorityEventCommit<TType>;

function failure<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function invalid<T>(message: string): SessionResult<T> {
	return failure({ code: "identity_mismatch", message, retryable: false, effect: "none" });
}

function durableFailure<T>(message: string, errorName?: string): SessionResult<T> {
	return failure({
		code: "durable_write_failed",
		message,
		retryable: false,
		effect: "uncertain",
		...(errorName ? { details: { errorName } } : {}),
	});
}

function sameCursor(left: EventCursor | undefined, right: EventCursor | null): boolean {
	if (!left || !right) return left === undefined && right === null;
	return sameRuntimeEventStream(left.stream, right.stream) && left.sequence === right.sequence &&
		left.eventId === right.eventId && left.eventHash === right.eventHash;
}

async function readAllEvents(
	store: RuntimeEventStore,
	stream: AuthorityTenantEventStreamRef,
): Promise<SessionResult<readonly RuntimeEventV3[]>> {
	const events: RuntimeEventV3[] = [];
	let afterSequence: number | undefined;
	for (;;) {
		let page;
		try {
			page = await store.readPage(stream, {
				...(afterSequence === undefined ? {} : { afterSequence }),
				limit: 1000,
			});
		} catch (error) {
			return durableFailure("authority lifecycle replay failed", error instanceof Error ? error.name : "UnknownError");
		}
		if (!page.ok) return page;
		if (page.value.events.length === 0) {
			if (page.value.hasMore) return durableFailure("authority lifecycle pagination returned an empty non-terminal page");
			break;
		}
		for (const event of page.value.events) {
			const validated = validateRuntimeEvent(event);
			if (!validated.ok) {
				return failure({ code: "corrupted_log", message: "authority lifecycle replay returned an invalid event", retryable: false });
			}
			events.push(validated.value);
		}
		if (events.length > 1_000_000) return durableFailure("authority lifecycle replay exceeds the event limit");
		const last = page.value.events.at(-1);
		if (!last) return durableFailure("authority lifecycle page has no terminal event");
		if (!page.value.hasMore) break;
		if (afterSequence !== undefined && last.sequence <= afterSequence) {
			return durableFailure("authority lifecycle pagination did not advance");
		}
		afterSequence = last.sequence;
	}
	return { ok: true, value: events };
}

export class AuthorityLifecycleRepository {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #stream: AuthorityTenantEventStreamRef;
	readonly #store: RuntimeEventStore;
	readonly #writer: EventWriter;
	#terminalError: SessionKernelError | undefined;

	private constructor(options: AuthorityLifecycleRepositoryOptions, stream: AuthorityTenantEventStreamRef) {
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#stream = stream;
		this.#store = options.store;
		this.#writer = options.writer;
	}

	public static async open(
		options: AuthorityLifecycleRepositoryOptions,
	): Promise<SessionResult<AuthorityLifecycleRepository>> {
		const stream = createAuthorityTenantEventStreamRef(options);
		if (!sameRuntimeEventStream(options.store.streamRef(), stream) ||
			!sameRuntimeEventStream(options.writer.streamRef(), stream)) {
			return invalid("authority lifecycle repository requires the canonical authority/tenant stream");
		}
		const repository = new AuthorityLifecycleRepository(options, stream);
		const replay = await repository.replay();
		if (!replay.ok) return replay;
		if (!sameCursor(options.writer.currentHead(), replay.value.projection.head)) {
			return invalid("authority lifecycle writer head does not match the verified store head");
		}
		return { ok: true, value: repository };
	}

	public streamRef(): AuthorityTenantEventStreamRef {
		return { ...this.#stream };
	}

	public mutationError(): SessionKernelError | undefined {
		return this.#terminalError;
	}

	public async replay(): Promise<SessionResult<AuthorityLifecycleReplay>> {
		let verified;
		try {
			verified = await this.#store.verify(this.#stream);
		} catch (error) {
			return durableFailure("authority lifecycle verification failed", error instanceof Error ? error.name : "UnknownError");
		}
		if (!verified.ok) return verified;
		if (verified.value.integrity !== "valid") {
			return failure(verified.value.error ?? {
				code: "corrupted_log",
				message: "authority lifecycle stream is not fully verified",
				retryable: false,
			});
		}
		if (verified.value.authorityId !== this.#authorityId || verified.value.tenantId !== this.#tenantId ||
			!sameRuntimeEventStream(verified.value.stream, this.#stream)) {
			return invalid("authority lifecycle verification returned the wrong tenant scope");
		}
		const events = await readAllEvents(this.#store, this.#stream);
		if (!events.ok) return events;
		const projection = reduceAuthorityLifecycleEvents(events.value, {
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
			stream: this.#stream,
		});
		if (!projection.ok) return projection;
		if (projection.value.head === null ? verified.value.head !== undefined :
			!sameCursor(verified.value.head, projection.value.head)) {
			return failure({
				code: "corrupted_log",
				message: "authority lifecycle replay head does not match store verification",
				retryable: false,
			});
		}
		return { ok: true, value: { events: events.value, projection: projection.value } };
	}

	/** catalog 是 authority stream 可写类型的唯一 closed set；session-only event 在写入前拒绝。 */
	public async append<TType extends RuntimeEventType>(
		draft: RuntimeEventDraft<TType>,
	): Promise<SessionResult<AuthorityEventCommit<TType>>> {
		if (this.#terminalError) return failure(this.#terminalError);
		if (!isRuntimeEventTypeAllowedInStream(draft.type, "authority_tenant")) {
			return failure({
				code: "invalid_event",
				message: "event type is not allowed in the authority/tenant stream",
				retryable: false,
				effect: "none",
			});
		}
		const before = await this.replay();
		if (!before.ok) {
			this.#terminalError = before.error;
			return before;
		}
		if (!sameCursor(this.#writer.currentHead(), before.value.projection.head)) {
			const error: SessionKernelError = {
				code: "sequence_conflict",
				message: "authority lifecycle writer is stale",
				retryable: false,
				effect: "none",
			};
			this.#terminalError = error;
			return failure(error);
		}
		const appended = await this.#writer.append(draft);
		if (!appended.ok) {
			this.#terminalError = appended.error;
			return appended;
		}
		const receipt = appended.value.durableReceipt;
		if (!receipt || !sameRuntimeEventStream(receipt.cursor.stream, this.#stream) ||
			receipt.cursor.sequence !== appended.value.cursor.sequence ||
			receipt.cursor.eventId !== appended.value.cursor.eventId ||
			receipt.cursor.eventHash !== appended.value.cursor.eventHash) {
			const result = durableFailure<AuthorityEventCommit<TType>>(
				"authority lifecycle append did not return its mandatory durable receipt",
			);
			if (!result.ok) this.#terminalError = result.error;
			return result;
		}
		const replay = await this.replay();
		if (!replay.ok) {
			this.#terminalError = replay.error;
			return replay;
		}
		if (!sameCursor(appended.value.cursor, replay.value.projection.head)) {
			const result = durableFailure<AuthorityEventCommit<TType>>(
				"authority lifecycle durable append is not the verified stream head",
			);
			if (!result.ok) this.#terminalError = result.error;
			return result;
		}
		return {
			ok: true,
			value: { accepted: appended.value, durableReceipt: receipt, projection: replay.value.projection },
		};
	}
}
