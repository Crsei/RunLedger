/** Durable prompt queue 的纯重放与正文完整性校验。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type { EventCursor, ExpectedRevision, RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { CommandId, QueueItemId, TurnId } from "../protocol/v3/ids.ts";
import { decodeCanonicalAgentMessage } from "../../storage/session-codec.ts";
import type { UserAgentMessage } from "../types.ts";

export type DurableQueueKind = "steer" | "follow_up";
export type DurableQueueItemStatus = "pending" | "claimed" | "consumed" | "cancelled";
export type DurableQueueNextTurnPolicy = "next_model_turn" | "after_active_run";
export type DurableQueueContent =
	| { readonly storage: "bounded_text"; readonly messageJson: string }
	| { readonly storage: "artifact"; readonly artifact: ArtifactRef };
export interface DurableQueueTargetTurnRevision {
	readonly turnId: TurnId;
	readonly sessionRevision: ExpectedRevision;
}

/**
 * 引用对象在同一进程内保持身份稳定；只有对应 terminal event durable 后才改变
 * status，Agent 可据此安全提交或归还内存 reservation。
 */
export interface DurableQueueReference {
	readonly queueItemId: QueueItemId;
	readonly sourceCommandId: CommandId;
	readonly kind: DurableQueueKind;
	readonly enqueueRevision: ExpectedRevision;
	readonly targetTurnRevision: DurableQueueTargetTurnRevision | null;
	readonly nextTurnPolicy: DurableQueueNextTurnPolicy;
	readonly contentDigest: string;
	status: DurableQueueItemStatus;
}

export interface RestoredDurableQueueItem {
	readonly reference: DurableQueueReference;
	readonly content: DurableQueueContent;
	/** Artifact-backed queue items remain authoritative but require an injected resolver before Agent adoption. */
	readonly message: UserAgentMessage | null;
	readonly enqueuedSequence: number;
	/** 精确绑定 queue.enqueued 的 durable cursor，禁止按正文或 FIFO 猜测认领。 */
	readonly enqueuedCursor: EventCursor;
}

export interface UnrecoverableDurableQueueItem {
	readonly queueItemId: QueueItemId;
	readonly sequence: number;
	readonly reason: "content_digest_mismatch" | "invalid_message_json" | "invalid_message_shape" | "terminal_binding_mismatch";
}

export interface DurableQueueReplay {
	readonly pending: readonly RestoredDurableQueueItem[];
	readonly unrecoverable: readonly UnrecoverableDurableQueueItem[];
}

function decodeQueuedUserMessage(
	messageJson: string,
	contentDigest: string,
): { ok: true; value: UserAgentMessage } | { ok: false; reason: UnrecoverableDurableQueueItem["reason"] } {
	if (canonicalDigest({ storage: "bounded_text", messageJson }) !== contentDigest) {
		return { ok: false, reason: "content_digest_mismatch" };
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(messageJson) as unknown;
	} catch {
		return { ok: false, reason: "invalid_message_json" };
	}
	const message = decodeCanonicalAgentMessage(decoded);
	if (
		!message ||
		message.role !== "user" ||
		!message.content.every((part) =>
			part.type === "text" &&
			typeof part.text === "string" &&
			(part.textSignature === undefined || typeof part.textSignature === "string")
		)
	) {
		return { ok: false, reason: "invalid_message_shape" };
	}
	return { ok: true, value: message };
}

/**
 * 只要求尚未 terminal 的 queue item 可恢复正文。旧日志中已经 consumed/cancelled
 * 的 digest-only item 不影响继续运行，因为其正文不再需要重新注入。
 */
export function replayDurableQueue(events: readonly RuntimeEventV3[]): DurableQueueReplay {
	const pendingEvents = new Map<QueueItemId, {
		event: Extract<RuntimeEventV3, { type: "queue.enqueued" }>;
		status: "pending" | "claimed";
	}>();
	const unrecoverable: UnrecoverableDurableQueueItem[] = [];
	const bindingMatches = (
		item: { event: Extract<RuntimeEventV3, { type: "queue.enqueued" }> },
		event: Extract<RuntimeEventV3, { type: "queue.claimed" | "queue.consumed" | "queue.cancelled" }>,
	): boolean => (
		item.event.payload.sourceCommandId === event.payload.sourceCommandId &&
		item.event.payload.kind === event.payload.kind &&
		item.event.payload.contentDigest === event.payload.contentDigest
	);
	for (const event of events) {
		if (event.type === "queue.enqueued") {
			pendingEvents.set(event.payload.queueItemId as QueueItemId, { event, status: "pending" });
			continue;
		}
		if (event.type === "queue.claimed") {
			const item = pendingEvents.get(event.payload.queueItemId as QueueItemId);
			if (item && bindingMatches(item, event)) item.status = "claimed";
			else if (item) unrecoverable.push({
				queueItemId: event.payload.queueItemId as QueueItemId,
				sequence: event.sequence,
				reason: "terminal_binding_mismatch",
			});
			continue;
		}
		if (event.type === "queue.consumed" || event.type === "queue.cancelled") {
			const item = pendingEvents.get(event.payload.queueItemId as QueueItemId);
			if (item && bindingMatches(item, event)) pendingEvents.delete(event.payload.queueItemId as QueueItemId);
			else if (item) unrecoverable.push({
				queueItemId: event.payload.queueItemId as QueueItemId,
				sequence: event.sequence,
				reason: "terminal_binding_mismatch",
			});
		}
	}

	const pending: RestoredDurableQueueItem[] = [];
	for (const replayed of [...pendingEvents.values()].sort((left, right) => left.event.sequence - right.event.sequence)) {
		const { event } = replayed;
		const queueItemId = event.payload.queueItemId as QueueItemId;
		const content = event.payload.content as DurableQueueContent;
		if (canonicalDigest(content) !== event.payload.contentDigest) {
			unrecoverable.push({ queueItemId, sequence: event.sequence, reason: "content_digest_mismatch" });
			continue;
		}
		let message: UserAgentMessage | null = null;
		if (content.storage === "bounded_text") {
			const decoded = decodeQueuedUserMessage(content.messageJson, event.payload.contentDigest);
			if (!decoded.ok) {
				unrecoverable.push({ queueItemId, sequence: event.sequence, reason: decoded.reason });
				continue;
			}
			message = decoded.value;
		}
		pending.push({
			reference: {
				queueItemId,
				sourceCommandId: event.payload.sourceCommandId as CommandId,
				kind: event.payload.kind,
				enqueueRevision: event.payload.enqueueRevision as ExpectedRevision,
				targetTurnRevision: event.payload.targetTurnRevision as DurableQueueTargetTurnRevision | null,
				nextTurnPolicy: event.payload.nextTurnPolicy,
				contentDigest: event.payload.contentDigest,
				status: replayed.status,
			},
			content,
			message,
			enqueuedSequence: event.sequence,
			enqueuedCursor: {
				stream: event.stream,
				sequence: event.sequence,
				eventId: event.eventId,
				eventHash: event.currentEventHash,
			},
		});
	}
	return { pending, unrecoverable };
}
