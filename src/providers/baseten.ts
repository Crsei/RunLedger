import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { BASETEN_MODELS } from "./baseten.models.ts";

const BASETEN_DEFAULT_BASE_URL = "https://inference.baseten.co/v1";

export interface BasetenProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || BASETEN_DEFAULT_BASE_URL;
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

function mapInput(entry: JsonRecord, reference: Model<"openai-completions"> | undefined): ("text" | "image")[] {
	const modalities = isRecord(entry.modalities) && Array.isArray(entry.modalities.input)
		? entry.modalities.input
		: undefined;
	if (modalities) return modalities.includes("image") ? ["text", "image"] : ["text"];
	return reference?.input ?? ["text"];
}

function mapCost(entry: JsonRecord, reference: Model<"openai-completions"> | undefined): ModelCost {
	const cost = isRecord(entry.cost) ? entry.cost : {};
	const referenceCost = reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: nonNegativeNumber(cost.input, referenceCost.input),
		output: nonNegativeNumber(cost.output, referenceCost.output),
		cacheRead: nonNegativeNumber(cost.cache_read, referenceCost.cacheRead),
		cacheWrite: nonNegativeNumber(cost.cache_write, referenceCost.cacheWrite),
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
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : (reference?.name ?? id);
	const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : (reference?.reasoning ?? false);
	const limit = isRecord(entry.limit) ? entry.limit : {};
	return {
		...(reference ?? {
			id,
			name,
			api: "openai-completions" as const,
			provider: "baseten" as const,
			baseUrl,
			reasoning,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		provider: "baseten",
		baseUrl,
		reasoning,
		input: mapInput(entry, reference),
		cost: mapCost(entry, reference),
		contextWindow: positiveNumber(limit.context, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(limit.output, reference?.maxTokens ?? 4096),
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
	if (!apiKey) throw new Error("Baseten API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Baseten models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid Baseten model catalog response");

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Baseten returned an empty model catalog");
	return [...models.values()];
}

export function basetenProvider(options: BasetenProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.BASETEN_BASE_URL);
	const staticModels = Object.values(BASETEN_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "baseten",
		name: "Baseten",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Baseten API key", ["BASETEN_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
