import type { Model, ThinkingLevelMap } from "../types.ts";

export const AIAND_DEFAULT_BASE_URL = "https://api.aiand.com/v1";

const AIAND_THINKING: ThinkingLevelMap = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

function createAiandModel(
	id: string,
	name: string,
	cost: { input: number; output: number },
	contextWindow: number,
	maxTokens: number,
	input: ("text" | "image")[],
	thinkingLevelMap: ThinkingLevelMap = AIAND_THINKING,
): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "aiand",
		baseUrl: AIAND_DEFAULT_BASE_URL,
		reasoning: true,
		input,
		cost: { input: cost.input, output: cost.output, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		thinkingLevelMap,
	};
}

/** Static ai& seed copied from the oh-my-pi bundled catalog at the source snapshot. */
export const AIAND_STATIC_MODELS: readonly Model<"openai-completions">[] = [
	createAiandModel(
		"deepseek-ai/deepseek-v4-flash",
		"DeepSeek V4 Flash",
		{ input: 0.15, output: 0.25 },
		1_048_576,
		393_216,
		["text"],
		{ minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	),
	createAiandModel(
		"deepseek-ai/deepseek-v4-pro",
		"DeepSeek V4 Pro",
		{ input: 1, output: 2.5 },
		1_048_576,
		393_216,
		["text"],
		{ minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
	),
	createAiandModel(
		"google/gemma-4-31b-it",
		"Gemma 4 31B IT",
		{ input: 0.2, output: 0.5 },
		262_144,
		262_144,
		["text", "image"],
		{ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	),
	createAiandModel(
		"moonshotai/kimi-k2.7-code",
		"Kimi K2.7 Code",
		{ input: 0.75, output: 3.5 },
		262_144,
		262_144,
		["text", "image"],
	),
	createAiandModel(
		"moonshotai/kimi-k3",
		"Kimi K3",
		{ input: 3, output: 12.5 },
		1_048_576,
		131_072,
		["text", "image"],
		{ minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	),
	createAiandModel(
		"openai/gpt-oss-120b",
		"GPT OSS 120B",
		{ input: 0.15, output: 0.6 },
		131_072,
		131_072,
		["text"],
		{ minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	),
	createAiandModel(
		"qwen/qwen3.6-27b",
		"Qwen3.6 27B",
		{ input: 0.32, output: 3.2 },
		262_144,
		262_144,
		["text", "image"],
	),
	createAiandModel(
		"zai-org/glm-5.2",
		"GLM 5.2",
		{ input: 1, output: 4 },
		1_048_576,
		131_072,
		["text"],
		{ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
	),
];
