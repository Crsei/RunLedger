import { describe, expect, test } from "vitest";
import type { Api, AssistantMessage, Context, Model, ProviderStreams } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import {
	createProxyProvider,
	type ProxyProviderOptions,
	type ProxyWire,
	type ProxyWireProbeInput,
} from "../../src/providers/proxy-provider.ts";

function scopedStore(store: InMemoryModelsStore, providerId: string): ProviderModelsStore {
	return {
		read: () => store.read(providerId),
		write: (entry) => store.write(providerId, entry),
		delete: () => store.delete(providerId),
	};
}

function model(id: string, api: ProxyWire = "openai-completions"): Model<ProxyWire> {
	return {
		id,
		name: id,
		api,
		provider: "team-proxy",
		baseUrl: "https://models.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function stoppedStream(requestModel: Model<Api>, text: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function transportSet(
	calls: Array<{ wire: ProxyWire; model: Model<Api> }>,
	responses: Record<ProxyWire, string> = {
		"anthropic-messages": "anthropic",
		"openai-completions": "openai",
	},
): Partial<Record<ProxyWire, ProviderStreams>> {
	return Object.fromEntries(
		(["anthropic-messages", "openai-completions"] as const).map((wire) => [
			wire,
			{
				stream: (requestModel: Model<Api>, _context: Context) => {
					calls.push({ wire, model: requestModel });
					return stoppedStream(requestModel, responses[wire]);
				},
				streamSimple: (requestModel: Model<Api>, _context: Context) => {
					calls.push({ wire, model: requestModel });
					return stoppedStream(requestModel, responses[wire]);
				},
			},
		]),
	) as Partial<Record<ProxyWire, ProviderStreams>>;
}

function baseOptions(overrides: Partial<ProxyProviderOptions> = {}): ProxyProviderOptions {
	return {
		id: "team-proxy",
		config: {
			baseUrl: "https://models.example.test/v1",
			apiKey: "TEAM_PROXY_API_KEY",
			discovery: { type: "proxy" },
		},
		...overrides,
	};
}

describe("configuration-driven upstream proxy provider", () => {
	test("resolves configured auth and preserves custom headers", async () => {
		const provider = createProxyProvider(
			baseOptions({
				config: {
					baseUrl: "https://models.example.test/v1",
					apiKey: "TEAM_PROXY_API_KEY",
					headers: { "x-team": "alpha" },
					discovery: { type: "proxy" },
				},
			}),
		);

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "TEAM_PROXY_API_KEY" ? "env-secret" : undefined),
				fileExists: async () => false,
			},
		});

		expect(auth).toEqual({
			auth: { apiKey: "env-secret", headers: { "x-team": "alpha" } },
			source: "TEAM_PROXY_API_KEY",
		});
	});

	test("fetches the OpenAI-compatible catalog and maps entries to safe defaults", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({ data: [{ id: "model-a", name: "Model A" }, { id: "" }, { name: "missing-id" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const provider = createProxyProvider(
			baseOptions({
				config: {
					baseUrl: "https://models.example.test",
					apiKey: "TEAM_PROXY_API_KEY",
					discovery: { type: "proxy" },
				},
				fetch: fetchImpl,
			}),
		);
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("proxy provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "stored-secret" },
			store: scopedStore(new InMemoryModelsStore(), "team-proxy"),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://models.example.test/v1/models",
			init: { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer stored-secret" } },
		});
		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "model-a",
				name: "Model A",
				api: "openai-completions",
				provider: "team-proxy",
				baseUrl: "https://models.example.test/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 4096,
			}),
		]);
	});

	test("restores a stored catalog without network access and retains it after refresh failure", async () => {
		const store = new InMemoryModelsStore();
		const storedModel = model("stored-model");
		await store.write("team-proxy", { models: [storedModel], checkedAt: 10 });
		let networkCalls = 0;
		const provider = createProxyProvider(
			baseOptions({
				fetch: async () => {
					networkCalls += 1;
					return new Response(JSON.stringify({ data: [] }), { status: 200 });
				},
			}),
		);
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("proxy provider must support model discovery");
		const context = {
			credential: { type: "api_key" as const, key: "stored-secret" },
			store: scopedStore(store, "team-proxy"),
			allowNetwork: false,
		};

		await refresh(context);
		expect(provider.getModels()).toEqual([storedModel]);
		expect(networkCalls).toBe(0);

		await expect(refresh({ ...context, allowNetwork: true })).rejects.toThrow(/empty|catalog/i);
		expect(provider.getModels()).toEqual([storedModel]);
	});

	test("probes in frozen order, dispatches the selected wire, and caches the result", async () => {
		const calls: Array<{ wire: ProxyWire; model: Model<Api> }> = [];
		const probes: ProxyWire[] = [];
		const provider = createProxyProvider(
			baseOptions({
				config: {
					baseUrl: "https://models.example.test/v1",
					apiKey: "TEAM_PROXY_API_KEY",
					authHeader: true,
					disableStrictTools: true,
					discovery: { type: "proxy" },
				},
				probe: async ({ wire }: ProxyWireProbeInput) => {
					probes.push(wire);
					return wire === "anthropic-messages" ? { accepted: false, status: 401 } : { accepted: true, status: 200 };
				},
				transports: transportSet(calls),
			}),
		);
		const requestModel = model("dispatch-model");
		const context: Context = { messages: [] };

		const first = await provider.stream(requestModel, context, { apiKey: "stored-secret" }).result();
		const second = await provider.stream(requestModel, context, { apiKey: "stored-secret" }).result();

		expect(first.content).toEqual([{ type: "text", text: "openai" }]);
		expect(second.content).toEqual([{ type: "text", text: "openai" }]);
		expect(probes).toEqual(["anthropic-messages", "openai-completions"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.model).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://models.example.test/v1",
			compat: { supportsStrictMode: false },
		});
	});

	test("routes Anthropic models with the stripped SDK base URL and authHeader policy", async () => {
		const calls: Array<{ wire: ProxyWire; model: Model<Api> }> = [];
		const provider = createProxyProvider(
			baseOptions({
				config: {
					baseUrl: "https://models.example.test/v1",
					apiKey: "TEAM_PROXY_API_KEY",
					authHeader: true,
					discovery: { type: "proxy" },
				},
				probe: async () => ({ accepted: true, status: 200 }),
				transports: transportSet(calls),
			}),
		);

		const result = await provider.stream(model("anthropic-model"), { messages: [] }, { apiKey: "stored-secret" }).result();

		expect(result.content).toEqual([{ type: "text", text: "anthropic" }]);
		expect(calls[0]?.model).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://models.example.test",
			compat: { authHeader: true },
		});
	});
});
