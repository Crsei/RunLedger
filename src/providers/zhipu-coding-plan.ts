import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { ZHIPU_CODING_PLAN_MODELS } from "./zhipu-coding-plan.models.ts";

export interface ZhipuCodingPlanProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 默认 base 已含版本路径 /v4,配置值按原样使用,不再追加 /v1。
function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://open.bigmodel.cn/api/coding/paas/v4";
	return configured.replace(/\/+$/u, "");
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function mapCost(entry: JsonRecord): ModelCost {
	const currency = typeof entry.currency === "string" ? entry.currency.toLowerCase() : "usd";
	if (currency !== "usd") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: nonNegativeNumber(entry.input_per_1m),
		output: nonNegativeNumber(entry.output_per_1m),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function modelName(entry: JsonRecord, fallback: string): string {
	for (const candidate of [entry.description, entry.name]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return fallback;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
	const reasoning = capabilities.includes("reasoning") || (reference?.reasoning ?? false);
	const hasWireCost =
		typeof entry.currency === "string" || entry.input_per_1m !== undefined || entry.output_per_1m !== undefined;
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "zhipu-coding-plan" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: modelName(entry, reference?.name ?? id),
		provider: "zhipu-coding-plan",
		baseUrl,
		reasoning,
		input: capabilities.includes("vision") || entry.supports_vision === true
			? (["text", "image"] as const)
			: (reference?.input ?? ["text"]),
		...(hasWireCost ? { cost: mapCost(entry) } : {}),
		contextWindow: positiveNumber(entry.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_tokens ?? entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Zhipu Coding Plan API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(
			`Could not load Zhipu Coding Plan models: ${response.status}: ${truncateBody(await response.text())}`,
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Zhipu Coding Plan model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Zhipu Coding Plan returned an empty model catalog");
	return [...models.values()];
}

export function zhipuCodingPlanProvider(options: ZhipuCodingPlanProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.ZHIPU_BASE_URL);
	const staticModels = Object.values(ZHIPU_CODING_PLAN_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "zhipu-coding-plan",
		name: "Zhipu Coding Plan",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Zhipu Coding Plan API key", ["ZHIPU_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
