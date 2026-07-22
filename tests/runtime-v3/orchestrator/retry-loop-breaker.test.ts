import { describe, expect, it } from "vitest";
import {
	classifyRetryFailure,
	decideRetry,
	type RetryContext,
} from "../../../src/runtime/orchestrator/retry-policy.ts";
import {
	initialLoopBreakerState,
	observeLoop,
	replayLoopBreaker,
	type LoopBreakerPolicy,
	 type LoopObservation,
} from "../../../src/runtime/orchestrator/loop-breaker.ts";

const retryContext: RetryContext = {
	attempt: 1,
	maxAttempts: 3,
	operation: "provider",
	sideEffect: "none",
	hasStableIdempotencyKey: true,
	compactionAttempts: 0,
	maxCompactionAttempts: 1,
};

const loopPolicy: LoopBreakerPolicy = {
	maxRepeatedToolSignature: 3,
	maxRepeatedFailure: 3,
	maxNoProgress: 3,
	maxRemediationAttempts: 3,
};

function observation(id: string, patch: Partial<LoopObservation> = {}): LoopObservation {
	return {
		observationId: id,
		phase: "implementation",
		madeProgress: true,
		observedAt: "2026-07-22T00:00:00.000Z",
		...patch,
	};
}

describe("retry classification", () => {
	it("retries network/rate limits only while attempts and side-effect safety allow", () => {
		const network = classifyRetryFailure({ code: "network_timeout", operation: "provider", outcomeKnown: true });
		expect(decideRetry(network, retryContext)).toEqual({ action: "retry", delayMs: 500, reason: "network" });
		const rateLimit = classifyRetryFailure({ httpStatus: 429, retryAfterMs: 2_500, operation: "provider", outcomeKnown: true });
		expect(decideRetry(rateLimit, retryContext)).toEqual({ action: "retry", delayMs: 2_500, reason: "rate_limit" });
		const unsafe = decideRetry(network, { ...retryContext, sideEffect: "external", hasStableIdempotencyKey: false });
		expect(unsafe.action).toBe("fail");
	});

	it("pauses uncertain tools and routes context overflow through bounded compaction", () => {
		const uncertain = classifyRetryFailure({ code: "connection_lost", operation: "tool", outcomeKnown: false });
		expect(decideRetry(uncertain, { ...retryContext, operation: "tool", sideEffect: "write" }).action).toBe("pause_for_reconciliation");
		const overflow = classifyRetryFailure({ code: "context_length_exceeded", operation: "provider", outcomeKnown: true });
		expect(decideRetry(overflow, retryContext).action).toBe("compact_then_retry");
		expect(decideRetry(overflow, { ...retryContext, compactionAttempts: 1 }).action).toBe("fail");
	});

	it("does not retry validation, cancellation or exhausted attempts", () => {
		const validation = classifyRetryFailure({ httpStatus: 400, operation: "provider", outcomeKnown: true });
		expect(decideRetry(validation, retryContext).action).toBe("do_not_retry");
		const cancelled = classifyRetryFailure({ code: "aborted", operation: "provider", outcomeKnown: true });
		expect(decideRetry(cancelled, retryContext).action).toBe("do_not_retry");
		const network = classifyRetryFailure({ code: "timeout", operation: "provider", outcomeKnown: true });
		expect(decideRetry(network, { ...retryContext, attempt: 3 }).action).toBe("fail");
	});
});

describe("loop breaker", () => {
	it("trips on repeated tool signatures and is replay deterministic", () => {
		const events = [
			observation("one", { toolSignature: "bash:abc" }),
			observation("two", { toolSignature: "bash:abc" }),
			observation("three", { toolSignature: "bash:abc" }),
		];
		const replayed = replayLoopBreaker(events, loopPolicy);
		expect(replayed.ok && replayed.value.tripped?.reason).toBe("repeated_tool_signature");
		let state = initialLoopBreakerState();
		for (const event of events) {
			const next = observeLoop(state, event, loopPolicy);
			if (!next.ok) throw new Error(next.error.message);
			state = next.value;
		}
		expect(state.tripped).toEqual(replayed.ok ? replayed.value.tripped : undefined);
	});

	it.each([
		[
			"repeated_failure",
			[
				observation("f1", { failureDigest: "failure" }),
				observation("f2", { failureDigest: "failure" }),
				observation("f3", { failureDigest: "failure" }),
			],
		],
		[
			"no_progress_diff",
			[
				observation("d1", { diffDigest: "same", madeProgress: false }),
				observation("d2", { diffDigest: "same", madeProgress: false }),
				observation("d3", { diffDigest: "same", madeProgress: false }),
			],
		],
		[
			"remediation_limit",
			[
				observation("r1", { phase: "remediation" }),
				observation("r2", { phase: "remediation" }),
				observation("r3", { phase: "remediation" }),
			],
		],
	] as const)("trips on %s", (_reason, events) => {
		const result = replayLoopBreaker(events, loopPolicy);
		expect(result.ok && result.value.tripped?.reason).toBe(_reason);
	});

	it("deduplicates observation IDs", () => {
		const first = observeLoop(initialLoopBreakerState(), observation("same", { toolSignature: "tool" }), loopPolicy);
		if (!first.ok) throw new Error(first.error.message);
		const duplicate = observeLoop(first.value, observation("same", { toolSignature: "tool" }), loopPolicy);
		expect(duplicate.ok && duplicate.value.repeatedToolSignature).toBe(1);
	});
});
