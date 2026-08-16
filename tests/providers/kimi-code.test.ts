import { afterEach, describe, expect, test, vi } from "vitest";
import { MODELS } from "../../src/models.generated.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { kimiCodeProvider } from "../../src/providers/kimi-code.ts";

const KIMI_CODE_BASE = "https://api.kimi.com/coding/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("kimi-code"),
		write: (entry) => store.write("kimi-code", entry),
		delete: () => store.delete("kimi-code"),
	};
}

function kimiCodeResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function headerValue(headers: unknown, name: string): string | undefined {
	const record = headers instanceof Headers ? Object.fromEntries(headers.entries()) : (headers as Record<string, string>);
	const key = Object.keys(record).find((entry) => entry.toLowerCase() === name.toLowerCase());
	return key ? record[key] : undefined;
}

describe("Kimi Code provider", () => {
	test("exposes the bundled OpenAI-compatible catalog, fixed headers, and env-key auth", async () => {
		const provider = kimiCodeProvider();
		const model = provider.getModels().find((entry) => entry.id === "k3");

		expect(provider.id).toBe("kimi-code");
		expect(provider.name).toBe("Kimi Code");
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "kimi-code",
			baseUrl: KIMI_CODE_BASE,
			reasoning: true,
			headers: { "User-Agent": "KimiCLI/1.0", "X-Msh-Platform": "kimi_cli" },
			compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "KIMI_API_KEY" ? "kimi-test-key" : undefined),
				fileExists: async () => false,
			},
		});
		expect(auth).toEqual({ auth: { apiKey: "kimi-test-key" }, source: "KIMI_API_KEY" });
	});

	test("advertises Kimi OAuth with the expected name and login label", () => {
		const provider = kimiCodeProvider();
		expect(provider.auth.oauth?.name).toBe("Kimi Code");
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Kimi");
	});

	test("is present in the generated model catalog", () => {
		const catalog = MODELS["kimi-code"] as Record<string, { id: string; provider: string; api: string }>;
		expect(Object.keys(MODELS)).toContain("kimi-code");
		expect(catalog["k3"]).toMatchObject({ provider: "kimi-code", api: "openai-completions" });
		expect(catalog["kimi-k2.5"]).toMatchObject({ provider: "kimi-code", api: "openai-completions" });
	});

	test("maps authenticated model metadata with static-reference fallback and preserved compat", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return kimiCodeResponse([
				{
					id: "k3",
					name: "K3 Refresh",
					context_window: 2000000,
					capabilities: ["reasoning", "tool_calling", "vision"],
				},
				{ id: "kimi-brand-new", name: "Brand New", context_window: 65536, capabilities: ["tool_calling"] },
			]);
		};
		const provider = kimiCodeProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Kimi Code provider must support model discovery");

		await refresh({
			credential: { type: "api_key", key: "kimi-test-key" },
			store: scopedStore(new InMemoryModelsStore()),
			allowNetwork: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: `${KIMI_CODE_BASE}/models`,
			init: {
				method: "GET",
				headers: { Authorization: "Bearer kimi-test-key", Accept: "application/json" },
			},
		});

		const k3 = provider.getModels().find((entry) => entry.id === "k3");
		expect(k3).toMatchObject({
			name: "K3 Refresh",
			provider: "kimi-code",
			baseUrl: KIMI_CODE_BASE,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 2000000,
			headers: { "User-Agent": "KimiCLI/1.0", "X-Msh-Platform": "kimi_cli" },
			// 生成目录的 compat 不被动态覆盖
			compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
		});

		const fresh = provider.getModels().find((entry) => entry.id === "kimi-brand-new");
		expect(fresh).toMatchObject({
			name: "Brand New",
			provider: "kimi-code",
			baseUrl: KIMI_CODE_BASE,
			reasoning: false,
			input: ["text"],
			compat: { supportsDeveloperRole: false },
		});
	});

	test("requires an API key for discovery", async () => {
		const fetchImpl: typeof fetch = async () => {
			throw new Error("must not be called");
		};
		const provider = kimiCodeProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Kimi Code provider must support model discovery");

		await expect(
			refresh({
				credential: { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
				store: scopedStore(new InMemoryModelsStore()),
				allowNetwork: true,
			}),
		).rejects.toThrow("Kimi Code API key is not configured");
	});

	test("rejects an empty catalog and keeps the last known good models", async () => {
		let response = kimiCodeResponse([{ id: "kimi/known-good", capabilities: ["tool_calling"] }]);
		const fetchImpl: typeof fetch = async () => response;
		const provider = kimiCodeProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Kimi Code provider must support model discovery");
		const store = scopedStore(new InMemoryModelsStore());
		const context = {
			credential: { type: "api_key" as const, key: "kimi-test-key" },
			store,
			allowNetwork: true,
		};

		await refresh(context);
		expect(provider.getModels().some((entry) => entry.id === "kimi/known-good")).toBe(true);

		response = kimiCodeResponse([]);
		await expect(refresh(context)).rejects.toThrow("empty model catalog");
		expect(provider.getModels().some((entry) => entry.id === "kimi/known-good")).toBe(true);
	});

	test("throws on a non-OK catalog response", async () => {
		const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500 });
		const provider = kimiCodeProvider({ fetch: fetchImpl });
		const refresh = provider.refreshModels;
		if (!refresh) throw new Error("Kimi Code provider must support model discovery");

		await expect(
			refresh({
				credential: { type: "api_key", key: "kimi-test-key" },
				store: scopedStore(new InMemoryModelsStore()),
				allowNetwork: true,
			}),
		).rejects.toThrow(/500/);
	});

	test("uses the existing OpenAI completions stream with Kimi identity and fixed headers", async () => {
		const modelId = "k3";
		const responseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl-kimi-test",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-kimi-test",
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
		const provider = kimiCodeProvider();
		const model = provider.getModels().find((entry) => entry.id === modelId);
		if (!model) throw new Error("Kimi Code bundled model is missing");

		const result = await provider
			.stream(
				model,
				{ messages: [{ role: "user", content: "say hello", timestamp: 1 }] },
				{ apiKey: "kimi-test-key" },
			)
			.result();
		expect(result).toMatchObject({
			provider: "kimi-code",
			model: modelId,
			stopReason: "stop",
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);

		const request = fetchSpy.mock.calls[0];
		expect(request?.[0]).toBe(`${KIMI_CODE_BASE}/chat/completions`);
		expect(request?.[1]?.method).toBe("POST");
		const headers = request?.[1]?.headers;
		expect(headerValue(headers, "authorization")).toBe("Bearer kimi-test-key");
		// 模型级固定请求头流入真实请求
		expect(headerValue(headers, "user-agent")).toBe("KimiCLI/1.0");
		expect(headerValue(headers, "x-msh-platform")).toBe("kimi_cli");
	});
});
