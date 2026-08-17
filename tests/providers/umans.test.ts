import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { umansProvider } from "../../src/providers/umans.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("umans"),
		write: (entry) => store.write("umans", entry),
		delete: () => store.delete("umans"),
	};
}

function umansInfoResponse(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function umansAnthropicSse(text: string): string {
	const events = [
		[
			"event: message_start",
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "umans-coder",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 2, output_tokens: 0 },
				},
			})}`,
		],
		[
			"event: content_block_start",
			`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		],
		[
			"event: content_block_delta",
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
		],
		["event: content_block_stop", `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`],
		[
			"event: message_delta",
			`data: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 3 },
			})}`,
		],
		["event: message_stop", `data: ${JSON.stringify({ type: "message_stop" })}`],
	];
	return events.map((lines) => lines.join("\n")).join("\n\n");
}

describe("umans provider", () => {
	test("exposes the bundled catalog and env-key auth", async () => {
		const provider = umansProvider();
		const model = provider.getModels().find((entry) => entry.id === "umans-coder");

		expect(provider.id).toBe("umans");
		expect(provider.name).toBe("Umans AI Coding Plan");
		expect(provider.baseUrl).toBe("https://api.code.umans.ai");
		expect(model).toMatchObject({
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "UMANS_AI_CODING_PLAN_API_KEY" ? "umans-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "umans-test-key" }, source: "UMANS_AI_CODING_PLAN_API_KEY" });
	});

	test("is present in the builtin provider and model collections", () => {
		expect(builtinProviders().find((provider) => provider.id === "umans")?.name).toBe("Umans AI Coding Plan");
		expect(builtinModels().getModel("umans", "umans-coder")).toMatchObject({
			provider: "umans",
			api: "anthropic-messages",
		});
	});

	test("maps /models/info entries onto anthropic models with x-api-key auth", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return umansInfoResponse({
				"umans-coder": {
					display_name: "Umans Coder",
					capabilities: {
						supports_tools: true,
						reasoning: {
							supported: true,
							levels: ["low", "medium", "high", "xhigh"],
							can_disable: false,
							default_level: "medium",
						},
						supports_vision: true,
						context_window: 262144,
						recommended_max_tokens: 32768,
					},
				},
				"umans-new-model": {
					name: "Umans New Model",
					capabilities: {
						supports_vision: "via-handoff",
						context_window: 131072,
						max_completion_tokens: 16384,
					},
				},
			});
		};
		const provider = umansProvider({ baseUrl: "https://config.umans.test", fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("umans provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "umans-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://config.umans.test/v1/models/info",
			init: { method: "GET", headers: { Accept: "application/json", "x-api-key": "umans-test-key" } },
		});
		const headers = calls[0].init?.headers;
		expect(headers instanceof Headers ? headers.get("authorization") : undefined).toBeUndefined();

		// 已知 id 继承静态 cost,reasoning levels → thinkingLevelMap,off 因 can_disable:false 禁用
		expect(provider.getModels().find((entry) => entry.id === "umans-coder")).toMatchObject({
			name: "Umans Coder",
			provider: "umans",
			baseUrl: "https://config.umans.test",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		});
		// supports_vision 哨兵值("via-handoff")必须映射为纯文本
		expect(provider.getModels().find((entry) => entry.id === "umans-new-model")).toMatchObject({
			name: "Umans New Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 16384,
		});
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = umansInfoResponse({ "umans/known-good": { capabilities: {} } });
		const fetchImpl: typeof fetch = async () => response;
		const provider = umansProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("umans provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { credential: { type: "api_key" as const, key: "umans-test-key" }, store, allowNetwork: true };

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "umans/known-good")).toBe(true);

		response = umansInfoResponse({});
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "umans/known-good")).toBe(true);
	});

	test("dispatches streaming through the anthropic messages api with umans identity", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(umansAnthropicSse("hello"), { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = umansProvider();
		const model = provider.getModels().find((entry) => entry.id === "umans-coder");
		if (!model) throw new Error("umans bundled model is missing");

		const result = await provider
			.stream(model, { messages: [{ role: "user", content: "say hello", timestamp: 1 }] }, { apiKey: "umans-test-key" })
			.result();
		expect(result).toMatchObject({ provider: "umans", model: "umans-coder", stopReason: "stop" });
		expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.code.umans.ai/v1/messages");
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		const headerRecord = headers instanceof Headers ? headers : new Headers(headers);
		expect(headerRecord.get("x-api-key")).toBe("umans-test-key");
		expect(headerRecord.get("authorization")).toBeNull();
	});
});
