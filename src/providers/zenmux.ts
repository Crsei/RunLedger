import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { ZENMUX_MODELS } from "./zenmux.models.ts";

const ZENMUX_DEFAULT_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_DEFAULT_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

export interface ZenmuxProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type ZenMuxApi = "anthropic-messages" | "openai-completions";

type JsonRecord = Record<string, unknown>;

function normalizeOpenAiBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || ZENMUX_DEFAULT_OPENAI_BASE_URL;
	const normalized = configured.replace(/\/+$/u, "");
	if (normalized.endsWith("/api/anthropic")) return normalized.replace(/\/api\/anthropic$/u, "/api/v1");
	return normalized;
}

function toAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return parsed.toString();
	} catch {
		return ZENMUX_DEFAULT_ANTHROPIC_BASE_URL;
	}
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function isAnthropicModel(entry: JsonRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") return true;
	return modelId.toLowerCase().startsWith("anthropic/");
}

function pricingValue(pricings: JsonRecord | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) return 0;
	for (const item of bucket) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const value = (item as JsonRecord).value;
		const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
		if (Number.isFinite(numeric)) return numeric;
	}
	return 0;
}

function cacheWritePrice(pricings: JsonRecord | undefined): number {
	const oneHour = pricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) return oneHour;
	const fiveMinute = pricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) return fiveMinute;
	return pricingValue(pricings, "input_cache_write");
}

function inputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text"];
	return value.includes("image") ? ["text", "image"] : ["text"];
}

function mapModel(
	entry: JsonRecord,
	openAiBaseUrl: string,
	anthropicBaseUrl: string,
	staticModels: readonly Model<ZenMuxApi>[],
): Model<ZenMuxApi> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const anthropic = isAnthropicModel(entry, id);
	const api: ZenMuxApi = anthropic ? "anthropic-messages" : "openai-completions";
	const baseUrl = anthropic ? anthropicBaseUrl : openAiBaseUrl;
	const pricings =
		typeof entry.pricings === "object" && entry.pricings !== null && !Array.isArray(entry.pricings)
			? (entry.pricings as JsonRecord)
			: undefined;
	const capabilities =
		typeof entry.capabilities === "object" && entry.capabilities !== null && !Array.isArray(entry.capabilities)
			? (entry.capabilities as JsonRecord)
			: undefined;
	const name =
		typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : reference?.name ?? id;
	return {
		...(reference ?? {
			id,
			name: id,
			api,
			provider: "zenmux" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		api,
		baseUrl,
		provider: "zenmux",
		reasoning: capabilities?.reasoning === true || reference?.reasoning === true,
		input: inputCapabilities(entry.input_modalities),
		cost: {
			input: pricingValue(pricings, "prompt"),
			output: pricingValue(pricings, "completion"),
			cacheRead: pricingValue(pricings, "input_cache_read"),
			cacheWrite: cacheWritePrice(pricings),
		},
		contextWindow: positiveNumber(entry.context_length, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	openAiBaseUrl: string,
	anthropicBaseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<ZenMuxApi>[],
): Promise<readonly Model<ZenMuxApi>[]> {
	const response = await fetchImpl(`${openAiBaseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load ZenMux models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Invalid ZenMux model catalog response");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw new Error("Invalid ZenMux model catalog response");

	const models = new Map<string, Model<ZenMuxApi>>();
	for (const rawEntry of data) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
		const model = mapModel(rawEntry as JsonRecord, openAiBaseUrl, anthropicBaseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("ZenMux returned an empty model catalog");
	return [...models.values()];
}

// Model listing is unauthenticated, but request auth fails closed: resolve
// returning undefined makes Models.getAuth() reject streams with
// "Provider is not configured" even though discovery works without a key.
const zenmuxAuth: ApiKeyAuth = {
	name: "ZenMux API key",
	login: async (interaction) => {
		const key = await interaction.prompt({ type: "secret", message: "Enter ZenMux API key" });
		return { type: "api_key", key };
	},
	resolve: async ({ ctx, credential }) => {
		if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
		const value = await ctx.env("ZENMUX_API_KEY");
		if (value) return { auth: { apiKey: value }, source: "ZENMUX_API_KEY" };
		return undefined;
	},
};

export function zenmuxProvider(options: ZenmuxProviderOptions = {}): Provider<ZenMuxApi> {
	const openAiBaseUrl = normalizeOpenAiBaseUrl(options.baseUrl);
	const anthropicBaseUrl = toAnthropicBaseUrl(openAiBaseUrl);
	const staticModels = Object.values(ZENMUX_MODELS);
	return createProvider({
		id: "zenmux",
		name: "ZenMux",
		baseUrl: openAiBaseUrl,
		auth: { apiKey: zenmuxAuth },
		models: staticModels,
		fetchModels: (context) =>
			fetchModels(context, openAiBaseUrl, anthropicBaseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
