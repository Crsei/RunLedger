import { describe, expect, test } from "vitest";
import {
	UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
	getCachedProviderProxyUrl,
	normalizeProviderProxyKey,
	resolveHttpProxyUrlForTarget,
	resolveProviderProxyUrl,
} from "../../src/utils/node-http-proxy.ts";

const neutralNoProxy = "never-match.runledger.test";

describe("provider outbound proxy resolution", () => {
	test("normalizes provider ids for scoped environment keys", () => {
		expect(normalizeProviderProxyKey("github-copilot")).toBe("GITHUB_COPILOT");
		expect(normalizeProviderProxyKey("OpenAI.responses/release")).toBe("OPENAI_RESPONSES_RELEASE");
	});

	test("uses provider, global, protocol, then all-proxy precedence", () => {
		const target = "https://api.proxy-order.runledger.test/endpoint";
		const env = {
			no_proxy: neutralNoProxy,
			RUNLEDGER_PROXY_OPENAI_RESPONSES: "http://provider-proxy.runledger.test:9001",
			RUNLEDGER_PROXY: "http://global-proxy.runledger.test:9002",
			https_proxy: "http://https-proxy.runledger.test:9003",
			all_proxy: "http://all-proxy.runledger.test:9004",
		};

		expect(resolveProviderProxyUrl("openai-responses", target, env)).toBe(
			"http://provider-proxy.runledger.test:9001",
		);
		expect(resolveProviderProxyUrl("anthropic-messages", target, env)).toBe("http://global-proxy.runledger.test:9002");
		expect(
			resolveProviderProxyUrl("anthropic-messages", target, {
				no_proxy: neutralNoProxy,
				https_proxy: "http://https-proxy.runledger.test:9003",
			}),
		).toBe("http://https-proxy.runledger.test:9003");
		expect(
			resolveProviderProxyUrl("anthropic-messages", "ftp://api.proxy-order.runledger.test/endpoint", {
				no_proxy: neutralNoProxy,
				all_proxy: "http://all-proxy.runledger.test:9004",
			}),
		).toBe("http://all-proxy.runledger.test:9004");
	});

	test("prefers lowercase scoped standard variables and reads uppercase variables", () => {
		const target = "https://api.proxy-case.runledger.test";
		expect(
			resolveProviderProxyUrl("case-test", target, {
				no_proxy: neutralNoProxy,
				https_proxy: "http://lower-proxy.runledger.test",
				HTTPS_PROXY: "http://upper-proxy.runledger.test",
			}),
		).toBe("http://lower-proxy.runledger.test");
		expect(
			resolveProviderProxyUrl("case-test-upper", target, {
				NO_PROXY: neutralNoProxy,
				HTTPS_PROXY: "http://upper-proxy.runledger.test",
			}),
		).toBe("http://upper-proxy.runledger.test");
	});

	test("uses HTTP proxy variables for HTTP and WS targets and HTTPS variables for HTTPS and WSS", () => {
		const env = {
			no_proxy: neutralNoProxy,
			http_proxy: "http://http-proxy.runledger.test",
			https_proxy: "http://https-proxy.runledger.test",
		};

		expect(resolveProviderProxyUrl("protocol-test-http", "http://api.runledger.test", env)).toBe(
			"http://http-proxy.runledger.test",
		);
		expect(resolveProviderProxyUrl("protocol-test-ws", "ws://api.runledger.test", env)).toBe(
			"http://http-proxy.runledger.test",
		);
		expect(resolveProviderProxyUrl("protocol-test-https", "https://api.runledger.test", env)).toBe(
			"http://https-proxy.runledger.test",
		);
		expect(resolveProviderProxyUrl("protocol-test-wss", "wss://api.runledger.test", env)).toBe(
			"http://https-proxy.runledger.test",
		);
	});

	test("applies NO_PROXY before resolving the selected proxy", () => {
		const env = { RUNLEDGER_PROXY: "http://proxy.runledger.test", no_proxy: "*" };
		expect(resolveProviderProxyUrl("no-proxy-star", "https://api.runledger.test", env)).toBe("");
		expect(resolveProviderProxyUrl("no-proxy-host", "https://api.example.test", { ...env, no_proxy: "api.example.test" })).toBe("");
		expect(
			resolveProviderProxyUrl("no-proxy-port", "https://api.example.test:8443", {
				...env,
				no_proxy: "api.example.test:8443",
			}),
		).toBe("");
		expect(
			resolveProviderProxyUrl("no-proxy-suffix", "https://service.example.test", {
				...env,
				no_proxy: "*.example.test",
			}),
		).toBe("");
		expect(
			resolveProviderProxyUrl("no-proxy-miss", "https://service.other.test", {
				...env,
				no_proxy: "*.example.test",
			}),
		).toBe("http://proxy.runledger.test");
	});

	test.each([
		["localhost", "http://localhost:8080"],
		["IPv4 loopback", "http://127.0.0.1:8080"],
		["IPv6 loopback", "http://[::1]:8080"],
	])("bypasses %s targets even when a proxy is configured", (_label, target) => {
		expect(
			resolveProviderProxyUrl("loopback-test", target, {
				RUNLEDGER_PROXY: "http://proxy.runledger.test",
				no_proxy: neutralNoProxy,
			}),
		).toBe("");
	});

	test("adds a target-compatible scheme to an otherwise valid proxy value", () => {
		expect(
			resolveProviderProxyUrl("scheme-test-https", "https://api.scheme.runledger.test", {
				RUNLEDGER_PROXY: "proxy.runledger.test:3128",
				no_proxy: neutralNoProxy,
			}),
		).toBe("https://proxy.runledger.test:3128");
		expect(
			resolveProviderProxyUrl("scheme-test-http", "http://api.scheme.runledger.test", {
				RUNLEDGER_PROXY: "proxy.runledger.test:3129",
				no_proxy: neutralNoProxy,
			}),
		).toBe("http://proxy.runledger.test:3129");
	});

	test("rejects unsupported and invalid proxy URLs instead of falling back to direct access", () => {
		expect(() =>
			resolveProviderProxyUrl("socks-test", "https://api.invalid-proxy.runledger.test", {
				RUNLEDGER_PROXY: "socks5://proxy.runledger.test:1080",
				no_proxy: neutralNoProxy,
			}),
		).toThrow(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got socks5:`);
		expect(() =>
			resolveProviderProxyUrl("pac-test", "https://api.invalid-pac.runledger.test", {
				RUNLEDGER_PROXY: "pac+http://proxy.runledger.test/proxy.pac",
				no_proxy: neutralNoProxy,
			}),
		).toThrow(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got pac+http:`);
		expect(() =>
			resolveProviderProxyUrl("invalid-url-test", "https://api.invalid-url.runledger.test", {
				RUNLEDGER_PROXY: "not a URL",
				no_proxy: neutralNoProxy,
			}),
		).toThrow("Invalid proxy URL");
	});

	test("does not let an invalid higher-priority provider value fall through", () => {
		expect(() =>
			resolveProviderProxyUrl("invalid-priority", "https://api.invalid-priority.runledger.test", {
				RUNLEDGER_PROXY_INVALID_PRIORITY: "not a URL",
				RUNLEDGER_PROXY: "http://global-proxy.runledger.test",
				no_proxy: neutralNoProxy,
			}),
		).toThrow("Invalid proxy URL");
	});

	test("caches a normalized provider-target lookup for the process lifetime", () => {
		const providerId = "cache-provider/release";
		const firstTarget = "https://cache.runledger.test/path/../endpoint";
		const normalizedTarget = new URL(firstTarget).toString();
		const first = getCachedProviderProxyUrl(providerId, firstTarget, {
			RUNLEDGER_PROXY_CACHE_PROVIDER_RELEASE: "http://first-cache-proxy.runledger.test",
			no_proxy: neutralNoProxy,
		});
		const second = getCachedProviderProxyUrl(providerId, normalizedTarget, {
			RUNLEDGER_PROXY_CACHE_PROVIDER_RELEASE: "http://second-cache-proxy.runledger.test",
			no_proxy: neutralNoProxy,
		});

		expect(first).toEqual(new URL("http://first-cache-proxy.runledger.test"));
		expect(second).toEqual(first);
	});

	test("keeps the legacy target-only entry point on the same global resolution rules", () => {
		expect(
			resolveHttpProxyUrlForTarget("https://legacy-proxy.runledger.test", {
				RUNLEDGER_PROXY: "proxy.runledger.test:3130",
				no_proxy: neutralNoProxy,
			}),
		).toEqual(new URL("https://proxy.runledger.test:3130"));
	});
});
