/**
 * S9 拆分:thinking level metadata(常量映射 + 应用)。
 *
 * 纯函数与常量,不访问网络;依赖 compat-metadata 的行为谓词。
 */

import type { Api, Model } from "../../src/types.ts";
import {
	detectOpenAICompletionsCompat,
	isAnthropicAdaptiveThinkingModel,
	isAnthropicTemperatureUnsupportedModel,
	isGoogleThinkingApi,
	OPENAI_RESPONSES_NONE_REASONING_MODELS,
	mergeAnthropicMessagesCompat,
	supportsOpenAiMax,
	supportsOpenAiXhigh,
	XAI_RESPONSES_EFFORT_LEVEL_MAP,
	XAI_RESPONSES_MODEL_ID,
} from "./compat-metadata.ts";

export const ZAI_GLM52_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "high",
	medium: "high",
	high: "high",
	max: "max",
} as const;
export const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
export const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;

export const KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
export const KIMI_K3_MAX_TOKENS = 131072;
export const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
} as const;
// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
export const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
};
export const OPENROUTER_KIMI_K3_MODEL_IDS = new Set(["moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);

export const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

export const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

export function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

export function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

export function isGemini3FlashModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

export function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

export function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (model.provider === "xai" && model.api === "openai-responses" && model.id === XAI_RESPONSES_MODEL_ID) {
		mergeThinkingLevelMap(model, XAI_RESPONSES_EFFORT_LEVEL_MAP);
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (
		model.api === "openai-completions" &&
		model.id.includes("deepseek-v4") &&
		(model.provider === "deepseek" || model.provider === "openrouter" || model.provider === "opencode")
	) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" });
	}
	if (isGoogleThinkingApi(model) && isGemini3FlashModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" });
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3-32b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (model.provider === "openai-codex" && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// Pi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks" && model.id.includes("glm-5p2")) {
		mergeThinkingLevelMap(model, { off: "none", minimal: null, low: "high", medium: "high", max: "max" });
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "ant-ling" && model.reasoning) {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = Object.entries(GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES).find(([id]) => id === model.id)?.[1];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}
