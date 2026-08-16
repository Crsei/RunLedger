import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { SILICONFLOW_MODELS } from "./siliconflow.models.ts";

export interface SiliconflowProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://api.siliconflow.com/v1";
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
			provider: "siliconflow" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: modelName(entry, reference?.name ?? id),
		provider: "siliconflow",
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

/**
 * SiliconFlow 的 /v1/models 会列出全部托管模型(embedding/reranker/图像/音频/视频
 * 生成等),且条目没有类型字段,按 id 关键字剔除不可用于 chat 补全的模型。
 */
const SILICONFLOW_NON_CHAT_MODEL_TOKENS = [
	"embedding",
	"reranker",
	"bge-",
	"bce-",
	"stable-diffusion",
	"image",
	"flux",
	"kolors",
	"sensevoice",
	"cosyvoice",
	"fish-speech",
	"indextts",
	"sovits",
	"whisper",
	"hunyuanvideo",
	"wan2",
	"ltx-video",
	"speech",
	"moderator",
	"tts",
] as const;

function isLikelyChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) return false;
	return !SILICONFLOW_NON_CHAT_MODEL_TOKENS.some((token) => normalized.includes(token));
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("SiliconFlow API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load SiliconFlow models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid SiliconFlow model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const id = typeof rawEntry.id === "string" ? rawEntry.id.trim() : "";
		if (!id || !isLikelyChatModelId(id)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("SiliconFlow returned an empty model catalog");
	return [...models.values()];
}

export function siliconflowProvider(options: SiliconflowProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.SILICONFLOW_BASE_URL);
	const staticModels = Object.values(SILICONFLOW_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "siliconflow",
		name: "SiliconFlow",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("SiliconFlow API key", ["SILICONFLOW_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
