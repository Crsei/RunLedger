/**
 * websource 传输层测试。
 *
 * 覆盖 `createWebSearchFetch` 与受治 `Network` port 之间的契约:principal 归属、
 * 同 host 重定向、跨 host/port 拒绝、字节上限透传、abort 传播、以及把缓冲响应
 * 还原成上游代码可消费的 `Response`（含 SSE 的 body reader）。
 */

import { describe, expect, it } from "vitest";
import type { Network, NetworkRequest, NetworkResponse } from "../../src/runtime/execution-env.ts";
import { createWebSearchFetch, WebSourceNetworkError } from "../../src/websource/transport.ts";

interface Recorded {
	readonly requests: NetworkRequest[];
}

/** 按脚本逐次返回响应的假 Network。 */
function scriptedNetwork(responses: readonly NetworkResponse[], recorded: Recorded): Network {
	return {
		request: async (request: NetworkRequest): Promise<NetworkResponse> => {
			recorded.requests.push(request);
			const next = responses[recorded.requests.length - 1];
			if (next === undefined) throw new Error("scripted network exhausted");
			return next;
		},
	};
}

function response(init: {
	status: number;
	headers?: Record<string, string>;
	body?: string;
	finalUrl?: string;
}): NetworkResponse {
	return {
		status: init.status,
		headers: init.headers ?? {},
		body: Buffer.from(init.body ?? "", "utf8"),
		finalUrl: init.finalUrl ?? "https://example.com/",
	};
}

describe("createWebSearchFetch", () => {
	it("routes every request through the injected port with the declared principal", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([response({ status: 200, body: "ok" })], recorded);
		const fetch = createWebSearchFetch({ network, principal: "web_search" });

		const result = await fetch("https://api.example.com/search", { method: "POST", body: "{}" });

		expect(recorded.requests).toHaveLength(1);
		expect(recorded.requests[0]?.principal).toBe("web_search");
		expect(recorded.requests[0]?.url).toBe("https://api.example.com/search");
		expect(recorded.requests[0]?.method).toBe("POST");
		expect(result.status).toBe(200);
		expect(await result.text()).toBe("ok");
	});

	it("follows a same-host redirect and reports the final URL", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([
			response({ status: 302, headers: { location: "/moved" } }),
			response({ status: 200, body: "final" }),
		], recorded);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		const result = await fetch("https://example.com/start");

		expect(recorded.requests).toHaveLength(2);
		expect(recorded.requests[1]?.url).toBe("https://example.com/moved");
		expect(result.url).toBe("https://example.com/moved");
		expect(await result.text()).toBe("final");
	});

	it("denies a cross-host redirect instead of following it", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([
			response({ status: 301, headers: { location: "https://other.example.net/x" } }),
		], recorded);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		await expect(fetch("https://example.com/start")).rejects.toBeInstanceOf(WebSourceNetworkError);
		// 关键:跨站跳转不得发出第二次请求(fail closed)。
		expect(recorded.requests).toHaveLength(1);
	});

	it("denies a redirect that changes the port", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([
			response({ status: 302, headers: { location: "https://example.com:8443/x" } }),
		], recorded);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		await expect(fetch("https://example.com/start")).rejects.toBeInstanceOf(WebSourceNetworkError);
	});

	it("stops after the configured redirect budget", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork(
			Array.from({ length: 4 }, () => response({ status: 302, headers: { location: "/loop" } })),
			recorded,
		);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch", maxRedirects: 2 });

		await expect(fetch("https://example.com/start")).rejects.toThrow(/too many redirects/);
	});

	it("does not follow redirects when the caller asks for manual handling", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([
			response({ status: 302, headers: { location: "https://example.com/moved" } }),
		], recorded);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		const result = await fetch("https://example.com/start", { redirect: "manual" });

		expect(recorded.requests).toHaveLength(1);
		expect(result.status).toBe(302);
		expect(result.headers.get("location")).toBe("https://example.com/moved");
	});

	it("passes the byte bound to the port and exposes a readable body", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([response({ status: 200, body: "streamed" })], recorded);
		const fetch = createWebSearchFetch({ network, principal: "web_search", maxBytes: 4096 });

		const result = await fetch("https://example.com/sse", {
			headers: { Accept: "text/event-stream" },
		});

		expect(recorded.requests[0]?.maxBytes).toBe(4096);
		// SSE 消费者读 body reader,缓冲响应必须能完整读回。
		const reader = result.body?.getReader();
		expect(reader).toBeDefined();
		const chunk = await reader?.read();
		expect(new TextDecoder().decode(chunk?.value)).toBe("streamed");
	});

	it("omits the body for status codes that cannot carry one", async () => {
		const recorded: Recorded = { requests: [] };
		const network = scriptedNetwork([response({ status: 204 })], recorded);
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		const result = await fetch("https://example.com/empty");

		expect(result.status).toBe(204);
		expect(result.body).toBeNull();
	});

	it("propagates caller abort instead of swallowing it", async () => {
		const controller = new AbortController();
		const network: Network = {
			request: async (_request, signal) => {
				controller.abort();
				signal?.throwIfAborted();
				throw new Error("unreachable");
			},
		};
		const fetch = createWebSearchFetch({ network, principal: "WebFetch" });

		await expect(fetch("https://example.com/x", { signal: controller.signal })).rejects.toThrow();
	});

	it("rejects an invalid byte bound at construction", () => {
		const network: Network = { request: async () => response({ status: 200 }) };
		expect(() => createWebSearchFetch({ network, principal: "WebFetch", maxBytes: 0 })).toThrow();
	});
});
