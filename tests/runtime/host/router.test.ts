import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { InMemoryHostRouter } from "../../../src/runtime/host/router.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

const sessionId = createRuntimeId("session", "router");
const principalA = createRuntimeId("principal", "router-a");
const principalB = createRuntimeId("principal", "router-b");
const connectionA = createRuntimeId("connection", "router-a");
const connectionB = createRuntimeId("connection", "router-b");

describe("R2 in-memory Host routing", () => {
	it("shares one resident owner and one driver-fenced mutation across clients", () => {
		const router = new InMemoryHostRouter();
		const clientA = router.connect({ principalId: principalA, connectionId: connectionA });
		const clientB = router.connect({ principalId: principalB, connectionId: connectionB });
		let ownerCreations = 0;
		const ownerA = router.ensureResidentSession(sessionId, () => {
			ownerCreations += 1;
			return { ownerMarker: "one" };
		});
		const ownerB = router.ensureResidentSession(sessionId, () => {
			ownerCreations += 1;
			return { ownerMarker: "two" };
		});
		expect(ownerA).toBe(ownerB);
		expect(ownerCreations).toBe(1);

		const claim = router.claimDriver(sessionId, clientA);
		expect(claim).toMatchObject({ ok: true, driverRevision: 1 });
		let mutationCalls = 0;
		const observer = router.mutate(sessionId, clientB, {
			commandId: createRuntimeId("command", "observer"),
			requestDigest: digest("a"),
			apply: () => {
				mutationCalls += 1;
				return { applied: true };
			},
		});
		expect(observer).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		expect(mutationCalls).toBe(0);

		if (!claim.ok) return;
		const mutationInput = {
			commandId: createRuntimeId("command", "driver"),
			requestDigest: digest("b"),
			apply: () => {
				mutationCalls += 1;
				return { applied: true };
			},
		};
		const applied = router.mutate(sessionId, { ...clientA, driverRevision: claim.driverRevision }, mutationInput);
		const retried = router.mutate(sessionId, { ...clientA, driverRevision: claim.driverRevision }, mutationInput);
		expect(applied).toEqual(retried);
		expect(mutationCalls).toBe(1);
	});

	it("does not let an observer transfer the active driver lease", () => {
		const router = new InMemoryHostRouter();
		const clientA = router.connect({ principalId: principalA, connectionId: connectionA });
		const clientB = router.connect({ principalId: principalB, connectionId: connectionB });
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "driver-transfer" }));
		const claimed = router.claimDriver(sessionId, clientA);
		expect(claimed).toMatchObject({ ok: true, driverRevision: 1 });

		const observerTransfer = router.claimDriver(sessionId, clientB, "transfer");
		expect(observerTransfer).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(router.mutate(sessionId, clientA, {
			commandId: createRuntimeId("command", "driver-still-active"),
			requestDigest: digest("d"),
			apply: () => "still-driver",
		})).toMatchObject({ ok: true, value: "still-driver" });

		const transferred = router.claimDriver(sessionId, clientA, "transfer", clientB);
		expect(transferred).toMatchObject({ ok: true, driverRevision: 2 });
		expect(router.mutate(sessionId, clientA, {
			commandId: createRuntimeId("command", "old-driver-fenced"),
			requestDigest: digest("e"),
			apply: () => "forbidden",
		})).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		expect(router.mutate(sessionId, clientB, {
			commandId: createRuntimeId("command", "new-driver-active"),
			requestDigest: digest("f"),
			apply: () => "new-driver",
		})).toMatchObject({ ok: true, value: "new-driver" });
	});

	it("delivers replay and live events exactly once across activation boundaries", () => {
		const router = new InMemoryHostRouter({ maxOutbox: 8 });
		const client = router.connect({ principalId: principalA, connectionId: connectionA });
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "replay" }));
		router.publish(sessionId, { marker: "history" });

		const subscription = router.subscribe({
			...client,
			sessionId,
			cursor: 0,
			hooks: {
				afterRegister: () => {
					router.publish(sessionId, { marker: "after-register" });
				},
				afterSnapshot: () => {
					router.publish(sessionId, { marker: "after-snapshot" });
				},
				afterCursorEmitted: () => {
					router.publish(sessionId, { marker: "after-cursor" });
				},
			},
		});
		expect(subscription.ok).toBe(true);
		if (!subscription.ok) return;
		const frames = router.drain(subscription.subscriptionId);
		const events = frames.flatMap((frame) => frame.type === "event" ? [frame.event] : []);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
		expect(events.map((event) => event.payload)).toEqual([
			{ marker: "history" },
			{ marker: "after-register" },
			{ marker: "after-snapshot" },
			{ marker: "after-cursor" },
		]);
		expect(new Set(events.map((event) => event.eventId)).size).toBe(4);
	});

	it("isolates a slow subscription and returns a safe resync cursor", () => {
		const router = new InMemoryHostRouter({ maxOutbox: 2 });
		const slow = router.connect({ principalId: principalA, connectionId: connectionA });
		const fast = router.connect({ principalId: principalB, connectionId: connectionB });
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "backpressure" }));
		const slowSubscription = router.subscribe({ ...slow, sessionId, cursor: 0 });
		const fastSubscription = router.subscribe({ ...fast, sessionId, cursor: 0 });
		if (!slowSubscription.ok || !fastSubscription.ok) throw new Error("subscription setup failed");
		const fastFrames: Array<ReturnType<typeof router.drain>> = [];
		for (let index = 0; index < 3; index += 1) {
			router.publish(sessionId, { index });
			fastFrames.push(router.drain(fastSubscription.subscriptionId));
		}

		const slowFrames = router.drain(slowSubscription.subscriptionId);
		expect(slowFrames).toEqual([{ type: "resync_required", safeCursor: 3 }]);
		expect(fastFrames.flat().filter((frame) => frame.type === "event")).toHaveLength(3);
	});

	it("rejects a cursor older than retained history instead of returning a fake empty replay", () => {
		const router = new InMemoryHostRouter({ maxHistory: 2 });
		const client = router.connect({ principalId: principalA, connectionId: connectionA });
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "retention" }));
		for (let index = 0; index < 3; index += 1) router.publish(sessionId, { index });
		const subscription = router.subscribe({ ...client, sessionId, cursor: 0 });
		expect(subscription).toEqual({ ok: false, code: "resync_required", safeCursor: 1 });
	});

	it("caps subscriptions for one principal and session", () => {
		const router = new InMemoryHostRouter();
		const client = router.connect({ principalId: principalA, connectionId: connectionA });
		router.ensureResidentSession(sessionId, () => ({ ownerMarker: "subscription-capacity" }));
		for (let index = 0; index < 8; index += 1) {
			expect(router.subscribe({ ...client, sessionId, cursor: 0 }).ok).toBe(true);
		}
		expect(router.subscribe({ ...client, sessionId, cursor: 0 })).toEqual({
			ok: false,
			code: "subscription_capacity_exceeded",
		});
	});
});
