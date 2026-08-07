/**
 * R4:session-scoped subscription registry(06 §6.1/§6.3)。
 *
 * - 每个 authenticated connection 可有一个订阅,cursor 是已 ACK 的 sequence;
 * - replay:subscribe 时从 cursor+1 起有界回放(≤ maxSubscriptionReplay);
 *   cursor 落后过远或出现 gap → resync_required,由 client 重建 snapshot;
 * - dedupe:按 sequence 单调去重(已 delivered 的事件不重复投递),ACK 只推进 cursor;
 * - backpressure:unacked = delivered - cursor 受 maxAckWindow 限制,慢订阅者
 *   不再收到新事件;由 RuntimeServer 的 bounded outbox 最终断开慢 client。
 * - 本模块是纯 registry,不持有 socket;投递由 RuntimeServer 执行。
 */

import type { ConnectionId } from "../protocol/ids.ts";
import type { SessionEventRecord } from "../../storage/session-store/session-store.ts";
import { SESSION_PROTOCOL_BOUNDS } from "./protocol.ts";

export interface SubscriptionView {
	readonly connectionId: ConnectionId;
	readonly cursor: number;
	readonly pending: number;
	readonly lag: number;
}

export type DeliverOutcome =
	| { readonly ok: true; readonly events: readonly SessionEventRecord[] }
	| { readonly ok: false; readonly code: "resync_required" };

export type AckResult =
	| { readonly ok: true; readonly cursor: number }
	| { readonly ok: false; readonly code: "cursor_out_of_order" };

interface SubscriptionEntry {
	readonly connectionId: ConnectionId;
	/** 已 ACK 的 sequence。 */
	cursor: number;
	/** 已投递的 watermark(用于 unacked 计数,防止重复投递重复计数)。 */
	delivered: number;
}

export class SessionSubscriptionRegistry {
	private readonly entries = new Map<ConnectionId, SubscriptionEntry>();
	private readonly maxAckWindow: number;
	private readonly maxReplay: number;
	private head = 0;

	public constructor(
		maxAckWindow: number = SESSION_PROTOCOL_BOUNDS.maxAckWindow,
		maxReplay: number = SESSION_PROTOCOL_BOUNDS.maxSubscriptionReplay,
	) {
		this.maxAckWindow = maxAckWindow;
		this.maxReplay = maxReplay;
	}

	public setHead(sequence: number): void {
		this.head = sequence;
	}

	public get headSequence(): number {
		return this.head;
	}

	public subscribe(connectionId: ConnectionId, cursor: number): SubscriptionView | undefined {
		if (this.entries.has(connectionId)) return undefined;
		if (cursor > this.head) return undefined;
		this.entries.set(connectionId, { connectionId, cursor, delivered: cursor });
		return this.view(connectionId);
	}

	public unsubscribe(connectionId: ConnectionId): void {
		this.entries.delete(connectionId);
	}

	public ack(connectionId: ConnectionId, cursor: number): AckResult {
		const entry = this.entries.get(connectionId);
		if (!entry) return { ok: false, code: "cursor_out_of_order" };
		if (cursor < entry.cursor || cursor > this.head) return { ok: false, code: "cursor_out_of_order" };
		entry.cursor = cursor;
		return { ok: true, cursor };
	}

	public isSubscribed(connectionId: ConnectionId): boolean {
		return this.entries.has(connectionId);
	}

	/**
	 * §6.1 replay + backpressure:返回该 connection 应该收到的事件。
	 * cursor 落后 head 超过 maxReplay 或已 unsubscribe → resync_required;
	 * unacked 超过 maxAckWindow → 暂停投递(由 outbox 上限最终断开)。
	 */
	public replay(connectionId: ConnectionId, fromCursor: number, events: readonly SessionEventRecord[]): DeliverOutcome {
		const entry = this.entries.get(connectionId);
		if (!entry) return { ok: false, code: "resync_required" };
		if (fromCursor < entry.cursor) return { ok: false, code: "resync_required" };
		const candidates = events.filter((candidate) => candidate.sequence > entry.delivered && candidate.sequence > fromCursor);
		if (candidates.length > this.maxReplay) return { ok: false, code: "resync_required" };
		const limit = Math.max(0, this.maxAckWindow - this.unacked(entry));
		const delivered = candidates.slice(0, limit);
		entry.delivered = Math.max(entry.delivered, delivered.at(-1)?.sequence ?? entry.delivered);
		return { ok: true, events: delivered };
	}

	/** 慢订阅者检测:unacked 超过窗口 → 应该断开该 connection。 */
	public shouldDropSlowSubscriber(connectionId: ConnectionId): boolean {
		const entry = this.entries.get(connectionId);
		return entry !== undefined && this.unacked(entry) >= this.maxAckWindow;
	}

	public view(connectionId: ConnectionId): SubscriptionView | undefined {
		const entry = this.entries.get(connectionId);
		if (!entry) return undefined;
		return { connectionId, cursor: entry.cursor, pending: this.unacked(entry), lag: this.head - entry.cursor };
	}

	public views(): readonly SubscriptionView[] {
		return [...this.entries.values()].map((entry) => ({ connectionId: entry.connectionId, cursor: entry.cursor, pending: this.unacked(entry), lag: this.head - entry.cursor }));
	}

	private unacked(entry: SubscriptionEntry): number {
		return Math.max(0, entry.delivered - entry.cursor);
	}
}
