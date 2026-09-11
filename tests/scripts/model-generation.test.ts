/**
 * S9 拆分:model generator 纯 fixture tests。
 *
 * 冻结输入(本地 fixture,不访问网络)下验证:
 * - detectOpenAICompletionsCompat 按 provider/baseUrl 探测 compat;
 * - applyThinkingLevelMetadata 的 thinking level 映射;
 * - normalizeModelsDevData 的 models.dev 归一化(含跳过规则与 provider 特化);
 * - emit-provider-data / emit-model-types 的生成物形状与排序。
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Model } from "../../src/types.ts";
import { detectOpenAICompletionsCompat } from "../../scripts/model-generation/compat-metadata.ts";
import { applyThinkingLevelMetadata } from "../../scripts/model-generation/thinking-metadata.ts";
import { normalizeModelsDevData } from "../../scripts/model-generation/models-dev-source.ts";
import { emitProviderData } from "../../scripts/model-generation/emit-provider-data.ts";
import { normalizeProviderCatalogs } from "../../scripts/model-generation/provider-normalization.ts";
import { emitModelTypes } from "../../scripts/model-generation/emit-model-types.ts";

function completionsModel(id: string, provider: string, baseUrl: string): Model<"openai-completions"> {
	return { contextWindow: 4096, maxTokens: 1024, id, name: id, api: "openai-completions", provider, baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

describe("OpenCode Go plan generation", () => {
	it("repairs V4.1 Flash effort metadata from an older frozen input", () => {
		const stale = completionsModel("deepseek-v4.1-flash", "opencode-go", "https://opencode.ai/zen/go/v1");
		stale.reasoning = true;
		stale.compat = { thinkingFormat: "deepseek", supportsReasoningEffort: false };
		const model = normalizeProviderCatalogs([stale])["opencode-go"]?.[stale.id];
		expect(model).toMatchObject({
			thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
			compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
		});
	});

	it("removes routing-only IDs from every source without pruning other providers", () => {
		const input = [
			completionsModel("glm-5", "opencode-go", "https://opencode.ai/zen/go/v1"),
			completionsModel("omen-alpha", "opencode-go", "https://opencode.ai/zen/go/v1"),
			completionsModel("glm-5", "custom", "https://custom.example.invalid/v1"),
		];
		const catalog = normalizeProviderCatalogs(input);
		expect(Object.keys(catalog["opencode-go"]!)).toHaveLength(27);
		expect(catalog["opencode-go"]?.["glm-5"]).toBeUndefined();
		expect(catalog["opencode-go"]?.["omen-alpha"]).toBeUndefined();
		expect(catalog["opencode-go"]?.["minimax-m2.5"]).toBeUndefined();
		expect(catalog["custom"]?.["glm-5"]).toBeDefined();
		expect(catalog["opencode-go"]?.["deepseek-v4.1-flash"]).toMatchObject({
			api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384_000,
		});
	});
});

describe("S9 detectOpenAICompletionsCompat", () => {
	it("zai provider resolves zai thinking format and non-standard store", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('glm-4.5', 'zai', 'https://api.z.ai/v1'));
		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsStore).toBe(false);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsStrictMode).toBe(true);
		expect(compat.maxTokensField).toBe("max_completion_tokens");
		expect(compat.requiresReasoningContentOnAssistantMessages).toBe(false);
	});

	it("standard OpenAI-compatible provider keeps store/developer-role and max_completion_tokens", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('gpt-4o', 'openai', 'https://api.openai.com/v1'));
		expect(compat.supportsStore).toBe(true);
		expect(compat.supportsDeveloperRole).toBe(true);
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.maxTokensField).toBe("max_completion_tokens");
		expect(compat.supportsLongCacheRetention).toBe(true);
		expect(compat.requiresReasoningContentOnAssistantMessages).toBe(false);
	});

	it("moonshot uses max_tokens and drops strict mode", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('moonshot-8k', 'moonshotai', 'https://api.moonshot.ai/v1'));
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.supportsStrictMode).toBe(false);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
	});

	it("deepseek base url requires reasoning content on assistant messages", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('deepseek-chat', 'deepseek', 'https://api.deepseek.com'));
		expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(compat.thinkingFormat).toBe("deepseek");
		expect(compat.supportsStore).toBe(false);
	});

	it("together resolves together thinking format with max_tokens and no long cache", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('deepseek-ai/DeepSeek-V4', 'together', 'https://api.together.ai/v1'));
		expect(compat.thinkingFormat).toBe("together");
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsLongCacheRetention).toBe(false);
	});

	it("nvidia resolves max_tokens without strict mode", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('meta-llama/Llama-3.1-405B', 'nvidia', 'https://integrate.api.nvidia.com/v1'));
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.supportsStrictMode).toBe(false);
		expect(compat.supportsLongCacheRetention).toBe(false);
	});

	it("ant-ling resolves ant-ling thinking format", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('Ring-2.6-1T', 'ant-ling', 'https://api.ant-ling.com/v1'));
		expect(compat.thinkingFormat).toBe("ant-ling");
		expect(compat.maxTokensField).toBe("max_tokens");
	});

	it("openrouter anthropic model keeps developer role and anthropic cache control", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('anthropic/claude-sonnet-4.5', 'openrouter', 'https://openrouter.ai/api/v1'));
		expect(compat.supportsDeveloperRole).toBe(true);
		expect(compat.cacheControlFormat).toBe("anthropic");
		expect(compat.thinkingFormat).toBe("openrouter");
	});

	it("openrouter non-anthropic model drops developer role", () => {
		const compat = detectOpenAICompletionsCompat(completionsModel('moonshotai/kimi-k3', 'openrouter', 'https://openrouter.ai/api/v1'));
		expect(compat.supportsDeveloperRole).toBe(false);
	});
});

describe("S9 applyThinkingLevelMetadata", () => {
	it("deepseek-v4 direct provider uses the canonical level map", () => {
		const model = {
			id: "deepseek-v4-pro",
			api: "openai-completions",
			provider: "deepseek",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", max: "max" });
	});

	it("deepseek-v4 on openrouter adds xhigh and nulls max", () => {
		const model = {
			id: "deepseek-v4-pro",
			api: "openai-completions",
			provider: "openrouter",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null });
	});

	it("gpt-5.6 responses model gets off/xhigh/max", () => {
		const model = {
			id: "gpt-5.6",
			api: "openai-responses",
			provider: "openai",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, xhigh: "xhigh", max: "max" });
	});

	it("gpt-5.5 responses model gets minimal null", () => {
		const model = {
			id: "gpt-5.5",
			api: "openai-responses",
			provider: "openai",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", minimal: null });
	});

	it("xai grok-4.5 responses model uses the effort map", () => {
		const model = {
			id: "grok-4.5",
			api: "openai-responses",
			provider: "xai",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null });
	});

	it("anthropic adaptive thinking models get forceAdaptiveThinking and effort levels", () => {
		const model = {
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
		expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
	});

	it("claude-sonnet-4.6 gets max but keeps temperature", () => {
		const model = {
			id: "claude-sonnet-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
		expect(model.compat).not.toHaveProperty("supportsTemperature");
		expect(model.thinkingLevelMap).toEqual({ max: "max" });
	});

	it("opencode-go glm-5.2 uses the opencode-go level map", () => {
		const model = {
			id: "glm-5.2",
			api: "openai-completions",
			provider: "opencode-go",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: "high", max: "max" });
	});

	it("gemini-3-pro google model gets the gemini level map", () => {
		const model = {
			id: "gemini-3-pro",
			api: "google-generative-ai",
			provider: "google",
		} as unknown as Model<any>;
		applyThinkingLevelMetadata(model);
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" });
	});
});

describe("S9 normalizeModelsDevData", () => {
	const snapshot = {
		"amazon-bedrock": {
			models: {
				"ai21.jamba-1.5-large": { tool_call: true },
				"mistral.mistral-7b-instruct-v0.2": { tool_call: true },
				"eu.anthropic.claude-3-5-sonnet": {
					tool_call: true,
					name: "Claude 3.5",
					reasoning: true,
					limit: { context: 200000, output: 8192 },
					cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
				},
			},
		},
		anthropic: {
			models: {
				"claude-opus-4-6": {
					tool_call: true,
					name: "Opus 4.6",
					reasoning: true,
					limit: { context: 200000, output: 32000 },
					cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
				},
			},
		},
		"github-copilot": {
			models: {
				"claude-sonnet-4.5": {
					tool_call: true,
					name: "Copilot Sonnet",
					reasoning: true,
					limit: { context: 128000, output: 8192 },
					cost: {
						input: 3,
						output: 15,
						cache_read: 0.3,
						cache_write: 3,
						tiers: [
							{
								input: 1.5,
								output: 7.5,
								cache_read: 0.15,
								cache_write: 1.5,
								tier: { type: "context", size: 100000 },
							},
						],
					},
				},
			},
		},
		nvidia: {
			models: {
				"meta_llama-3.1-405b": {
					tool_call: true,
					name: "Llama 3.1 405B",
					modalities: { input: ["text"], output: ["text"] },
					limit: { context: 128000, output: 4096 },
				},
			},
		},
		xiaomi: {
			models: {
				"MiMo-7B": { tool_call: true, name: "MiMo 7B", cost: { input: 0.14, output: 0.28 } },
			},
		},
		"xiaomi-token-plan-sgp": {
			models: {
				"MiMo-7B": { tool_call: true, name: "MiMo SGP" },
			},
		},
	};

	it("maps bedrock models with eu base url and skips jamba/mistral-7b", () => {
		const models = normalizeModelsDevData(snapshot, new Map());
		const bedrock = models.filter((model) => model.provider === "amazon-bedrock");
		expect(bedrock).toHaveLength(1);
		expect(bedrock[0]).toMatchObject({
			id: "eu.anthropic.claude-3-5-sonnet",
			name: "Claude 3.5",
			api: "bedrock-converse-stream",
			baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com",
			reasoning: true,
			contextWindow: 200000,
			maxTokens: 8192,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
	});

	it("maps anthropic models without tiers and keeps github-copilot tiered costs", () => {
		const models = normalizeModelsDevData(snapshot, new Map());
		const opus = models.find((model) => model.id === "claude-opus-4-6");
		expect(opus).toMatchObject({
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 200000,
		});
		expect(opus?.cost).not.toHaveProperty("tiers");
		const copilot = models.find((model) => model.provider === "github-copilot");
		expect(copilot).toMatchObject({
			id: "claude-sonnet-4.5",
			api: "anthropic-messages",
			baseUrl: "https://api.individual.githubcopilot.com",
			contextWindow: 128000,
		});
		expect(copilot?.cost.tiers).toEqual([
			{ inputTokensAbove: 100000, input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 },
		]);
	});

	it("resolves nvidia ids through the NIM map and applies nvidia compat", () => {
		const models = normalizeModelsDevData(snapshot, new Map([["meta.llama-3.1-405b", "meta/llama-3.1-405b-instruct"]]));
		const nvidia = models.find((model) => model.provider === "nvidia");
		expect(nvidia).toMatchObject({
			id: "meta/llama-3.1-405b-instruct",
			api: "openai-completions",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			contextWindow: 128000,
			maxTokens: 4096,
		});
		expect(nvidia?.compat).toMatchObject({ supportsStore: false });
	});

	it("maps xiaomi token plan variants with their billing endpoints", () => {
		const models = normalizeModelsDevData(snapshot, new Map());
		const xiaomi = models.find((model) => model.provider === "xiaomi");
		const sgp = models.find((model) => model.provider === "xiaomi-token-plan-sgp");
		expect(xiaomi).toMatchObject({
			id: "MiMo-7B",
			baseUrl: "https://api.xiaomimimo.com/v1",
			compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
		});
		expect(sgp).toMatchObject({
			id: "MiMo-7B",
			name: "MiMo SGP",
			baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		});
	});

	it("skips nvidia models missing from the NIM live map", () => {
		const models = normalizeModelsDevData({ ...snapshot, nvidia: { models: { "unknown-model": { tool_call: true, modalities: { input: ["text"], output: ["text"] } } } } }, new Map());
		expect(models.some((model) => model.provider === "nvidia")).toBe(false);
	});
});

describe("S9 emitters", () => {
	function fixtureProviders(): Record<string, Record<string, Model<any>>> {
		return {
			openai: {
				"gpt-4o": { id: "gpt-4o", name: "GPT-4o", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				"gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o mini", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			},
			"amazon-bedrock": {
				"eu.claude-3": { id: "eu.claude-3", name: "Claude 3", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			},
		} as unknown as Record<string, Record<string, Model<any>>>;
	}

	it("emitProviderData writes api-grouped data and type-derivation shards", () => {
		const dir = mkdtempSync(join(tmpdir(), "rl-s9-emit-"));
		try {
			mkdirSync(join(dir, "src/providers"), { recursive: true });
			emitProviderData(fixtureProviders(), { packageRoot: dir, pretty: false });
			const openaiModels = readFileSync(join(dir, "src/providers/openai.models.ts"), "utf8");
			expect(openaiModels).toContain('import values from "./data/openai.json" with { type: "json" };');
			expect(openaiModels).toContain(
				'export const OPENAI_MODELS: ModelCatalog<typeof values, "openai"> =',
			);
			expect(openaiModels).toContain('flattenModelCatalog("openai", values);');
			const openaiData = JSON.parse(readFileSync(join(dir, "src/providers/data/openai.json"), "utf8"));
			expect(Object.keys(openaiData)).toEqual(["openai-responses"]);
			expect(Object.keys(openaiData["openai-responses"])).toEqual(["gpt-4o", "gpt-4o-mini"]);
			const bedrockData = JSON.parse(readFileSync(join(dir, "src/providers/data/amazon-bedrock.json"), "utf8"));
			expect(Object.keys(bedrockData)).toEqual(["bedrock-converse-stream"]);
			expect(Object.keys(bedrockData["bedrock-converse-stream"])).toEqual(["eu.claude-3"]);
			const dataFiles = readdirSync(join(dir, "src/providers/data")).sort();
			expect(dataFiles).toEqual(["amazon-bedrock.json", "openai.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("emitModelTypes writes the sorted aggregator", () => {
		const dir = mkdtempSync(join(tmpdir(), "rl-s9-aggregate-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			emitModelTypes(fixtureProviders(), { packageRoot: dir, pretty: false, jsonOutputDir: undefined });
			const generated = readFileSync(join(dir, "src/models.generated.ts"), "utf8");
			expect(generated.indexOf('import { AMAZON_BEDROCK_MODELS } from "./providers/amazon-bedrock.models.ts";')).toBeLessThan(
				generated.indexOf('import { OPENAI_MODELS } from "./providers/openai.models.ts";'),
			);
			expect(generated).toContain('readonly "amazon-bedrock": typeof AMAZON_BEDROCK_MODELS;');
			expect(generated).toContain('"openai": OPENAI_MODELS,');
			expect(generated).toContain("} = {");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("emitModelTypes writes the jsonOutputDir dump", () => {
		const dir = mkdtempSync(join(tmpdir(), "rl-s9-json-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			const jsonOut = join(dir, "catalog-out");
			emitModelTypes(fixtureProviders(), { packageRoot: dir, pretty: false, jsonOutputDir: jsonOut });
			const modelsJson = JSON.parse(readFileSync(join(jsonOut, "models.json"), "utf8"));
			expect(Object.keys(modelsJson)).toEqual(["amazon-bedrock", "openai"]);
			expect(JSON.parse(readFileSync(join(jsonOut, "providers.json"), "utf8"))).toEqual(["amazon-bedrock", "openai"]);
			expect(JSON.parse(readFileSync(join(jsonOut, "providers/openai.json"), "utf8"))).toEqual({
				"gpt-4o": fixtureProviders().openai["gpt-4o"],
				"gpt-4o-mini": fixtureProviders().openai["gpt-4o-mini"],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});


describe("DeepSeek temporary model catalog", () => {
	it("registers the requested ID even when upstream sources omit it", () => {
		const model = normalizeProviderCatalogs([]).deepseek?.["deepseek-v4.1-flash-expires-on-0910"];
		expect(model).toMatchObject({
			id: "deepseek-v4.1-flash-expires-on-0910",
			provider: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
			thinkingLevelMap: { high: "high", max: "max" },
		});
	});
});
