import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiKeyCredential, AuthEvent } from "../../src/auth/types.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { kiloProvider } from "../../src/providers/kilo.ts";
import { builtinModels, builtinProviders } from "../../src/providers/all.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("kilo"),
		write: (entry) => store.write("kilo", entry),
		delete: () => store.delete("kilo"),
	};
}

function deviceCodeResponse(): Response {
	return new Response(
		JSON.stringify({
			code: "ABCD-EFGH",
			verificationUrl: "https://app.kilo.ai/device-auth?code=ABCD-EFGH",
			expiresIn: 300,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Kilo Gateway provider", () => {
	test("exposes the bundled catalog, gateway base URL, and env-key auth", async () => {
		const provider = kiloProvider();

		expect(provider.id).toBe("kilo");
		expect(provider.name).toBe("Kilo Gateway");
		expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway");
		expect(provider.getModels().find((entry) => entry.id === "ai21/jamba-large-1.7")).toMatchObject({
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "KILO_API_KEY" ? "kilo-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "kilo-test-key" }, source: "KILO_API_KEY" });
	});

	test("auth resolve prefers the stored key and fails closed without one", async () => {
		const provider = kiloProvider();
		const ctx = {
			env: async (name: string) => (name === "KILO_API_KEY" ? "kilo-env-key" : undefined),
			fileExists: async () => false,
		};
		const stored = await provider.auth.apiKey?.resolve({
			ctx,
			credential: { type: "api_key", key: "kilo-stored-key" },
		});
		expect(stored).toEqual({ auth: { apiKey: "kilo-stored-key" }, source: "stored credential" });

		const ambient = await provider.auth.apiKey?.resolve({ ctx });
		expect(ambient).toEqual({ auth: { apiKey: "kilo-env-key" }, source: "KILO_API_KEY" });

		const none = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
		});
		expect(none).toBeUndefined();
	});

	test("device login completes after a pending poll", async () => {
		vi.useFakeTimers();
		let polls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			if (String(input).endsWith("/codes")) return deviceCodeResponse();
			polls += 1;
			if (polls === 1) return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
			return new Response(JSON.stringify({ status: "approved", token: "kilo-test-token" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const provider = kiloProvider({ fetch: fetchImpl });
		if (!provider.auth.apiKey?.login) throw new Error("Kilo Gateway must support device login");

		const events: AuthEvent[] = [];
		const login = provider.auth.apiKey.login({
			notify: (event) => events.push(event),
			prompt: async () => "",
		});
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(5000);
		const credential: ApiKeyCredential | undefined = await login;

		expect(credential).toEqual({ type: "api_key", key: "kilo-test-token" });
		expect(polls).toBe(2);
		expect(events).toContainEqual({
			type: "auth_url",
			url: "https://app.kilo.ai/device-auth?code=ABCD-EFGH",
			instructions: "Enter code: ABCD-EFGH",
		});
	});

	test("device login throws when authorization is denied", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			if (String(input).endsWith("/codes")) return deviceCodeResponse();
			return new Response(JSON.stringify({ status: "denied" }), { status: 403 });
		};
		const provider = kiloProvider({ fetch: fetchImpl });
		if (!provider.auth.apiKey?.login) throw new Error("Kilo Gateway must support device login");

		await expect(
			provider.auth.apiKey.login({
				notify: () => {},
				prompt: async () => "",
			}),
		).rejects.toThrow("Authorization was denied");
	});

	test("device login throws when the authorization code expires", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			if (String(input).endsWith("/codes")) return deviceCodeResponse();
			return new Response(JSON.stringify({ status: "expired" }), { status: 410 });
		};
		const provider = kiloProvider({ fetch: fetchImpl });
		if (!provider.auth.apiKey?.login) throw new Error("Kilo Gateway must support device login");

		await expect(
			provider.auth.apiKey.login({
				notify: () => {},
				prompt: async () => "",
			}),
		).rejects.toThrow("Authorization code expired. Please try again.");
	});

	test("discovers models without a key and keeps the last known good on empty", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		let response = new Response(
			JSON.stringify({
				data: [
					{
						id: "kilo-auto/frontier",
						name: "Auto Frontier",
						context_length: 1000000,
						max_completion_tokens: 128000,
					},
					{ id: "ai21/jamba-large-1.7", name: "Jamba Large 1.7", context_length: 300000 },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return response;
		};
		const provider = kiloProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Kilo Gateway provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = { store, allowNetwork: true };

		await refresh(context);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://api.kilo.ai/api/gateway/models",
			init: { method: "GET", headers: { Accept: "application/json" } },
		});
		expect(calls[0].init?.headers).not.toHaveProperty("Authorization");

		const models = provider.getModels();
		expect(models.find((entry) => entry.id === "kilo-auto/frontier")).toMatchObject({
			name: "Auto Frontier",
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
			contextWindow: 1000000,
			maxTokens: 128000,
		});
		expect(models.find((entry) => entry.id === "ai21/jamba-large-1.7")).toMatchObject({
			contextWindow: 300000,
			maxTokens: 4096,
		});

		response = new Response(JSON.stringify({ data: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "kilo-auto/frontier")).toBe(true);
	});

	test("streams a bundled model through the OpenAI completions adapter", async () => {
		const modelId = "ai21/jamba-large-1.7";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-kilo-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-kilo-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}`,
			"data: [DONE]",
		].join("\n\n");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const provider = kiloProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("Kilo Gateway bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "kilo-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "kilo",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe("https://api.kilo.ai/api/gateway/chat/completions");
	});
});
