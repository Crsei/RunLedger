import { describe, expect, it } from "vitest";
import type { Models } from "../../../src/models.ts";
import { createSessionModelStreamFn } from "../../../src/runtime/agents/child-model-runtime.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";

describe("Session model stream settings seam", () => {
	it("passes the effective retry policy to the provider composition", async () => {
		let received: { maxRetries?: number; maxRetryDelayMs?: number; retryBaseDelayMs?: number } | undefined;
		const models = {
			streamSimple: (_model: never, _context: never, options?: { maxRetries?: number; maxRetryDelayMs?: number; retryBaseDelayMs?: number }) => {
				received = options;
				return createAssistantMessageEventStream();
			},
		} as unknown as Models;
		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "session-test",
			retryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 100, maxDelayMs: 700 },
		});

		await streamFn({} as never, { messages: [], tools: [] } as never);
		expect(received).toMatchObject({ maxRetries: 2, maxRetryDelayMs: 700, retryBaseDelayMs: 100 });
	});
});
