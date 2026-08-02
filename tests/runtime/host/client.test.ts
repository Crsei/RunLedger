import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { InMemoryHostClient } from "../../../src/runtime/host/client.ts";
import { InMemoryHostRouter, type HostSubscriptionFrame } from "../../../src/runtime/host/router.ts";

describe("R2 remote facade cursor and eventId dedupe", () => {
	it("deduplicates at-least-once frames without advancing past a gap", () => {
		const router = new InMemoryHostRouter();
		const client = new InMemoryHostClient(router, {
			principalId: createRuntimeId("principal", "client"),
			connectionId: createRuntimeId("connection", "client"),
		});
		const sessionId = createRuntimeId("session", "client");
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "client" }));
		const first = router.publish(sessionId, { value: 1 });
		const subscription = client.subscribe(sessionId, 0);
		if (!subscription.ok) throw new Error("subscription setup failed");

		const duplicate: HostSubscriptionFrame = { type: "event", event: first };
		const consumed = client.consume(subscription.subscriptionId, [duplicate, duplicate]);
		expect(consumed).toEqual([first]);
		expect(client.cursor(subscription.subscriptionId)).toBe(1);
	});

	it("surfaces resync_required as a typed client result", () => {
		const router = new InMemoryHostRouter({ maxHistory: 1 });
		const client = new InMemoryHostClient(router, {
			principalId: createRuntimeId("principal", "resync"),
			connectionId: createRuntimeId("connection", "resync"),
		});
		const sessionId = createRuntimeId("session", "resync");
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "resync" }));
		router.publish(sessionId, { value: 1 });
		router.publish(sessionId, { value: 2 });
		const result = client.subscribe(sessionId, 0);
		expect(result).toEqual({ ok: false, code: "resync_required", safeCursor: 1 });
	});
});
