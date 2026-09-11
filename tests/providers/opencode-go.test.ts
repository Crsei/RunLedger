import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, type Provider } from "../../src/models.ts";
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
 * /models 端点比 models.dev 与 bundled snapshot 更新:它提供 deepseek-v4.1-flash、
 * hy3-preview 等上游 catalog 尚未收录的模型,也停止提供 ox-alpha-free。
 * 没有 discovery 时 TUI 只看到过期静态列表。
 */
describe("OpenCode Go model discovery", () => {
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

	it("prunes baseline models the endpoint no longer serves", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "deepseek-v4.1-flash" },
				{ id: "hy3-preview" },
				{ id: "omen-alpha" },
				{ id: "qwen3.7-max" },
				{ id: "gpt-5.6-luna" },
			]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		expect(provider.getModels().map((model) => model.id)).toContain("ox-alpha-free");

		await refresh(provider, true);

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("deepseek-v4.1-flash");
		expect(ids).toContain("hy3-preview");
		expect(ids).toContain("omen-alpha");
		// opencode-go 的端点列表是权威目录:基线里已被 provider 下线的模型不再出现。
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

	it("resolves endpoint-only models to a routable api with conservative defaults", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([{ id: "deepseek-v4.1-flash" }, { id: "kimi-k2.6-future" }, { id: "brand-new" }]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await refresh(provider, true);
		const discovered = provider.getModels().find((model) => model.id === "deepseek-v4.1-flash");
		expect(discovered).toMatchObject({
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			// /models 不返回能力字段:沿用其它动态 provider 的保守默认,不臆测窗口。
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		expect(provider.getModels().find((model) => model.id === "brand-new")).toMatchObject({
			api: "openai-completions",
		});
	});

	it("falls back to completions when npm metadata is absent and honors the Go overrides", async () => {
		const fetchImpl: typeof fetch = async () =>
			catalogResponse([
				{ id: "minimax-m2.9" },
				{ id: "future-anthropic", provider: { npm: "@ai-sdk/anthropic" } },
				{ id: "future-openai", provider: { npm: "@ai-sdk/openai" } },
			]);
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		await refresh(provider, true);
		expect(provider.getModels().find((model) => model.id === "minimax-m2.9")).toMatchObject({
			api: "openai-completions",
		});
		expect(provider.getModels().find((model) => model.id === "future-anthropic")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen/go",
		});
		expect(provider.getModels().find((model) => model.id === "future-openai")).toMatchObject({
			api: "openai-responses",
		});
	});

	it("keeps the last known-good catalog when discovery fails", async () => {
		const fetchImpl: typeof fetch = async () => new Response("boom", { status: 502 });
		const provider = opencodeGoProvider({ fetch: fetchImpl });
		const before = provider.getModels().map((model) => model.id);
		await expect(refresh(provider, true)).rejects.toThrow("Could not load OpenCode Go models: 502: boom");
		expect(provider.getModels().map((model) => model.id)).toEqual(before);
	});
});
