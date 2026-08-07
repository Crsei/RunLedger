/**
 * R4:subscription registry 纯单元 fixtures(06 §6.1/§6.3)。
 *
 * 覆盖:cursor/replay 有界、dedupe、ACK 顺序、backpressure(慢订阅者暂停)、
 * resync_required(cursor 落后过远/fromCursor 回退)。
 */

import { describe, expect, it } from "vitest";
import { SessionSubscriptionRegistry } from "../../../src/runtime/session-server/subscription.ts";
import { createRuntimeId, type ConnectionId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionEventRecord } from "../../../src/storage/session-store/session-store.ts";

function event(sequence: number): SessionEventRecord {
	return {
		sessionId: createRuntimeId("session", "t"),
		sequence,
		eventId: createRuntimeId("event", `e${sequence}`),
		ownerGeneration: 1,
		eventType: "assistant.delta",
		payloadJson: JSON.stringify({ n: sequence }),
		previousEventHash: null,
		currentEventHash: "hash",
		createdAtMs: sequence,
	};
}

const conn = (seed: string): ConnectionId => createRuntimeId("connection", seed);

describe("R4 subscription registry", () => {
	it("replays only events after the subscription cursor", () => {
		const registry = new SessionSubscriptionRegistry();
		registry.setHead(5);
		const events = [1, 2, 3, 4, 5].map(event);
		const view = registry.subscribe(conn("a"), 2);
		expect(view?.cursor).toBe(2);
		const outcome = registry.replay(conn("a"), 2, events);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("expected ok");
		expect(outcome.events.map((e) => e.sequence)).toEqual([3, 4, 5]);
	});

	it("dedupes already-delivered events and only re-delivers new ones", () => {
		const registry = new SessionSubscriptionRegistry();
		registry.setHead(3);
		registry.subscribe(conn("a"), 0);
		const first = registry.replay(conn("a"), 0, [1, 2, 3].map(event));
		expect(first.ok && first.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
		registry.setHead(4);
		const second = registry.replay(conn("a"), 3, [1, 2, 3, 4].map(event));
		expect(second.ok && second.events.map((e) => e.sequence)).toEqual([4]);
	});

	it("advances cursor via ACK and rejects out-of-order ACKs", () => {
		const registry = new SessionSubscriptionRegistry();
		registry.setHead(10);
		registry.subscribe(conn("a"), 0);
		registry.replay(conn("a"), 0, [1, 2, 3].map(event));
		expect(registry.ack(conn("a"), 3)).toEqual({ ok: true, cursor: 3 });
		expect(registry.ack(conn("a"), 2)).toEqual({ ok: false, code: "cursor_out_of_order" });
		expect(registry.ack(conn("a"), 11)).toEqual({ ok: false, code: "cursor_out_of_order" });
		expect(registry.view(conn("a"))?.pending).toBe(0);
	});

	it("pauses delivery to a slow subscriber once the ACK window is full", () => {
		const registry = new SessionSubscriptionRegistry(4, 1_000);
		registry.setHead(10);
		registry.subscribe(conn("slow"), 0);
		const first = registry.replay(conn("slow"), 0, [1, 2, 3, 4, 5].map(event));
		expect(first.ok && first.events).toHaveLength(4);
		expect(registry.shouldDropSlowSubscriber(conn("slow"))).toBe(true);
		const paused = registry.replay(conn("slow"), 4, [1, 2, 3, 4, 5, 6].map(event));
		expect(paused.ok && paused.events).toHaveLength(0);
		// ACK 后恢复投递(5、6 都是客户端尚未收到的)。
		registry.ack(conn("slow"), 4);
		expect(registry.shouldDropSlowSubscriber(conn("slow"))).toBe(false);
		const resumed = registry.replay(conn("slow"), 4, [1, 2, 3, 4, 5, 6].map(event));
		expect(resumed.ok && resumed.events.map((e) => e.sequence)).toEqual([5, 6]);
	});

	it("returns resync_required when the replay range exceeds the bound", () => {
		const registry = new SessionSubscriptionRegistry(256, 2_048);
		registry.setHead(3_000);
		registry.subscribe(conn("late"), 0);
		const events = Array.from({ length: 3_000 }, (_, index) => event(index + 1));
		const outcome = registry.replay(conn("late"), 0, events);
		expect(outcome).toEqual({ ok: false, code: "resync_required" });
	});

	it("returns resync_required when fromCursor goes backwards or subscription is absent", () => {
		const registry = new SessionSubscriptionRegistry();
		registry.setHead(10);
		registry.subscribe(conn("a"), 5);
		expect(registry.replay(conn("a"), 4, [5, 6].map(event))).toEqual({ ok: false, code: "resync_required" });
		expect(registry.replay(conn("ghost"), 0, [1].map(event))).toEqual({ ok: false, code: "resync_required" });
		registry.unsubscribe(conn("a"));
		expect(registry.replay(conn("a"), 5, [6].map(event))).toEqual({ ok: false, code: "resync_required" });
	});

	it("rejects a subscription with a cursor beyond head", () => {
		const registry = new SessionSubscriptionRegistry();
		registry.setHead(4);
		expect(registry.subscribe(conn("a"), 5)).toBeUndefined();
	});
});
