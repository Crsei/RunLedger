import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { WAFER_SERVERLESS_MODELS } from "./wafer-serverless.models.ts";

const WAFER_SERVERLESS_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MAX_TOKENS_CAP = 65536;

export interface WaferServerlessProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
	const configured = value?.trim();
	if (!configured) return undefined;
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

function modelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

// Wafer 把能力与价格包在每条记录的 wafer 信封里(wholesale 美分),公开价 = 美分 × 125 / 10000
interface WaferEnvelope {
	context_length?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function waferEnvelope(entry: JsonRecord): WaferEnvelope {
	const wafer = entry.wafer;
	return isRecord(wafer) ? (wafer as WaferEnvelope) : {};
}

function waferCostCents(value: unknown): number {
	return (nonNegativeNumber(value, 0) * 125) / 10000;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const wafer = waferEnvelope(entry);
	const capabilities = isRecord(wafer.capabilities) ? wafer.capabilities : {};
	const pricing = isRecord(wafer.pricing) ? wafer.pricing : {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const contextWindow = positiveNumber(wafer.context_length, reference?.contextWindow ?? 4096);
	const maxTokens = Math.min(contextWindow, WAFER_MAX_TOKENS_CAP);
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "wafer-serverless" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: modelName(wafer.display_name, reference?.name ?? id),
		provider: "wafer-serverless",
		baseUrl,
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		cost: {
			input: waferCostCents(pricing.input_cents_per_million),
			output: waferCostCents(pricing.output_cents_per_million),
			cacheRead: waferCostCents(pricing.cache_read_cents_per_million),
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
		// 保留静态目录 compat(如 GLM/Kimi 的 thinkingFormat),并强制 supportsDeveloperRole: false
		compat: { ...reference?.compat, supportsDeveloperRole: false },
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	fetchImpl: typeof fetch,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Wafer Serverless API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(
			`Could not load Wafer Serverless models: ${response.status}: ${truncateBody(await response.text())}`,
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Wafer Serverless model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Wafer Serverless returned an empty model catalog");
	return [...models.values()];
}

export function waferServerlessProvider(
	options: WaferServerlessProviderOptions = {},
): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl) ?? WAFER_SERVERLESS_BASE_URL;
	const staticModels = Object.values(WAFER_SERVERLESS_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "wafer-serverless",
		name: "Wafer Serverless",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Wafer Serverless API key", ["WAFER_SERVERLESS_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, options.fetch ?? globalThis.fetch, baseUrl, staticModels),
		api: openAICompletionsApi(),
	});
}
