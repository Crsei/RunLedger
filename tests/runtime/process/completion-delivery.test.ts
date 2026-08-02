import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	applyCompletionDelivery,
	createCompletionDeliveryKey,
	createPendingCompletionDelivery,
	type CompletionDeliveryState,
} from "../../../src/runtime/process/completion-delivery.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

describe("R5 completion delivery projector", () => {
	it("uses one stable delivery key and suppresses the competing path", () => {
		const parts = {
			authorityId: createRuntimeId("authority", "delivery"),
			sessionId: createRuntimeId("session", "delivery"),
			agentId: createRuntimeId("agent", "delivery"),
			executionId: createRuntimeId("execution", "delivery"),
			attemptId: createRuntimeId("attempt", "delivery"),
			terminalSequence: 7,
			deliveryPolicyDigest: digest("a"),
		};
		const key = createCompletionDeliveryKey(parts);
		expect(key).toBe(createCompletionDeliveryKey({ ...parts }));
		let state = createPendingCompletionDelivery(key, 7);
		state = applyCompletionDelivery(state, { type: "follow_up_enqueued" });
		state = applyCompletionDelivery(state, { type: "follow_up_claimed" });
		const explicit = applyCompletionDelivery(state, { type: "explicit_delivery_committed" });
		expect(explicit).toMatchObject({ status: "suppressed", key, terminalSequence: 7 });
	});

	it("does not treat timeout/cancel as delivered and can reconcile a claimed follow-up", () => {
		let state: CompletionDeliveryState = createPendingCompletionDelivery("completion-test", 2);
		const timedOut = applyCompletionDelivery(state, { type: "wait_timed_out" });
		expect(timedOut).toEqual(state);
		state = applyCompletionDelivery(state, { type: "follow_up_enqueued" });
		state = applyCompletionDelivery(state, { type: "follow_up_claimed" });
		expect(applyCompletionDelivery(state, { type: "claim_interrupted" })).toMatchObject({
			status: "follow_up_enqueued",
		});
	});
});
