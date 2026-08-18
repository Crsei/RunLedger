import { describe, expect, test } from "vitest";
import {
	ProxyWireCache,
	detectWireForModel,
	normalizeProxyBaseUrl,
	parseProxyProviderConfig,
	proxyWireBaseUrl,
	proxyWireRequestUrl,
	resolveProxyApiKey,
	type ProxyWire,
} from "../../src/providers/proxy-discovery.ts";

describe("upstream proxy discovery pure contracts", () => {
	test("normalizes one /v1 base URL for both SDK transports", () => {
		const baseUrl = normalizeProxyBaseUrl("https://models.example.test/v1/");

		expect(baseUrl).toBe("https://models.example.test/v1");
		expect(proxyWireBaseUrl(baseUrl, "anthropic-messages")).toBe("https://models.example.test");
		expect(proxyWireBaseUrl(baseUrl, "openai-completions")).toBe("https://models.example.test/v1");
		expect(proxyWireRequestUrl(baseUrl, "anthropic-messages")).toBe("https://models.example.test/v1/messages");
		expect(proxyWireRequestUrl(baseUrl, "openai-completions")).toBe(
			"https://models.example.test/v1/chat/completions",
		);
	});

	test("adds /v1 when a provider gives only an origin and rejects unsafe URLs", () => {
		expect(normalizeProxyBaseUrl("https://models.example.test")).toBe("https://models.example.test/v1");
		expect(() => normalizeProxyBaseUrl("ftp://models.example.test")).toThrow(/http/i);
		expect(() => normalizeProxyBaseUrl("https://models.example.test/v1?token=secret")).toThrow(/query/i);
	});

	test("resolves explicit env references while preserving literal keys", () => {
		const env = { TEAM_PROXY_API_KEY: "env-secret" };

		expect(resolveProxyApiKey("TEAM_PROXY_API_KEY", env)).toBe("env-secret");
		expect(resolveProxyApiKey("${TEAM_PROXY_API_KEY}", env)).toBe("env-secret");
		expect(resolveProxyApiKey("$TEAM_PROXY_API_KEY", env)).toBe("env-secret");
		expect(resolveProxyApiKey("sk-literal", env)).toBe("sk-literal");
		expect(resolveProxyApiKey("MISSING_PROXY_KEY", env)).toBeUndefined();
	});

	test("parses proxy discovery options and rejects malformed configuration", () => {
		expect(
			parseProxyProviderConfig({
				baseUrl: "https://models.example.test",
				apiKey: "TEAM_PROXY_API_KEY",
				authHeader: true,
				disableStrictTools: true,
				headers: { "x-team": "alpha", "x-remove": null },
				discovery: { type: "proxy", timeoutMs: 2500 },
			}),
		).toEqual({
				baseUrl: "https://models.example.test/v1",
				apiKey: "TEAM_PROXY_API_KEY",
				authHeader: true,
				disableStrictTools: true,
				headers: { "x-team": "alpha", "x-remove": null },
				discovery: { type: "proxy", timeoutMs: 2500 },
			});

		expect(
			parseProxyProviderConfig({ baseUrl: "https://models.example.test", discovery: { type: "proxy" } }),
		).toMatchObject({ discovery: { type: "proxy", timeoutMs: 5000 } });
		expect(() => parseProxyProviderConfig({ baseUrl: "https://models.example.test" })).toThrow(/discovery/i);
		expect(() =>
			parseProxyProviderConfig({
				baseUrl: "https://models.example.test",
				discovery: { type: "other" },
			}),
		).toThrow(/proxy/i);
	});

	test("uses Anthropic first, then OpenAI, regardless of candidate map order", () => {
		const result = detectWireForModel("claude-or-gpt", {
			"openai-completions": { accepted: true, status: 200 },
			"anthropic-messages": { accepted: true, status: 200 },
		});

		expect(result).toEqual({
			ok: true,
			modelId: "claude-or-gpt",
			wire: "anthropic-messages",
			attempts: [{ wire: "anthropic-messages", accepted: true, status: 200 }],
		});
	});

	test("falls back after a rejected Anthropic probe and fails explicitly when both wires reject", () => {
		const fallback = detectWireForModel("proxy-model", {
			"anthropic-messages": { accepted: false, status: 401, reason: "wrong auth shape" },
			"openai-completions": { accepted: true, status: 200 },
		});
		expect(fallback).toEqual({
			ok: true,
			modelId: "proxy-model",
			wire: "openai-completions",
			attempts: [
				{ wire: "anthropic-messages", accepted: false, status: 401, reason: "wrong auth shape" },
				{ wire: "openai-completions", accepted: true, status: 200 },
			],
		});

		const failed = detectWireForModel("unavailable-model", {
			"anthropic-messages": { accepted: false, status: 400 },
			"openai-completions": { accepted: false, status: 404 },
		});
		expect(failed).toEqual({
			ok: false,
			modelId: "unavailable-model",
			reason: "wire_detection_failed",
			attempts: [
				{ wire: "anthropic-messages", accepted: false, status: 400 },
				{ wire: "openai-completions", accepted: false, status: 404 },
			],
		});
	});

	test("scopes wire cache by provider and model and expires failures sooner than last-known-good", () => {
		let now = 0;
		const cache = new ProxyWireCache({ successTtlMs: 1000, failureTtlMs: 100, now: () => now });
		const success = detectWireForModel("model-a", {
			"anthropic-messages": { accepted: true, status: 200 },
		});

		cache.remember("team-proxy", "model-a", success);
		expect(cache.get("team-proxy", "model-a")).toMatchObject({ state: "success", wire: "anthropic-messages" });
		expect(cache.get("other-provider", "model-a")).toBeUndefined();
		expect(cache.get("team-proxy", "other-model")).toBeUndefined();

		now = 1001;
		const failure = detectWireForModel("model-a", {
			"anthropic-messages": { accepted: false, status: 400 },
			"openai-completions": { accepted: false, status: 404 },
		});
		cache.remember("team-proxy", "model-a", failure);
		expect(cache.get("team-proxy", "model-a")).toMatchObject({ state: "failure", reason: "wire_detection_failed" });
		expect(cache.getLastKnownGood("team-proxy", "model-a")).toBe("anthropic-messages");

		now = 1101;
		expect(cache.get("team-proxy", "model-a")).toBeUndefined();
		expect(cache.getLastKnownGood("team-proxy", "model-a")).toBe("anthropic-messages");
	});

	test("keeps the wire order as a stable serializable contract", () => {
		const wires: ProxyWire[] = ["anthropic-messages", "openai-completions"];
		const result = detectWireForModel("model", {
			"anthropic-messages": { accepted: false },
			"openai-completions": { accepted: false },
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failed detection");
		expect(result.attempts.map((attempt) => attempt.wire)).toEqual(wires);
	});
});
