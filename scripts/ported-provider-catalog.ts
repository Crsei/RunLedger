/**
 * oh-my-pi 新增 provider 移植的模型数据源(2026-08 批次)。
 *
 * 唯一来源: scripts/sources/oh-my-pi-provider-models-17.2.15.json —— 由
 * scripts/sources/extract-oh-my-pi-models.ts 从 oh-my-pi 冻结快照
 * (06aecdd51f07e689e970ceaa180abe2be0c14bbb, v17.2.15) 的
 * packages/catalog/src/models.json 提取。
 *
 * 生成契约:
 * - vendored 条目按 provider 映射表归一化为目标 Model(api/baseUrl/compat
 *   白名单化,maxTokens null 回退);
 * - 来源无 bundled catalog 的 provider(litellm / lm-studio / siliconflow /
 *   siliconflow-cn / vllm)使用下方 hand-seed 占位,运行时动态发现为准;
 * - 禁止手工编辑 src/models.generated.ts 或 src/providers/data/*.json。
 */

import values from "./sources/oh-my-pi-provider-models-17.2.15.json" with { type: "json" };
import type {
	Api,
	KnownProvider,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";

type JsonRecord = Record<string, unknown>;

const PORTED = values as Record<string, JsonRecord[]>;

/** maxTokens 为 null 时的回退输出上限:不超过 context,且不越过 64K。 */
const MAX_TOKENS_FALLBACK = 65_536;

/** vendored compat 白名单 → RunLedger OpenAICompletionsCompat。 */
const COMPLETIONS_COMPAT_KEYS = new Set([
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"thinkingFormat",
	"requiresReasoningContentForToolCalls",
]);

/** 来源 thinkingFormat 到 RunLedger 枚举的映射("kimi" 无等价 dialect,归入 "zai" 的 thinking:{type} 编码)。 */
const THINKING_FORMAT_MAP: Record<string, OpenAICompletionsCompat["thinkingFormat"]> = {
	openai: "openai",
	openrouter: "openrouter",
	deepseek: "deepseek",
	together: "together",
	zai: "zai",
	qwen: "qwen",
	"qwen-chat-template": "qwen-chat-template",
	"chat-template": "chat-template",
	"string-thinking": "string-thinking",
	"ant-ling": "ant-ling",
	kimi: "zai",
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapCompletionsCompat(raw: unknown): OpenAICompletionsCompat | undefined {
	if (!isRecord(raw)) return undefined;
	const compat: OpenAICompletionsCompat = {};
	for (const key of COMPLETIONS_COMPAT_KEYS) {
		const value = raw[key];
		if (key === "thinkingFormat") {
			if (typeof value !== "string") continue;
			const mapped = THINKING_FORMAT_MAP[value];
			if (mapped) compat.thinkingFormat = mapped;
			continue;
		}
		if (key === "requiresReasoningContentForToolCalls") {
			if (value === true) compat.requiresReasoningContentOnAssistantMessages = true;
			continue;
		}
		if (typeof value === "boolean") {
			(compat as Record<string, unknown>)[key] = value;
		}
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function mapCost(entry: JsonRecord): Model<Api>["cost"] {
	const cost = isRecord(entry.cost) ? entry.cost : {};
	return {
		input: typeof cost.input === "number" ? cost.input : 0,
		output: typeof cost.output === "number" ? cost.output : 0,
		cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
		cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
	};
}

function mapInput(entry: JsonRecord): ("text" | "image")[] {
	const input = entry.input;
	return Array.isArray(input) && input.includes("image") ? ["text", "image"] : ["text"];
}

interface PortedProviderConfig {
	/** vendored JSON 中的来源 key。 */
	sourceKey: string;
	/** 目标 provider id(identity 重写: xai-oauth → xai)。 */
	provider: string;
	/** 覆盖 vendored baseUrl(模板或占位 URL 由 runtime factory 再解析)。 */
	baseUrl?: string;
	/** 覆盖所有模型的 api(不设置时保留 vendored per-model api)。 */
	api?: Api;
	/** 合并到每个模型上的 compat 覆盖。 */
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
	/** 过滤掉不适合作为 builtin 的模型 id。 */
	filterModel?: (id: string) => boolean;
}

/**
 * 每 provider 一行映射。api/auth/base URL/discovery 的逐 provider 审计结论见
 * development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md §2.1。
 */
const PORTED_PROVIDER_CONFIGS: readonly PortedProviderConfig[] = [
	// A 批次
	{ sourceKey: "aimlapi", provider: "aimlapi" },
	{ sourceKey: "baseten", provider: "baseten" },
	{ sourceKey: "coreweave", provider: "coreweave" },
	{ sourceKey: "firepass", provider: "firepass" },
	{ sourceKey: "gmi-cloud", provider: "gmi-cloud" },
	{ sourceKey: "nanogpt", provider: "nanogpt" },
	{ sourceKey: "novita", provider: "novita" },
	{ sourceKey: "qianfan", provider: "qianfan" },
	{ sourceKey: "synthetic", provider: "synthetic" },
	{
		sourceKey: "venice",
		provider: "venice",
		compat: { supportsUsageInStreaming: false },
	},
	{
		sourceKey: "zhipu-coding-plan",
		provider: "zhipu-coding-plan",
		compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
	},
	// B 批次
	{
		sourceKey: "alibaba-coding-plan",
		provider: "alibaba-coding-plan",
		compat: { supportsDeveloperRole: false },
	},
	{
		sourceKey: "alibaba-token-plan",
		provider: "alibaba-token-plan",
		compat: { supportsDeveloperRole: false },
	},
	{ sourceKey: "bedrock-mantle", provider: "bedrock-mantle" },
	{ sourceKey: "kilo", provider: "kilo" },
	{
		sourceKey: "kimi-code",
		provider: "kimi-code",
		compat: { supportsDeveloperRole: false },
	},
	{ sourceKey: "meta", provider: "meta" },
	{
		sourceKey: "minimax-code",
		provider: "minimax-code",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
	},
	{
		sourceKey: "minimax-code-cn",
		provider: "minimax-code-cn",
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
	},
	{ sourceKey: "opencode-zen", provider: "opencode-zen" },
	{ sourceKey: "qwen-portal", provider: "qwen-portal" },
	{ sourceKey: "sakana", provider: "sakana" },
	{ sourceKey: "umans", provider: "umans" },
	{
		sourceKey: "wafer-serverless",
		provider: "wafer-serverless",
		compat: { supportsDeveloperRole: false },
	},
	// identity 映射:xai-oauth 的 OAuth 流已在目标 xai provider;其 responses 模型并入 xai catalog。
	// 与目标已有 completions 条目同 id 的三个模型丢弃,避免一个 id 两种 api(见清单 §2.1)。
	{
		sourceKey: "xai-oauth",
		provider: "xai",
		filterModel: (id) => !["grok-4.3", "grok-4.5", "grok-build-0.1"].includes(id),
	},
	{ sourceKey: "zenmux", provider: "zenmux" },
];

/** 来源无 bundled catalog 的 provider hand-seed(运行时动态发现为准)。 */
const HAND_SEEDED_MODELS: readonly Model<"openai-completions">[] = [
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://localhost:4000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_768,
	},
	{
		id: "llama-3-8b",
		name: "Llama 3 8B",
		api: "openai-completions",
	provider: "lm-studio",
	baseUrl: "http://127.0.0.1:1234/v1",
	reasoning: false,
	input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	},
	{
		id: "gpt-oss-20b",
		name: "GPT-OSS 20B",
		api: "openai-completions",
		provider: "vllm",
		baseUrl: "http://127.0.0.1:8000/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 8192,
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM 5.1",
		api: "openai-completions",
		provider: "siliconflow",
		baseUrl: "https://api.siliconflow.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 65_536,
	},
	{
		id: "deepseek-ai/DeepSeek-V4-Pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "siliconflow",
		baseUrl: "https://api.siliconflow.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 393_216,
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM 5.1",
		api: "openai-completions",
		provider: "siliconflow-cn",
		baseUrl: "https://api.siliconflow.cn/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 65_536,
	},
	{
		id: "deepseek-ai/DeepSeek-V4-Pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "siliconflow-cn",
		baseUrl: "https://api.siliconflow.cn/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 393_216,
	},
];

function mapVendoredEntry(entry: JsonRecord, config: PortedProviderConfig): Model<Api> | undefined {
	const id = typeof entry.id === "string" ? entry.id : "";
	if (!id) return undefined;
	if (config.filterModel && !config.filterModel(id)) return undefined;
	const contextWindow = positiveNumber(entry.contextWindow, 4096);
	const api = (config.api ?? (typeof entry.api === "string" ? (entry.api as Api) : "openai-completions")) as Api;
	const baseUrl = config.baseUrl ?? (typeof entry.baseUrl === "string" ? entry.baseUrl : "");
	const model: Model<Api> = {
		id,
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
		api,
		provider: config.provider,
		baseUrl,
		reasoning: entry.reasoning === true,
		input: mapInput(entry),
		cost: mapCost(entry),
		contextWindow,
		maxTokens: positiveNumber(entry.maxTokens, Math.min(contextWindow, MAX_TOKENS_FALLBACK)),
	};
	if (api === "openai-completions") {
		const vendoredCompat = mapCompletionsCompat(entry.compat);
		const compat = vendoredCompat || config.compat ? { ...vendoredCompat, ...config.compat } : undefined;
		if (compat && Object.keys(compat).length > 0) {
			(model as Model<"openai-completions">).compat = compat;
		}
	} else if (api === "openai-responses" && config.compat) {
		(model as Model<"openai-responses">).compat = config.compat as OpenAIResponsesCompat;
	}
	return model;
}

/** 全部移植 provider 的静态模型(生成器直接 push 进 allModels)。 */
export function loadPortedProviderModels(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const config of PORTED_PROVIDER_CONFIGS) {
		const entries = PORTED[config.sourceKey];
		if (!entries) {
			throw new Error(`vendored catalog missing source key "${config.sourceKey}" — re-run scripts/sources/extract-oh-my-pi-models.ts`);
		}
		for (const rawEntry of entries) {
			if (!isRecord(rawEntry)) continue;
			const model = mapVendoredEntry(rawEntry, config);
			if (model) models.push(model);
		}
	}
	models.push(
		...HAND_SEEDED_MODELS.map((model) => ({
			...model,
			input: [...model.input],
			cost: { ...model.cost },
		})),
	);
	return models;
}

/** 生成器写入 models.generated.ts 时经 KnownProvider 校验。 */
export const PORTED_PROVIDER_IDS = [
	...PORTED_PROVIDER_CONFIGS.map((config) => config.provider),
	...new Set(HAND_SEEDED_MODELS.map((model) => model.provider)),
] as const satisfies readonly KnownProvider[];
