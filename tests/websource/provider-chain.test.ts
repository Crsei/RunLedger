/**
 * provider 注册表与 fallback 链测试。
 *
 * 覆盖移植层相对上游的三处行为差异（见开发计划 §3 D4/D5）:
 * - 注册表是静态导入，但按需构造;
 * - Tier C 未移植 id 不出现在候选链里，显式选中时给 typed 错误而不是静默换 provider;
 * - 顺序与排除来自调用方的设置快照，而不是模块级全局状态。
 */

import { describe, expect, it } from "vitest";
import {
	formatSearchProviderFailure,
	getSearchProvider,
	getSearchProviderLabel,
	isSearchProviderImplemented,
	resolveProviderCandidates,
} from "../../src/websource/search/provider.ts";
import { SEARCH_PROVIDER_ORDER, SearchProviderError } from "../../src/websource/search/types.ts";
import { unavailableWebSearchCredentials } from "../../src/websource/credentials.ts";
import { createWebSearchFetch } from "../../src/websource/transport.ts";

/** 未移植的 Tier C provider（LLM 介导,依赖上游 stream/oauth 面）。 */
const TIER_C = ["anthropic", "codex", "gemini", "perplexity", "xai"] as const;

describe("provider registry", () => {
	it("implements every provider except the deferred Tier C set", () => {
		const unimplemented = SEARCH_PROVIDER_ORDER.filter((id) => !isSearchProviderImplemented(id));
		expect([...unimplemented].sort()).toEqual([...TIER_C].sort());
	});

	it("returns a typed error for an unimplemented provider instead of a generic failure", async () => {
		await expect(getSearchProvider("perplexity")).rejects.toBeInstanceOf(SearchProviderError);
		await expect(getSearchProvider("perplexity")).rejects.toThrow(/not available in this build/);
	});

	it("constructs a provider on demand and caches the instance", async () => {
		const first = await getSearchProvider("tavily");
		const second = await getSearchProvider("tavily");
		expect(first).toBe(second);
	});

	it("labels every provider id, including unimplemented ones", () => {
		for (const id of SEARCH_PROVIDER_ORDER) {
			expect(getSearchProviderLabel(id)).not.toBe(id);
		}
	});
});

describe("resolveProviderCandidates", () => {
	it("skips unimplemented providers so the auto chain never throws mid-flight", () => {
		const ids = resolveProviderCandidates().map((candidate) => candidate.id);
		for (const tierC of TIER_C) expect(ids).not.toContain(tierC);
		expect(ids.length).toBeGreaterThan(0);
	});

	it("keeps the built-in relative order for unlisted providers", () => {
		const ids = resolveProviderCandidates().map((candidate) => candidate.id);
		const expected = SEARCH_PROVIDER_ORDER.filter((id) => isSearchProviderImplemented(id));
		expect(ids).toEqual([...expected]);
	});

	it("prioritizes the configured order and marks listed providers explicit", () => {
		const candidates = resolveProviderCandidates({ order: ["brave", "tavily"] });
		expect(candidates.slice(0, 2).map((candidate) => candidate.id)).toEqual(["brave", "tavily"]);
		expect(candidates[0]?.explicit).toBe(true);
		expect(candidates[1]?.explicit).toBe(true);
		// 未列入的 provider 仍在链上，只是不是 explicit。
		expect(candidates.map((candidate) => candidate.id)).toContain("google");
		expect(candidates.find((candidate) => candidate.id === "google")?.explicit).toBe(false);
	});

	it("drops excluded providers from the chain", () => {
		const ids = resolveProviderCandidates({ exclude: ["tavily", "brave"] }).map((candidate) => candidate.id);
		expect(ids).not.toContain("tavily");
		expect(ids).not.toContain("brave");
	});

	it("puts a forced provider first even when settings exclude it", () => {
		// 用户的显式选择覆盖设置里的排除项。
		const candidates = resolveProviderCandidates({ forcedProvider: "tavily", exclude: ["tavily"] });
		expect(candidates[0]).toEqual({ id: "tavily", explicit: true });
	});

	it("ignores an unimplemented forced provider rather than producing a doomed candidate", () => {
		const ids = resolveProviderCandidates({ forcedProvider: "gemini" }).map((candidate) => candidate.id);
		expect(ids).not.toContain("gemini");
	});
});

describe("failure formatting", () => {
	it("keeps the provider-tagged message from a SearchProviderError", () => {
		const error = new SearchProviderError("tavily", "tavily: 401 unauthorized", 401);
		expect(formatSearchProviderFailure(error, { id: "tavily", label: "Tavily" })).toBe("tavily: 401 unauthorized");
	});

	it("falls back to a labelled message for unknown errors", () => {
		expect(formatSearchProviderFailure(new Error("boom"), { id: "brave", label: "Brave" })).toBe("Brave: boom");
	});
});

describe("credential-free providers", () => {
	it("admits themselves to the auto chain without credentials", async () => {
		const credentials = unavailableWebSearchCredentials();
		for (const id of ["duckduckgo", "ecosia", "google", "mojeek", "startpage"] as const) {
			const provider = await getSearchProvider(id);
			expect(await provider.isAvailable(credentials), `${id} should be available`).toBe(true);
		}
	});

	it("keeps Public Web explicit-only", async () => {
		const credentials = unavailableWebSearchCredentials();
		const provider = await getSearchProvider("public");
		expect(await provider.isAvailable(credentials)).toBe(false);
		expect(await provider.isExplicitlyAvailable(credentials)).toBe(true);
	});

	it("rejects credential-gated providers without credentials", async () => {
		const credentials = unavailableWebSearchCredentials();
		for (const id of ["tavily", "brave", "jina", "kagi", "synthetic", "tinyfish"] as const) {
			const provider = await getSearchProvider(id);
			expect(await provider.isAvailable(credentials), `${id} should be unavailable`).toBe(false);
		}
	});

	it("treats SearXNG as unavailable until an endpoint is configured", async () => {
		const credentials = unavailableWebSearchCredentials();
		const provider = await getSearchProvider("searxng");
		expect(await provider.isAvailable(credentials)).toBe(false);
		expect(await provider.isAvailable(credentials, { searxng: { endpoint: "https://searx.example.com" } })).toBe(true);
	});
});

describe("governed transport requirement", () => {
	it("fails closed when a provider has no injected transport", async () => {
		// 库层不得回退到全局 fetch:未注入 transport 时调用必须失败。
		const provider = await getSearchProvider("tavily");
		const credentials = { has: async () => true, getApiKey: async () => "test-key", getConfig: async () => undefined };
		await expect(provider.search({
			query: "typescript",
			credentials,
			fetch: undefined as never,
			timeoutMs: 1000,
		})).rejects.toThrow();
	});

	it("builds a transport that carries the web_search principal", async () => {
		const seen: string[] = [];
		const fetch = createWebSearchFetch({
			network: {
				request: async (request) => {
					seen.push(request.principal ?? "<none>");
					return { status: 200, headers: {}, body: Buffer.from("{}"), finalUrl: request.url };
				},
			},
			principal: "web_search",
		});
		await fetch("https://api.tavily.com/search", { method: "POST", body: "{}" });
		expect(seen).toEqual(["web_search"]);
	});
});
