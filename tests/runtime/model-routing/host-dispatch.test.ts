import { describe, expect, it, vi } from "vitest";
import { createModels, createProvider } from "../../../src/models.ts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import { InteractiveSessionController, type ModelRequestRouter } from "../../../src/runtime/interactive-session-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";

function model(): Model<Api> {
	return {
		id: "model",
		name: "fixture model",
		api: "mock",
		provider: "fixture",
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 512,
	};
}

function stopStream(requestModel: Model<Api>, _context: Context): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "provider-called" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		stopReason: "stop",
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
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function deniedRouter(calls: { count: number; kind?: string }): ModelRequestRouter {
	return {
		route: async (request) => {
			calls.count += 1;
			calls.kind = request.requestKind;
			return {
				requestId: request.requestId,
				outcome: "deny",
				targetProviderId: "fixture",
				targetModelId: "model",
				targetProfileId: request.targetProfileId,
				manifestDigest: request.contextDigest,
				reasonCode: "profile_unknown",
				diagnostics: [{ code: "profile_unknown", severity: "error", message: "fixture route denied" }],
				decisionDigest: request.contextDigest,
			};
		},
	};
}

describe("Host model request dispatch", () => {
	it("fails closed before provider dispatch when the compatibility route denies", async () => {
		const selected = model();
		let providerCalls = 0;
		const models = createModels();
		models.setProvider(createProvider({
			id: "fixture",
			name: "Fixture",
			auth: {
				apiKey: {
					name: "fixture",
					login: async () => ({ type: "api_key", key: "fixture" }),
					check: async () => ({ source: "fixture", type: "api_key" }),
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			models: [selected],
			api: {
				stream: (requestModel, context) => stopStream(requestModel, context),
				streamSimple: (requestModel, context) => {
					providerCalls += 1;
					return stopStream(requestModel, context);
				},
			},
		}));
		const calls = { count: 0 };
		const controller = await InteractiveSessionController.create({
			cwd: process.cwd(),
			layout: buildRunledgerLayout(process.cwd(), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: "fixture", model: "model" },
			replay: { messages: [], config: {}, auditEntries: [], warnings: [] },
			ledger: new MemoryLedger(),
			tools: [],
			modelRequestRouter: deniedRouter(calls),
		});

		await controller.prompt("should be denied");

		expect(calls.count).toBe(1);
		expect(calls.kind).toBe("interactive");
		expect(providerCalls).toBe(0);
		expect(controller.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		controller.dispose();
	});

	it("marks an idle recap as a separate route request kind while reusing the active provider", async () => {
		const selected = model();
		let providerCalls = 0;
		let requestKind: string | undefined;
		let requiredOutputTokens: number | undefined;
		const models = createModels();
		models.setProvider(createProvider({
			id: "fixture",
			name: "Fixture",
			auth: {
				apiKey: {
					name: "fixture",
					login: async () => ({ type: "api_key", key: "fixture" }),
					check: async () => ({ source: "fixture", type: "api_key" }),
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			models: [selected],
			api: {
				stream: (requestModel, context) => stopStream(requestModel, context),
				streamSimple: (requestModel, context) => {
					providerCalls += 1;
					return stopStream(requestModel, context);
				},
			},
		}));
		const controller = await InteractiveSessionController.create({
			cwd: process.cwd(),
			layout: buildRunledgerLayout(process.cwd(), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: "fixture", model: "model" },
			replay: { messages: [{ role: "user", content: [{ type: "text", text: "work" }] }], config: {}, auditEntries: [], warnings: [] },
			ledger: new MemoryLedger(),
			tools: [],
			modelRequestRouter: {
				route: async (request) => {
					requestKind = request.requestKind;
					requiredOutputTokens = request.requiredOutputTokens;
					return {
						requestId: request.requestId,
						outcome: "compatible",
						targetProviderId: selected.provider,
						targetModelId: selected.id,
						targetProfileId: request.targetProfileId,
						manifestDigest: request.contextDigest,
						reasonCode: "fixture_compatible",
						diagnostics: [],
						decisionDigest: request.contextDigest,
					};
				},
			},
		});
		await controller.login(selected.provider, "api_key", { prompt: async () => "fixture", notify: () => {} });

		await expect(controller.runEphemeralTurn({
			kind: "idle-recap",
			requestId: "idle-recap-route-fixture",
			ownerGeneration: 3,
			activityGeneration: 5,
			promptText: "recap",
			signal: new AbortController().signal,
		})).resolves.toContain("provider-called");
		expect(requestKind).toBe("idle-recap");
		expect(requiredOutputTokens).toBe(128);
		expect(providerCalls).toBe(1);
		controller.dispose();
	});

	it("keeps repeated idle recap route requests on distinct side-channel lineages", async () => {
		vi.useFakeTimers({ now: 1_000 });
		const selected = model();
		const routeIds: string[] = [];
		const models = createModels();
		models.setProvider(createProvider({
			id: "fixture",
			name: "Fixture",
			auth: {
				apiKey: {
					name: "fixture",
					login: async () => ({ type: "api_key", key: "fixture" }),
					check: async () => ({ source: "fixture", type: "api_key" }),
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			models: [selected],
			api: {
				stream: (requestModel, context) => stopStream(requestModel, context),
				streamSimple: (requestModel, context) => stopStream(requestModel, context),
			},
		}));
		const controller = await InteractiveSessionController.create({
			cwd: process.cwd(),
			layout: buildRunledgerLayout(process.cwd(), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: "fixture", model: "model" },
			replay: { messages: [{ role: "user", content: [{ type: "text", text: "work" }] }], config: {}, auditEntries: [], warnings: [] },
			ledger: new MemoryLedger(),
			tools: [],
			modelRequestRouter: {
				route: async (request) => {
					routeIds.push(request.requestId);
					return {
						requestId: request.requestId,
						outcome: "compatible",
						targetProviderId: selected.provider,
						targetModelId: selected.id,
						targetProfileId: request.targetProfileId,
						manifestDigest: request.contextDigest,
						reasonCode: "fixture_compatible",
						diagnostics: [],
						decisionDigest: request.contextDigest,
					};
				},
			},
		});
		await controller.login(selected.provider, "api_key", { prompt: async () => "fixture", notify: () => {} });

		try {
			await controller.runEphemeralTurn({ kind: "idle-recap", requestId: "idle-recap-lineage-reused", ownerGeneration: 7, activityGeneration: 11, promptText: "recap", signal: new AbortController().signal });
			await controller.runEphemeralTurn({ kind: "idle-recap", requestId: "idle-recap-lineage-reused", ownerGeneration: 8, activityGeneration: 1, promptText: "recap", signal: new AbortController().signal });

			expect(routeIds).toHaveLength(2);
			expect(routeIds[0]).not.toBe(routeIds[1]);
		} finally {
			controller.dispose();
			vi.useRealTimers();
		}
	});
});
