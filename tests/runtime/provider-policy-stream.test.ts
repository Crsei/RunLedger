import { describe, expect, it } from "vitest";
import type { Context, Model, SimpleStreamOptions } from "../../src/types.ts";
import type { Models } from "../../src/models.ts";
import { createProviderRequestGate, createSessionModelStreamFn } from "../../src/runtime/agents/child-model-runtime.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

function fixtureModel(): Model<"mock"> {
	return {
		id: "model",
		name: "model",
		api: "mock",
		provider: "fixture",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 128,
	};
}

function finalStream(model: Model<"mock">, delayMs: number): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	setTimeout(() => {
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop" as const,
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	}, delayMs);
	return stream;
}

describe("settings-aware provider stream policy", () => {
	it("holds a second request until the configured provider slot is released", async () => {
		const model = fixtureModel();
		let active = 0;
		let maximumActive = 0;
		const models = {
			streamSimple: (_model: Model<"mock">, _context: Context, _options?: SimpleStreamOptions) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				const stream = finalStream(model, 15);
				void stream.result().then(() => { active -= 1; });
				return stream;
			},
		} as unknown as Models;
		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "session-fixture",
			providerPolicy: { maxInFlightRequests: { fixture: 1 } },
		});

		const context = { systemPrompt: "", messages: [], tools: [] } as Context;
		const first = await streamFn(model, context, {});
		const secondPromise = streamFn(model, context, {});
		await first.result();
		const second = await secondPromise;
		await second.result();

		expect(maximumActive).toBe(1);
	});

	it("shares the provider limit across root and child stream functions", async () => {
		const model = fixtureModel();
		let active = 0;
		let maximumActive = 0;
		const models = {
			streamSimple: (_model: Model<"mock">, _context: Context, _options?: SimpleStreamOptions) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				const stream = finalStream(model, 15);
				void stream.result().then(() => { active -= 1; });
				return stream;
			},
		} as unknown as Models;
		const gate = createProviderRequestGate({ maxInFlightRequests: { fixture: 1 } });
		const rootStreamFn = createSessionModelStreamFn({ models, sessionId: "session-fixture", providerGate: gate });
		const childStreamFn = createSessionModelStreamFn({ models, sessionId: "session-fixture", providerGate: gate });
		const context = { systemPrompt: "", messages: [], tools: [] } as Context;

		const first = await rootStreamFn(model, context, {});
		const secondPromise = childStreamFn(model, context, {});
		await first.result();
		const second = await secondPromise;
		await second.result();

		expect(maximumActive).toBe(1);
	});

	it("returns a typed denial without calling the provider transport when disabled", async () => {
		const model = fixtureModel();
		let calls = 0;
		const models = {
			streamSimple: () => {
				calls += 1;
				return finalStream(model, 0);
			},
		} as unknown as Models;
		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "session-disabled-provider",
			providerPolicy: { disabledProviders: [model.provider] },
		});

		const stream = await streamFn(model, { systemPrompt: "", messages: [], tools: [] } as Context, {});
		const message = await stream.result();

		expect(calls).toBe(0);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("provider_disabled_by_settings");
	});

	it("aborts a queued request without consuming the slot needed by a later request", async () => {
		const model = fixtureModel();
		const gate = createProviderRequestGate({ maxInFlightRequests: { fixture: 1 } });
		let calls = 0;
		let releaseFirst: (() => void) | undefined;
		const models = {
			streamSimple: () => {
				calls += 1;
				if (calls === 1) {
					const stream = createAssistantMessageEventStream();
					releaseFirst = () => {
						const message = {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "first" }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: "stop" as const,
							timestamp: Date.now(),
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
						stream.push({ type: "done", reason: "stop", message });
						stream.end(message);
					};
					return stream;
				}
				return finalStream(model, 0);
			},
		} as unknown as Models;
		const streamFn = createSessionModelStreamFn({ models, sessionId: "session-abort", providerGate: gate });
		const context = { systemPrompt: "", messages: [], tools: [] } as Context;
		const first = await streamFn(model, context, {});
		const controller = new AbortController();
		const queued = streamFn(model, context, { signal: controller.signal });

		await Promise.resolve();
		controller.abort();
		await expect(queued).rejects.toThrow("provider concurrency wait aborted");
		releaseFirst?.();
		await first.result();

		const later = await streamFn(model, context, {});
		await later.result();
		expect(calls).toBe(2);
	});
});
