import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { VENICE_MODELS } from "./venice.models.ts";

export interface VeniceProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://api.venice.ai/api/v1";
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
			provider: "venice" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: modelName(entry, reference?.name ?? id),
		provider: "venice",
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
	// 发现不 gate:无凭证也可拉取目录,未配置时不上 Authorization 头。
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers,
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Venice models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Venice model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Venice returned an empty model catalog");
	return [...models.values()];
}

export function veniceProvider(options: VeniceProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.VENICE_BASE_URL);
	const staticModels = Object.values(VENICE_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "venice",
		name: "Venice",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Venice API key", ["VENICE_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
