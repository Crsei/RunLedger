import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost, ThinkingLevel, ThinkingLevelMap } from "../types.ts";
import { SYNTHETIC_MODELS } from "./synthetic.models.ts";

export interface SyntheticProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://api.synthetic.new/openai/v1";
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function modelName(entry: JsonRecord, fallback: string): string {
	for (const candidate of [entry.description, entry.name]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/** Synthetic 的 thinking-off wire 档位:路由状态,不是用户档位。 */
const SYNTHETIC_WIRE_EFFORT_NONE = "none";
/** 未声明 max_output_length 时的输出上限。 */
const SYNTHETIC_FALLBACK_MAX_TOKENS = 8192;

function toSyntheticStringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Synthetic 按「每 token 美元」报价(如 "$0.000001"),catalog 成本是每百万 token;
 * 先按 1e6 缩放再取整,避免浮点漂移。
 */
function toSyntheticCostPerMillion(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value.trim().replace(/^\$/, "")) : nonNegativeNumber(value, -1);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return Math.round(parsed * 1e12) / 1e6;
}

function resolveSyntheticCost(entry: JsonRecord, fallback: ModelCost): ModelCost {
	const pricing = entry.pricing;
	if (!isRecord(pricing)) return fallback;
	const input = toSyntheticCostPerMillion(pricing.prompt);
	const output = toSyntheticCostPerMillion(pricing.completion);
	if (input === undefined || output === undefined) return fallback;
	return {
		input,
		output,
		cacheRead: toSyntheticCostPerMillion(pricing.input_cache_reads) ?? fallback.cacheRead,
		cacheWrite: toSyntheticCostPerMillion(pricing.input_cache_writes) ?? fallback.cacheWrite,
	};
}

const SYNTHETIC_EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * 把 wire 声明的 reasoning_effort 词汇表映射成档位阶梯:`none` 是 thinking 关闭态,
 * 挂到 minimal 档上(与 Fireworks 的 minimal → none 映射一致);wire 静默时返回
 * undefined,让参考模型的档位保留。
 */
function resolveSyntheticThinkingLevelMap(wireEfforts: readonly string[]): ThinkingLevelMap | undefined {
	const named = wireEfforts.filter((effort): effort is ThinkingLevel => SYNTHETIC_EFFORT_LEVELS.has(effort));
	const wireHasNone = wireEfforts.includes(SYNTHETIC_WIRE_EFFORT_NONE);
	if (named.length === 0) {
		return wireHasNone ? { minimal: SYNTHETIC_WIRE_EFFORT_NONE } : undefined;
	}
	const map: ThinkingLevelMap = {};
	if (wireHasNone && !named.includes("minimal")) {
		map.minimal = SYNTHETIC_WIRE_EFFORT_NONE;
	}
	for (const effort of named) {
		map[effort] = effort;
	}
	return map;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const features = toSyntheticStringList(entry.supported_features);
	const modalities = toSyntheticStringList(entry.input_modalities);
	const wireEfforts = isRecord(entry.reasoning_parameters)
		? toSyntheticStringList(entry.reasoning_parameters.efforts)
		: [];
	const wireReasoning = features.includes("reasoning") || wireEfforts.length > 0;
	const namedTierCount = wireEfforts.filter((effort) => SYNTHETIC_EFFORT_LEVELS.has(effort)).length;
	// 声明了具名档位才算 reasoning;仅 none/未识别档位是纯 off 开关;
	// wire 对 reasoning 完全静默时参考模型投票。
	const reasoning =
		wireReasoning && namedTierCount > 0
			? true
			: wireEfforts.length > 0
				? false
				: entry.supports_reasoning === true || (reference?.reasoning ?? false);
	const thinkingLevelMap = resolveSyntheticThinkingLevelMap(wireEfforts);
	const referenceSupportsImage = reference?.input.includes("image") ?? false;
	const input: ("text" | "image")[] =
		modalities.includes("image") || entry.supports_vision === true || referenceSupportsImage
			? ["text", "image"]
			: ["text"];
	const zeroCost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "synthetic" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: zeroCost,
			contextWindow: 4096,
			maxTokens: SYNTHETIC_FALLBACK_MAX_TOKENS,
		}),
		name: modelName(entry, reference?.name ?? id),
		provider: "synthetic",
		baseUrl,
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input,
		cost: resolveSyntheticCost(entry, reference?.cost ?? zeroCost),
		contextWindow: positiveNumber(entry.context_length, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(
			entry.max_output_length ?? entry.max_tokens,
			reference?.maxTokens ?? SYNTHETIC_FALLBACK_MAX_TOKENS,
		),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Synthetic API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Synthetic models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Synthetic model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Synthetic returned an empty model catalog");
	return [...models.values()];
}

export function syntheticProvider(options: SyntheticProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.SYNTHETIC_BASE_URL);
	const staticModels = Object.values(SYNTHETIC_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "synthetic",
		name: "Synthetic",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Synthetic API key", ["SYNTHETIC_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
