import { describe, expect, it } from "vitest";
import {
	applyRetryPolicy,
	calculateRetryDelayMs,
	createSettingsAwareStreamFn,
	DEFAULT_RETRY_POLICY,
	resolveRetryPolicy,
	type RetryPolicy,
} from "../../../src/runtime/retry/policy.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";

describe("retry policy", () => {
	it("uses bounded exponential delay and caps provider Retry-After", () => {
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 100, maxDelayMs: 450 };
		expect(calculateRetryDelayMs(policy, 0)).toBe(100);
		expect(calculateRetryDelayMs(policy, 2)).toBe(400);
		expect(calculateRetryDelayMs(policy, 3)).toBe(450);
		expect(calculateRetryDelayMs(policy, 1, 1_000)).toBe(450);
	});

	it("lets an explicit caller option win while filling retry defaults from settings", () => {
		const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, enabled: true, maxRetries: 3, maxDelayMs: 900 };
		expect(applyRetryPolicy({ timeoutMs: 2_000 }, policy)).toMatchObject({ maxRetries: 3, maxRetryDelayMs: 900 });
		expect(applyRetryPolicy({ maxRetries: 1, maxRetryDelayMs: 200, retryBaseDelayMs: 25 }, policy)).toMatchObject({ maxRetries: 1, maxRetryDelayMs: 200, retryBaseDelayMs: 25 });
		expect(applyRetryPolicy({}, { ...policy, enabled: false })).toMatchObject({ maxRetries: 0, maxRetryDelayMs: 900 });
	});

	it("projects the configured base delay into the shared transport option seam", () => {
		const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 3, baseDelayMs: 320, maxDelayMs: 900 };
		expect(applyRetryPolicy({}, policy)).toMatchObject({ retryBaseDelayMs: 320 });
	});

	it("projects one immutable policy into the shared StreamFn seam", async () => {
		let received: { maxRetries?: number; maxRetryDelayMs?: number } | undefined;
		const streamFn = createSettingsAwareStreamFn((_, __, options) => {
			received = options;
			return createAssistantMessageEventStream();
		}, { ...DEFAULT_RETRY_POLICY, maxRetries: 2, maxDelayMs: 800 });

		await streamFn({} as never, { messages: [], tools: [] } as never);
		expect(received).toMatchObject({ maxRetries: 2, maxRetryDelayMs: 800 });
	});

	it("projects persisted partial settings into a bounded Runtime policy", () => {
		expect(resolveRetryPolicy({ maxRetries: 4, baseDelayMs: 300, maxDelayMs: 1_000 })).toEqual({
			enabled: true,
			maxRetries: 4,
			baseDelayMs: 300,
			maxDelayMs: 1_000,
		});
		expect(resolveRetryPolicy({ maxRetries: 99, baseDelayMs: -1, maxDelayMs: 1 })).toEqual(DEFAULT_RETRY_POLICY);
	});
});
