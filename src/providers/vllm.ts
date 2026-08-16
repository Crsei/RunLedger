import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth, AuthInteraction } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { VLLM_MODELS } from "./vllm.models.ts";

const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
/** 本地无 key 时的哨兵 key:RunLedger 的 openai 适配器要求 apiKey 非空。 */
const VLLM_SENTINEL_API_KEY = "vllm-local";

export interface VllmProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
	const configured = value?.trim() || fallback;
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
	const cost = isRecord(entry.cost) ? entry.cost : undefined;
	return {
		input: nonNegativeNumber(cost?.input, 0),
		output: nonNegativeNumber(cost?.output, 0),
		cacheRead: nonNegativeNumber(cost?.cache_read, 0),
		cacheWrite: nonNegativeNumber(cost?.cache_write, 0),
	};
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const limit = isRecord(entry.limit) ? entry.limit : undefined;
	const contextWindow = positiveNumber(
		limit?.context ?? entry.max_model_len ?? entry.context_length,
		reference?.contextWindow ?? 4096,
	);
	const modalitiesInput = isRecord(entry.modalities) ? entry.modalities.input : undefined;
	const input: ("text" | "image")[] = Array.isArray(modalitiesInput)
		? (modalitiesInput.includes("image") ? ["text", "image"] : ["text"])
		: (reference?.input ?? ["text"]);
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "vllm" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : (reference?.name ?? id),
		provider: "vllm",
		baseUrl,
		reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : (reference?.reasoning ?? false),
		input,
		cost: mapCost(entry),
		contextWindow,
		maxTokens: positiveNumber(limit?.output, reference?.maxTokens ?? Math.min(contextWindow, 65536)),
	};
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

// 简化：与源一致，仅用 {base}/models 通用发现路径(源未用管理端点或本地探针)
async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	// 哨兵 key 视为未配置,不发送 Authorization 头。
	const rawKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const apiKey = rawKey && rawKey !== VLLM_SENTINEL_API_KEY ? rawKey : undefined;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers,
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load vLLM models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid vLLM model catalog response");

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("vLLM returned an empty model catalog");
	return [...models.values()];
}

const vllmAuth: ApiKeyAuth = {
	name: "vLLM API key (optional)",
	login: async (interaction: AuthInteraction) => {
		const key = (await interaction.prompt({
			type: "secret",
			message: "Enter vLLM API key (optional — empty for keyless local server)",
		})).trim();
		return key ? { type: "api_key", key } : { type: "api_key" };
	},
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env("VLLM_API_KEY"));
		return {
			auth: { apiKey: key ?? VLLM_SENTINEL_API_KEY },
			source: key ? (credential?.key ? "stored credential" : "VLLM_API_KEY") : "no auth required",
		};
	},
};

export function vllmProvider(options: VllmProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.VLLM_BASE_URL, VLLM_DEFAULT_BASE_URL);
	const staticModels = Object.values(VLLM_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "vllm",
		name: "vLLM",
		baseUrl,
		auth: { apiKey: vllmAuth },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
