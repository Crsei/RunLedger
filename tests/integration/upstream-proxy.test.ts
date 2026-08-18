import type { Context, Model, Tool } from "../../src/types.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createProxyProvider } from "../../src/providers/proxy-provider.ts";
import type { ProxyWire } from "../../src/providers/proxy-discovery.ts";
import { startDualWireProxy, type DualWireProxy } from "../fixtures/dual-wire-proxy.ts";

const openProxies: DualWireProxy[] = [];

afterEach(async () => {
	while (openProxies.length > 0) await openProxies.pop()?.close();
});

function model(provider: string, baseUrl: string): Model<ProxyWire> {
	return {
		id: "fixture-model",
		name: "Fixture Model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 128,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function createFixtureProvider(proxy: DualWireProxy, config: Record<string, unknown> = {}, providerId = "fixture-proxy", useFetch = true) {
	return createProxyProvider({
		id: providerId,
		config: {
			baseUrl: proxy.baseUrl,
			apiKey: "FIXTURE_API_KEY",
			discovery: { type: "proxy", timeoutMs: 1000 },
			...config,
		},
		...(useFetch ? { fetch } : {}),
	});
}

describe("real dual-wire upstream proxy fixture", () => {
	test("probes Anthropic first, then dispatches OpenAI and reuses the selected wire", async () => {
		const proxy = await startDualWireProxy({ acceptedWire: "openai-completions" });
		openProxies.push(proxy);
		const provider = createFixtureProvider(proxy);
		const requestModel = model("fixture-proxy", proxy.baseUrl);

		const first = await provider.stream(requestModel, context, { apiKey: "fixture-secret" }).result();
		const second = await provider.stream(requestModel, context, { apiKey: "fixture-secret" }).result();

		expect(first.content).toEqual([{ type: "text", text: "fixture-openai" }]);
		expect(second.content).toEqual([{ type: "text", text: "fixture-openai" }]);
		expect(proxy.observations.map((entry) => entry.url)).toEqual([
			"/v1/messages",
			"/v1/chat/completions",
			"/v1/chat/completions",
			"/v1/chat/completions",
		]);
		expect(proxy.observations[1]?.headers.authorization).toBe("Bearer fixture-secret");
	});

	test("sends x-api-key on the Anthropic wire by default and Authorization when enabled", async () => {
		const defaultProxy = await startDualWireProxy({ acceptedWire: "anthropic-messages" });
		openProxies.push(defaultProxy);
		const defaultProvider = createFixtureProvider(defaultProxy);
		await defaultProvider.stream(model("fixture-proxy", defaultProxy.baseUrl), context, { apiKey: "fixture-secret" }).result();

		expect(defaultProxy.observations).toHaveLength(2);
		expect(defaultProxy.observations[1]?.headers["x-api-key"]).toBe("fixture-secret");
		expect(defaultProxy.observations[1]?.headers.authorization).toBeUndefined();

		const headerProxy = await startDualWireProxy({ acceptedWire: "anthropic-messages" });
		openProxies.push(headerProxy);
		const headerProvider = createFixtureProvider(headerProxy, { authHeader: true });
		await headerProvider.stream(model("fixture-proxy", headerProxy.baseUrl), context, { apiKey: "fixture-secret" }).result();

		expect(headerProxy.observations[1]?.headers.authorization).toBe("Bearer fixture-secret");
		expect(headerProxy.observations[1]?.headers["x-api-key"]).toBeUndefined();
	});

	test("omits strict tool metadata when the proxy disables strict tools", async () => {
		const proxy = await startDualWireProxy({ acceptedWire: "openai-completions" });
		openProxies.push(proxy);
		const provider = createFixtureProvider(proxy, { disableStrictTools: true });
		const tool: Tool = {
			name: "lookup",
			description: "Look up a value",
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
		};

		await provider
			.stream(model("fixture-proxy", proxy.baseUrl), { ...context, tools: [tool] }, { apiKey: "fixture-secret" })
			.result();

		const request = proxy.observations.at(-1);
		if (!request) throw new Error("fixture did not observe the OpenAI request");
		const body = JSON.parse(request.body) as { tools?: Array<{ function?: { strict?: unknown } }> };
		expect(body.tools?.[0]?.function?.strict).toBeUndefined();
	});

	test("keeps an empty tools array for OpenAI tool-call history", async () => {
		const proxy = await startDualWireProxy({ acceptedWire: "openai-completions" });
		openProxies.push(proxy);
		const provider = createFixtureProvider(proxy);
		const historyContext: Context = {
			messages: [
				...context.messages,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-fixture", name: "lookup", arguments: { value: "x" } }],
					api: "openai-completions",
					provider: "fixture-proxy",
					model: "fixture-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-fixture",
					toolName: "lookup",
					content: [{ type: "text", text: "value" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		await provider.stream(model("fixture-proxy", proxy.baseUrl), historyContext, { apiKey: "fixture-secret" }).result();

		const request = proxy.observations.at(-1);
		if (!request) throw new Error("fixture did not observe the OpenAI request");
		const body = JSON.parse(request.body) as { tools?: unknown };
		expect(body.tools).toEqual([]);
	});

	test("composes the upstream proxy with a provider-scoped outbound proxy", async () => {
		const proxy = await startDualWireProxy({ acceptedWire: "openai-completions" });
		openProxies.push(proxy);
		const providerId = "fixture-stacked";
		const provider = createFixtureProvider(
			proxy,
			{ baseUrl: "http://upstream-models.runledger.test/v1" },
			providerId,
			false,
		);
		const env = {
			RUNLEDGER_PROXY_FIXTURE_STACKED: proxy.baseUrl,
			no_proxy: "",
		};

		const result = await provider
			.stream(model(providerId, "http://upstream-models.runledger.test/v1"), context, { apiKey: "fixture-secret", env })
			.result();

		expect(result.content).toEqual([{ type: "text", text: "fixture-openai" }]);
		expect(proxy.observations.map((entry) => entry.url)).toEqual([
			"/v1/messages",
			"/v1/chat/completions",
			"/v1/chat/completions",
		]);
	});
});
