/** Runtime v3 canonical Event Store port。 */

import type { ExpectedRevision, RuntimeEventStreamRef, RuntimeEventV3 } from "../protocol/v3/events.ts";
import type {
	AcceptedEventCursor,
	DurableEventReceipt,
	EventLogVerification,
	EventPage,
	EventPageQuery,
	SessionResult,
	WriterFence,
} from "./types.ts";

export interface RuntimeEventStore {
	streamRef(): RuntimeEventStreamRef;
	append(
		stream: RuntimeEventStreamRef,
		event: RuntimeEventV3,
		expected: ExpectedRevision | null,
		fence: WriterFence,
	): Promise<SessionResult<AcceptedEventCursor>>;
	flushThrough(
		stream: RuntimeEventStreamRef,
		cursor: AcceptedEventCursor,
		fence: WriterFence,
	): Promise<SessionResult<DurableEventReceipt>>;
	readPage(stream: RuntimeEventStreamRef, query: EventPageQuery): Promise<SessionResult<EventPage>>;
	verify(stream: RuntimeEventStreamRef): Promise<SessionResult<EventLogVerification>>;
	subscribe(stream: RuntimeEventStreamRef, afterSequence?: number): AsyncIterable<RuntimeEventV3>;
	close(): Promise<SessionResult<void>>;
}

export type WriterFenceValidator = (fence: WriterFence) => Promise<boolean> | boolean;
