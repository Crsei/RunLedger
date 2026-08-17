import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { SAKANA_MODELS } from "./sakana.models.ts";

const SAKANA_DEFAULT_BASE_URL = "https://api.sakana.ai/v1";

// 动态发现的新 fugu 模型沿用静态 catalog 的 reasoning 行为
const SAKANA_FUGU_MODEL_ID_PATTERN = /^fugu(?:$|-)/iu;

export interface SakanaProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || SAKANA_DEFAULT_BASE_URL;
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-responses">[],
): Model<"openai-responses"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : (reference?.name ?? id);
	const model = {
		...(reference ?? {
			id,
			name,
			api: "openai-responses" as const,
			provider: "sakana" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		provider: "sakana",
		baseUrl,
		contextWindow: positiveNumber(entry.context_length ?? entry.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
	return !reference && SAKANA_FUGU_MODEL_ID_PATTERN.test(id) ? { ...model, reasoning: true } : model;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-responses">[],
): Promise<readonly Model<"openai-responses">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Sakana AI API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Sakana AI models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid Sakana AI model catalog response");

	const models = new Map<string, Model<"openai-responses">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Sakana AI returned an empty model catalog");
	return [...models.values()];
}

export function sakanaProvider(options: SakanaProviderOptions = {}): Provider<"openai-responses"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.SAKANA_BASE_URL ?? process.env.FUGU_BASE_URL);
	const staticModels = Object.values(SAKANA_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "sakana",
		name: "Sakana AI",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Sakana AI API key", ["SAKANA_API_KEY", "FUGU_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAIResponsesApi(),
	});
}
