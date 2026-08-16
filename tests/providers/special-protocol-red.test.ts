import { describe, expect, test } from "vitest";
import { envApiKeyAuth } from "../../src/auth/helpers.ts";
import { createProvider } from "../../src/models.ts";
import { builtinProviders } from "../../src/providers/all.ts";
import type { Model } from "../../src/types.ts";

/**
 * C 批次 RED 证据(见 02-oh-my-pi-provider-port-execution-checklist.md §P4):
 * 目标 Api union 没有 cursor-agent / devin-agent / gitlab-duo-workflow /
 * ollama-chat / google-antigravity / google-gemini-cli 等来源特殊 transport,
 * 且 builtinProviders() 不注册这些 provider ID。任何把这些协议伪装成
 * 已有 OpenAI/Anthropic adapter 的做法都会被本文件的 fail-closed 断言拦下。
 */

const DEFERRED_SPECIAL_PROVIDER_IDS = [
	"cursor",
	"devin",
	"gitlab-duo",
	"gitlab-duo-agent",
	"google-antigravity",
	"google-gemini-cli",
	"ollama",
	"ollama-cloud",
] as const;

const DEFERRED_SPECIAL_APIS = ["cursor-agent", "devin-agent", "ollama-chat"] as const;

describe("C 批次特殊协议 RED(保持 deferred)", () => {
	test("builtinProviders() 不注册 C 批次特殊 provider", () => {
		const registered = new Set(builtinProviders().map((provider) => provider.id));
		for (const id of DEFERRED_SPECIAL_PROVIDER_IDS) {
			expect(registered.has(id), `provider ${id} 不应出现在 builtinProviders()`).toBe(false);
		}
	});

	test("特殊 wire API 没有目标实现:dispatch fail closed", async () => {
		for (const api of DEFERRED_SPECIAL_APIS) {
			const model: Model<typeof api> = {
				id: "red-model",
				name: "RED",
				api,
				provider: "red-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 4096,
			};
			const provider = createProvider({
				id: "red-provider",
				auth: { apiKey: envApiKeyAuth("RED key", ["RED_API_KEY"]) },
				models: [model],
				// 目标没有任何 adapter 实现这些 api:api map 没有对应条目时,
				// dispatch 必须返回 stream error 事件,而不是强转或回退。
				api: {},
			});
			const result = await provider.stream(model, { messages: [], tools: [] }, {}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("no API implementation");
		}
	});
});
