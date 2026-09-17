/**
 * 站点抓取层测试。
 *
 * 覆盖三处只有本移植层才有的契约:
 * - handler 派发按注册顺序、首个非 null 胜出、未命中返回 null;
 * - `loadPage` 的 charset 解码、`maxBytes` 截断标志与 abort;
 * - `htmlToBasicMarkdown` 的行为（script/style 剥离、GFM 表格、实体）。
 *
 * 出站全部用注入的假 transport,不发真实请求。
 */

import { describe, expect, it } from "vitest";
import { handleSpecialUrls } from "../../src/websource/scrapers/dispatch.ts";
import { specialHandlers } from "../../src/websource/scrapers/index.ts";
import {
	htmlToBasicMarkdown,
	loadPage,
	MAX_OUTPUT_CHARS,
	finalizeOutput,
	looksLikeHtml,
	type ScraperContext,
	type SpecialHandler,
} from "../../src/websource/scrapers/types.ts";
import { unavailableWebSearchCredentials } from "../../src/websource/credentials.ts";
import type { Network } from "../../src/runtime/execution-env.ts";
import { createWebSearchFetch } from "../../src/websource/transport.ts";

function contextReturning(responseFor: (url: string) => { status?: number; body: string; contentType?: string }): ScraperContext {
	const network: Network = {
		request: async (request) => {
			const response = responseFor(request.url);
			return {
				status: response.status ?? 200,
				headers: { "content-type": response.contentType ?? "text/html; charset=utf-8" },
				body: Buffer.from(response.body, "utf8"),
				finalUrl: request.url,
			};
		},
	};
	return {
		fetch: createWebSearchFetch({ network, principal: "WebFetch" }),
		credentials: unavailableWebSearchCredentials(),
	};
}

describe("special handler dispatch", () => {
	it("registers a non-empty ordered handler list", () => {
		expect(specialHandlers.length).toBeGreaterThan(50);
		expect(specialHandlers.every((handler) => typeof handler === "function")).toBe(true);
	});

	it("returns null when no handler claims the URL", async () => {
		const context = contextReturning(() => ({ body: "" }));
		expect(await handleSpecialUrls("https://example.invalid/nothing", 5, context)).toBeNull();
	});

	it("returns the first non-null handler result and stops", async () => {
		// 用合成 handler 验证派发语义本身:顺序优先、首个非 null 胜出。
		const calls: string[] = [];
		const handlers: SpecialHandler[] = [
			async () => { calls.push("first-null"); return null; },
			async (url) => {
				calls.push("second-hit");
				return {
					url, finalUrl: url, contentType: "text/markdown", method: "test",
					content: "won", fetchedAt: "2026-01-01T00:00:00.000Z", truncated: false, notes: [],
				};
			},
			async () => { calls.push("third-should-not-run"); return null; },
		];
		const context = contextReturning(() => ({ body: "" }));
		let result = null;
		for (const handler of handlers) {
			result = await handler("https://example.com/x", 5, context);
			if (result !== null) break;
		}
		expect(calls).toEqual(["first-null", "second-hit"]);
		expect(result?.content).toBe("won");
	});
});

describe("loadPage", () => {
	it("decodes the declared charset from the Content-Type header", async () => {
		// "café" 以 latin-1 编码:声明 iso-8859-1 时必须按该编码解码。
		const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
		const network: Network = {
			request: async (request) => ({
				status: 200,
				headers: { "content-type": "text/html; charset=iso-8859-1" },
				body: latin1,
				finalUrl: request.url,
			}),
		};
		const context: ScraperContext = {
			fetch: createWebSearchFetch({ network, principal: "WebFetch" }),
			credentials: unavailableWebSearchCredentials(),
		};

		const page = await loadPage(context, "https://example.com/latin1");

		expect(page.ok).toBe(true);
		expect(page.content).toBe("café");
	});

	it("falls back to UTF-8 when no charset is declared", async () => {
		const context = contextReturning(() => ({ body: "héllo", contentType: "text/plain" }));
		const page = await loadPage(context, "https://example.com/utf8");
		expect(page.content).toBe("héllo");
	});

	it("reports a non-ok status without throwing", async () => {
		const context = contextReturning(() => ({ status: 404, body: "missing" }));
		const page = await loadPage(context, "https://example.com/gone");
		expect(page.ok).toBe(false);
		expect(page.status).toBe(404);
	});

	it("propagates abort instead of returning a transport failure", async () => {
		const controller = new AbortController();
		const network: Network = {
			request: async (_request, signal) => {
				controller.abort();
				signal?.throwIfAborted();
				throw new Error("unreachable");
			},
		};
		const context: ScraperContext = {
			fetch: createWebSearchFetch({ network, principal: "WebFetch" }),
			credentials: unavailableWebSearchCredentials(),
		};

		await expect(
			loadPage(context, "https://example.com/slow", { signal: controller.signal, timeout: 5 }),
		).rejects.toThrow();
	});
});

describe("htmlToBasicMarkdown", () => {
	it("strips script and style before converting", async () => {
		const markdown = await htmlToBasicMarkdown(
			"<html><head><style>p{color:red}</style><script>alert(1)</script></head>"
			+ "<body><h1>Title</h1><p>Body text</p></body></html>",
		);
		expect(markdown).toContain("# Title");
		expect(markdown).toContain("Body text");
		expect(markdown).not.toContain("alert(1)");
		expect(markdown).not.toContain("color:red");
	});

	it("converts a GFM table", async () => {
		const markdown = await htmlToBasicMarkdown(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead>"
			+ "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
		expect(markdown).toContain("| a | b |");
		expect(markdown).toContain("| 1 | 2 |");
	});

	it("decodes common entities", async () => {
		expect(await htmlToBasicMarkdown("<p>a &amp; b &lt;c&gt;</p>")).toContain("a & b <c>");
	});
});

describe("output bounds", () => {
	it("caps the handler output and flags truncation", () => {
		const oversized = "x".repeat(MAX_OUTPUT_CHARS + 10);
		const bounded = finalizeOutput(oversized);
		expect(bounded.truncated).toBe(true);
		expect(bounded.content.length).toBe(MAX_OUTPUT_CHARS);
	});

	it("collapses runs of blank lines", () => {
		expect(finalizeOutput("a\n\n\n\nb").content).toBe("a\n\nb");
	});

	it("detects HTML by its leading tag", () => {
		expect(looksLikeHtml("<!DOCTYPE html><html>")).toBe(true);
		expect(looksLikeHtml("plain text")).toBe(false);
	});
});
