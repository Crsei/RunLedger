/**
 * `web_search` 工具测试。
 *
 * 覆盖工具层职责:参数校验（非法 provider 不静默降级）、结果包装（成功文本 /
 * 失败 `isError`）、abort 传播，以及「全 provider 失败时给出逐 provider 摘要」。
 * 所有出站都用注入的假 transport,不发起真实网络请求。
 */

import { describe, expect, it } from "vitest";
import { createWebSearchTool } from "../../src/websource/search/tool.ts";
import type { WebSearchCredentialId, WebSearchCredentialPort } from "../../src/websource/credentials.ts";
import type { Network } from "../../src/runtime/execution-env.ts";
import { createWebSearchFetch } from "../../src/websource/transport.ts";

/** 按 URL 关键字返回响应的假 Network;未命中的 host 直接失败。 */
function networkFor(handlers: Readonly<Record<string, () => { status: number; body: unknown }>>): Network {
	return {
		request: async (request) => {
			for (const [needle, handler] of Object.entries(handlers)) {
				if (!request.url.includes(needle)) continue;
				const result = handler();
				return {
					status: result.status,
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(result.body), "utf8"),
					finalUrl: request.url,
				};
			}
			throw new Error(`test network: unexpected url ${request.url}`);
		},
	};
}

function credentialsWith(keys: readonly WebSearchCredentialId[]): WebSearchCredentialPort {
	const available = new Set(keys);
	return {
		has: async (id) => available.has(id),
		getApiKey: async (id) => (available.has(id) ? `test-${id}-key` : undefined),
		getConfig: async () => undefined,
	};
}

function toolWith(network: Network, keys: readonly WebSearchCredentialId[] = []) {
	return createWebSearchTool({
		fetch: createWebSearchFetch({ network, principal: "web_search" }),
		credentials: credentialsWith(keys),
	});
}

describe("web_search tool", () => {
	it("rejects an unknown provider instead of silently falling back to auto", async () => {
		const tool = toolWith(networkFor({}));
		await expect(tool.execute("tc", { query: "x", provider: "not-a-provider" })).rejects.toThrow(/unknown provider/);
	});

	it("fails closed for an unimplemented provider instead of silently using another one", async () => {
		const tool = toolWith(networkFor({}));
		// 显式选中未移植的 Tier C provider 是调用方错误:必须报错,不得换 provider
		// 或返回空结果让调用方误以为检索成功。
		await expect(tool.execute("tc", { query: "x", provider: "gemini" }))
			.rejects.toThrow(/not available in this build/);
	});

	it("returns a formatted result list from the configured provider", async () => {
		const tool = toolWith(networkFor({
			"api.tavily.com": () => ({
				status: 200,
				body: {
					answer: "TypeScript is a typed superset of JavaScript.",
					results: [
						{ title: "TypeScript", url: "https://www.typescriptlang.org/", content: "Official site" },
					],
				},
			}),
		}), ["tavily"]);

		const result = await tool.execute("tc", { query: "typescript", provider: "tavily" });
		const [first] = result.content;
		expect(first?.type).toBe("text");
		const text = first?.type === "text" ? first.text : "";

		expect(result.isError).toBeUndefined();
		expect(result.details.response.provider).toBe("tavily");
		expect(result.details.response.sources).toHaveLength(1);
		expect(text).toContain("TypeScript is a typed superset");
		expect(text).toContain("https://www.typescriptlang.org/");
	});

	it("marks an all-providers-failed outcome as an error with a per-provider summary", async () => {
		// 无凭据且只允许凭据型 provider:链上没有可用项。
		const tool = toolWith(networkFor({}), []);
		const result = await tool.execute("tc", { query: "x", provider: "tavily" });

		expect(result.isError).toBe(true);
		expect(result.details.error).toBeDefined();
		const [first] = result.content;
		expect(first?.type === "text" ? first.text : "").toContain("Error:");
	});

	it("propagates abort instead of reporting it as a provider failure", async () => {
		const controller = new AbortController();
		const tool = createWebSearchTool({
			// 立刻中止:provider 传输收到已 abort 的 signal。
			fetch: async () => {
				controller.abort();
				throw new Error("aborted by caller");
			},
			credentials: credentialsWith(["tavily"]),
		});

		await expect(tool.execute("tc", { query: "x", provider: "tavily" }, controller.signal)).rejects.toThrow();
	});

	it("declares a discovery-shaped read-only tool surface", () => {
		const tool = toolWith(networkFor({}));
		expect(tool.name).toBe("web_search");
		expect(tool.isReadOnly?.()).toBe(true);
		expect(tool.parameters).toBeDefined();
	});
});
