/** oh-my-pi 18.1.9 固定 catalog；协议与身份映射仍由 RunLedger 拥有。 */
import snapshot from "./sources/oh-my-pi-provider-models-18.1.9.json" with { type: "json" };
import type {
	Api,
	KnownProvider,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";

type JsonRecord = Record<string, unknown>;

const PORTED = snapshot.providers as Record<string, JsonRecord[]>;

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
	"requiresReasoningContentForAllAssistantTurns",
	"supportsStrictMode",
	"maxTokensField",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"supportsLongPromptCacheRetention",
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
		if (key === "requiresReasoningContentForToolCalls" || key === "requiresReasoningContentForAllAssistantTurns") {
			if (value === true) compat.requiresReasoningContentOnAssistantMessages = true;
			continue;
		}
		if (key === "maxTokensField") {
			if (value === "max_tokens" || value === "max_completion_tokens") compat.maxTokensField = value;
			continue;
		}
		if (key === "supportsLongPromptCacheRetention") {
			if (typeof value === "boolean") compat.supportsLongCacheRetention = value;
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
	provider: KnownProvider;
	/** 覆盖 vendored baseUrl(模板或占位 URL 由 runtime factory 再解析)。 */
	baseUrl?: string;
	/** 覆盖所有模型的 api(不设置时保留 vendored per-model api)。 */
	api?: Api;
	/** 合并到每个模型上的 compat 覆盖。 */
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
	/** 过滤掉不适合作为 builtin 的模型 id。 */
	filterModel?: (id: string) => boolean;
	/**
	 * 目标侧退役的模型 id:来源快照仍带着它,但 provider 已确认不再提供。
	 * 从静态基线中删除,避免离线/刷新失败时仍显示已下线的模型;
	 * provider 端若实际仍提供,运行期权威刷新会把它带回来。
	 */
	retiredModels?: readonly string[];
	/** 只同步目标已有协议支持的条目。 */
	filterApi?: Api;
}

/**
 * 每 provider 一行映射。api/auth/base URL/discovery 的逐 provider 审计结论见
 * development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md §2.1。
 */
const PORTED_PROVIDER_CONFIGS: readonly PortedProviderConfig[] = [
	{ sourceKey: "abliteration", provider: "abliteration" },
	{ sourceKey: "cline-pass", provider: "cline-pass" },
	{ sourceKey: "deepinfra", provider: "deepinfra" },
	{ sourceKey: "yolo-auto", provider: "yolo-auto" },
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
	{ sourceKey: "aiand", provider: "aiand" },
	{ sourceKey: "amazon-bedrock", provider: "amazon-bedrock" },
	{ sourceKey: "anthropic", provider: "anthropic" },
	{ sourceKey: "cerebras", provider: "cerebras" },
	{ sourceKey: "cloudflare-ai-gateway", provider: "cloudflare-ai-gateway" },
	{ sourceKey: "deepseek", provider: "deepseek" },
	{ sourceKey: "fireworks", provider: "fireworks" },
	{ sourceKey: "github-copilot", provider: "github-copilot" },
	{ sourceKey: "google", provider: "google" },
	{ sourceKey: "groq", provider: "groq" },
	{ sourceKey: "huggingface", provider: "huggingface" },
	{ sourceKey: "minimax", provider: "minimax" },
	{ sourceKey: "minimax-cn", provider: "minimax-cn" },
	{ sourceKey: "nvidia", provider: "nvidia" },
	{ sourceKey: "openai", provider: "openai" },
	{ sourceKey: "openai-codex", provider: "openai-codex" },
	{
		sourceKey: "opencode-go",
		provider: "opencode-go",
		// provider 的官方端点表(https://opencode.ai/docs/go/)与 /zen/go/v1/models 都已不再列出该模型。
		retiredModels: ["ox-alpha-free"],
	},
	{ sourceKey: "together", provider: "together" },
	{ sourceKey: "vercel-ai-gateway", provider: "vercel-ai-gateway" },
	{ sourceKey: "xai", provider: "xai" },
	{ sourceKey: "xiaomi", provider: "xiaomi" },
	{ sourceKey: "xiaomi-token-plan-ams", provider: "xiaomi-token-plan-ams" },
	{ sourceKey: "xiaomi-token-plan-cn", provider: "xiaomi-token-plan-cn" },
	{ sourceKey: "xiaomi-token-plan-sgp", provider: "xiaomi-token-plan-sgp" },
	{ sourceKey: "moonshot", provider: "moonshotai" },
	{ sourceKey: "mistral", provider: "mistral", api: "mistral-conversations" },
	{ sourceKey: "openrouter", provider: "openrouter", api: "openai-completions" },
	{ sourceKey: "google-vertex", provider: "google-vertex", filterApi: "google-vertex" },
	{ sourceKey: "zai", provider: "zai", filterApi: "openai-completions" },
];

/** 来源无 bundled catalog 的 provider hand-seed(运行时动态发现为准)。 */
const HAND_SEEDED_MODELS: readonly (Model<"openai-completions"> & { provider: KnownProvider })[] = [
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
	if (config.filterApi && entry.api !== config.filterApi) return undefined;
	if (config.filterModel && !config.filterModel(id)) return undefined;
	// 目标侧退役的 id 不进入静态基线;来源快照里的同 id 行同样跳过。
	if (config.retiredModels?.includes(id)) return undefined;
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
	const thinking = isRecord(entry.thinking) ? entry.thinking : undefined;
	if (thinking && Array.isArray(thinking.efforts)) {
		const map: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
		const efforts = thinking.efforts;
		const effortMap = isRecord(thinking.effortMap) ? thinking.effortMap : {};
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			map[level] = efforts.includes(level) ? (typeof effortMap[level] === "string" ? effortMap[level] : level) : null;
		}
		if (thinking.requiresEffort === true) map.off = null;
		model.thinkingLevelMap = map;
	}
	if (config.provider === "abliteration") {
		(model as Model<"openai-responses">).compat = { supportsDeveloperRole: false, supportsLongCacheRetention: false, includeEncryptedReasoning: false };
	}
	if (config.provider === "cline-pass") {
		const compat = (model as Model<"openai-completions">).compat ??= {};
		compat.wireModelId = isRecord(entry.compat) && entry.compat.wireModelIdMode === "raw" ? id : `cline-pass/${id}`;
		if (thinking?.mode === "budget" && isRecord(thinking.effortBudgets)) {
			compat.reasoningBudgetMap = {};
			for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
				const budget = thinking.effortBudgets[level];
				if (typeof budget === "number" && budget > 0) compat.reasoningBudgetMap[level] = budget;
			}
		}
	}
	if (config.provider === "yolo-auto") {
		const compat = (model as Model<"openai-completions">).compat ??= {};
		compat.chatTemplateKwargs = { thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort", omitWhenOff: true } };
		compat.requiresReasoningContentOnAssistantMessages = true;
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

/** 源 catalog 优先同步模型元数据；已有 native transport、URL 和 compat 继续以目标为准。 */
export function mergePortedProviderModels(models: Model<Api>[]): Model<Api>[] {
	const original = new Map(models.map((model) => [`${model.provider}\0${model.id}`, model]));
	const preserve = new Set<string>(["aiand", "amazon-bedrock", "anthropic", "cerebras", "cloudflare-ai-gateway", "deepseek", "fireworks", "github-copilot", "google", "groq", "huggingface", "minimax", "minimax-cn", "nvidia", "openai", "openai-codex", "opencode-go", "together", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "moonshotai", "mistral", "openrouter", "google-vertex", "zai"]);
	const ported = loadPortedProviderModels().map((model) => {
		const previous = original.get(`${model.provider}\0${model.id}`);
		if (!previous || !preserve.has(model.provider)) return model;
		return { ...previous, ...model, api: previous.api, baseUrl: previous.baseUrl, compat: previous.compat,
			thinkingLevelMap: previous.thinkingLevelMap ?? model.thinkingLevelMap,
			cost: { ...model.cost, ...(previous.cost.tiers ? { tiers: previous.cost.tiers } : {}) } };
	});
	const keys = new Set(ported.map((model) => `${model.provider}\0${model.id}`));
	const retired = new Set(PORTED_PROVIDER_CONFIGS.flatMap((config) => [
		...((snapshot.removedModels as Record<string, string[]>)[config.sourceKey] ?? []),
		...(config.retiredModels ?? []),
	].map((id) => `${config.provider}\0${id}`)));
	return [...ported, ...models.filter((model) => !keys.has(`${model.provider}\0${model.id}`) && !retired.has(`${model.provider}\0${model.id}`))];
}
