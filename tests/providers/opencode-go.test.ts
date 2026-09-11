import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, getSupportedThinkingLevels, type Provider } from "../../src/models.ts";
import { buildParams } from "../../src/api/openai-completions/params.ts";
import { InMemoryModelsStore, type ProviderModelsStore } from "../../src/models-store.ts";
import { opencodeGoProvider } from "../../src/providers/opencode-go.ts";
import { createSessionModelStreamFn } from "../../src/runtime/agents/child-model-runtime.ts";
import type { CacheRetention, Model } from "../../src/types.ts";

type GoApi = "openai-completions" | "anthropic-messages" | "openai-responses";
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => error ? reject(error) : resolve());
	})));
});

function sse(api: GoApi): string {
	const events = api === "anthropic-messages" ? [
		{ type: "message_start", message: { id: "msg-go", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	] : api === "openai-responses" ? [
		{ type: "response.completed", response: { id: "resp-go", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	] : [
		{ id: "chat-go", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
		{ id: "chat-go", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
}

async function endpoint(api: GoApi) {
	const requests: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		requests.push(request.headers);
		request.resume();
		if (!request.headers["x-opencode-session"]) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "MissingSessionID", message: "Request is missing x-opencode-session" }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(sse(api));
	});
	servers.push(server);
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing test server address");
	const provider = opencodeGoProvider();
	const source = provider.getModels().find((model) => model.api === api);
	if (source === undefined) throw new Error(`missing Go model for ${api}`);
	const model = { ...source, baseUrl: `http://127.0.0.1:${address.port}`, reasoning: false } as Model<GoApi>;
	return { requests, provider, model };
}

const APIs: readonly GoApi[] = ["openai-completions", "anthropic-messages", "openai-responses"];
const RETENTIONS: readonly CacheRetention[] = ["none", "short"];
describe("OpenCode Go conversation routing", () => {
	it("keeps max through the simple stream request path for V4.1 Flash", async () => {
		const { provider, model: localModel } = await endpoint("openai-completions");
		const source = provider.getModels().find((model) => model.id === "deepseek-v4.1-flash");
		if (!source) throw new Error("missing V4.1 Flash model");
		let payload: unknown;
		const result = await provider.streamSimple({ ...source, baseUrl: localModel.baseUrl }, { messages: [] }, {
			apiKey: "fixture-key", sessionId: "thinking-max-session", reasoning: "max",
			onPayload: (value) => { payload = value; },
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(payload).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
	});

	for (const api of APIs) {
		it.each(RETENTIONS)(`${api} preserves Session Owner identity with cache retention %s`, async (cacheRetention) => {
			const { requests, provider, model } = await endpoint(api);
			const models = createModels();
			models.setProvider(provider);
			for (const sessionId of ["session-go-a", "session-go-a", "session-go-b"]) {
				const stream = createSessionModelStreamFn({ models, sessionId });
				const result = await (await stream(model, { systemPrompt: "coding agent", messages: [], tools: [] }, {
					apiKey: "fixture-key", cacheRetention, headers: { "X-Test": "preserved" }, sessionId: "must-not-replace-owner",
				})).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
			}
			expect(requests.map((headers) => headers["x-opencode-session"])).toEqual(["session-go-a", "session-go-a", "session-go-b"]);
			for (const headers of requests) {
				expect(headers["user-agent"]).toBe("RunLedger");
				expect(headers["x-test"]).toBe("preserved");
			}
		});

		it(`${api} also supports direct provider streams and explicit client headers`, async () => {
			const { requests, provider, model } = await endpoint(api);
			const result = await provider.stream(model, { messages: [] }, {
				apiKey: "fixture-key", sessionId: "direct-session", cacheRetention: "none",
				headers: { "user-agent": "fixture-agent/1.0", "X-Test": "preserved" },
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(requests[0]).toMatchObject({ "x-opencode-session": "direct-session", "user-agent": "fixture-agent/1.0", "x-test": "preserved" });
		});
	}
});

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("opencode-go"),
		write: (entry) => store.write("opencode-go", entry),
		delete: () => store.delete("opencode-go"),
	};
}

function catalogResponse(data: readonly Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function refresh(provider: Provider<GoApi>, credential: boolean) {
	const refreshModels = provider.refreshModels;
	if (!refreshModels) throw new Error("OpenCode Go provider must support model discovery");
	await refreshModels({
		...(credential ? { credential: { type: "api_key" as const, key: "go-test-key" } } : {}),
		store: scopedStore(new InMemoryModelsStore()),
		allowNetwork: true,
	});
}

/**
 * /models 返回的是更宽的路由目录,不能证明 Go 套餐包含该模型。
 * 静态、网络与旧缓存都必须收敛到已核对的套餐范围。
 */
describe("OpenCode Go model discovery", () => {
	it("preserves V4.1 Flash effort choices and serializes max after discovery", async () => {
		const provider = opencodeGoProvider({ fetch: async () => catalogResponse([{ id: "deepseek-v4.1-flash" }]) });
		for (const online of [false, true]) {
			if (online) await refresh(provider, true);
			const model = provider.getModels().find((candidate) => candidate.id === "deepseek-v4.1-flash");
			if (!model || model.api !== "openai-completions") throw new Error("missing V4.1 Flash completions model");
			const completionsModel: Model<"openai-completions"> = { ...model, api: "openai-completions" };
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			for (const reasoningEffort of ["low", "high", "max"] as const) {
				expect(buildParams(completionsModel, { messages: [] }, { reasoningEffort })).toMatchObject({
					thinking: { type: "enabled" }, reasoning_effort: reasoningEffort,
				});
			}
			expect(buildParams(completionsModel, { messages: [] })).toMatchObject({ thinking: { type: "disabled" } });
			expect(buildParams(completionsModel, { messages: [] })).not.toHaveProperty("reasoning_effort");
		}
	});

	it("gates discovery behind an API key", async () => {
		const fetchImpl = vi.fn(async () => catalogResponse([]));
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await expect(refresh(provider, false)).rejects.toThrow("OpenCode Go API key is not configured");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fetches the documented /models endpoint with bearer auth", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return catalogResponse([{ id: "deepseek-v4.1-flash" }]);
		};
		await refresh(opencodeGoProvider({ fetch: fetchImpl }), true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://opencode.ai/zen/go/v1/models",
			init: {
				method: "GET",
				headers: { Authorization: "Bearer go-test-key", Accept: "application/json" },
			},
		});
	});

	it("intersects the endpoint catalog with the reviewed Go plan", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "deepseek-v4.1-flash" },
				{ id: "hy3-preview" },
				{ id: "omen-alpha" },
				{ id: "qwen3.7-max" },
				{ id: "gpt-5.6-luna" },
			]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		// 基线的 `ox-alpha-free` 已按 provider 退役移除,不会再回到列表。
		expect(provider.getModels().map((model) => model.id)).not.toContain("ox-alpha-free");

		await refresh(provider, true);

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("deepseek-v4.1-flash");
		expect(ids).not.toContain("hy3-preview");
		expect(ids).not.toContain("omen-alpha");
		// 端点仍可剪除缺失项,但不能把套餐外条目加入选择器。
		expect(ids).not.toContain("kimi-k3");
		expect(ids).not.toContain("ox-alpha-free");
	});

	it("keeps the reviewed api and baseUrl of known models instead of re-deriving them", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "minimax-m3", provider: { npm: "@ai-sdk/openai-compatible" } },
				{ id: "gpt-5.6-luna", provider: { npm: "@ai-sdk/openai-compatible" } },
				{ id: "kimi-k3" },
			]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await refresh(provider, true);
		expect(provider.getModels().find((model) => model.id === "minimax-m3")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen/go",
		});
		expect(provider.getModels().find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
	});

	it("does not invent routable models for undocumented endpoint IDs", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([{ id: "deepseek-v4.1-flash" }, { id: "kimi-k2.6-future" }, { id: "brand-new" }]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await refresh(provider, true);
		const discovered = provider.getModels().find((model) => model.id === "deepseek-v4.1-flash");
		expect(discovered).toMatchObject({
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			// 套餐新模型由生成目录提供审核后的完整元数据。
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		expect(provider.getModels().find((model) => model.id === "brand-new")).toBeUndefined();
		expect(provider.getModels().find((model) => model.id === "kimi-k2.6-future")).toBeUndefined();
	});

	it("does not let endpoint protocol metadata admit a model outside the Go plan", async () => {
		const fetchImpl: typeof fetch = async () => catalogResponse([
			{ id: "kimi-k3" },
			{ id: "future-anthropic", provider: { npm: "@ai-sdk/anthropic" } },
			{ id: "future-openai", provider: { npm: "@ai-sdk/openai" } },
		]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await refresh(provider, true);
		expect(provider.getModels().map((model) => model.id)).toEqual(["kimi-k3"]);
	});

	it("keeps the last known-good catalog when discovery fails", async () => {
		const fetchImpl: typeof fetch = async () => new Response("boom", { status: 502 });
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		const before = provider.getModels().map((model) => model.id);
		await expect(refresh(provider, true)).rejects.toThrow("Could not load OpenCode Go models: 502: boom");
		expect(provider.getModels().map((model) => model.id)).toEqual(before);
	});

	it("reduces the 37 routing IDs to the 27 included models and rejects GLM-5 lookup", async () => {
		const included = [
			"grok-4.6", "gpt-5.6-luna", "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1",
			"kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "longcat-2.0", "deepseek-v4.1-flash",
			"deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.5",
			"mimo-v2.5-pro", "minimax-m3", "minimax-m2.7", "muse-spark-1.3-contributor",
			"muse-spark-1.2-contributor", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max",
			"qwen3.7-plus", "qwen3.6-plus", "hy4-preview", "hy3",
		];
		const excluded = ["glm-5", "kimi-k2.5", "minimax-m2.5", "qwen3.5-plus", "mimo-v2-pro",
			"mimo-v2-omni", "grok-4.5", "hy3-preview", "omen-alpha", "deepseek-flash"];
		const provider = opencodeGoProvider({ fetch: async () => catalogResponse(
			[...included, ...excluded].map((id) => ({ id })),
		) });
		await refresh(provider, true);
		const models = createModels();
		models.setProvider(provider);
		expect(models.getModels("opencode-go").map((model) => model.id).sort()).toEqual([...included].sort());
		expect(models.getModel("opencode-go", "glm-5")).toBeUndefined();
	});

	it("filters legacy cached routing catalogs even during offline restoration", async () => {
		const provider = opencodeGoProvider();
		const reference = provider.getModels().find((model) => model.id === "glm-5.1");
		if (!reference) throw new Error("fixture model unavailable");
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [reference, { ...reference, id: "glm-5" }] });
		await provider.refreshModels?.({ allowNetwork: false, store: scopedStore(store) });
		expect(provider.getModels().map((model) => model.id)).toEqual(["glm-5.1"]);
	});

	it("excludes the provider-retired model from the static baseline", () => {
		// 刷新不可用(离线/未配置)时用户只能看到静态基线;已下线的模型不能从这里出现。
		const ids = opencodeGoProvider().getModels().map((model) => model.id);
		expect(ids).not.toContain("ox-alpha-free");
		expect(ids).toHaveLength(27);
		expect(ids).not.toContain("glm-5");
		expect(ids).toContain("glm-5.1");
		expect(ids).toContain("deepseek-v4.1-flash");
	});
});
