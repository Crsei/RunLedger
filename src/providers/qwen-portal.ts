import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { QWEN_PORTAL_MODELS } from "./qwen-portal.models.ts";

const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";

export interface QwenPortalProviderOptions {
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

function modelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const name = modelName(entry.name, reference?.name ?? id);
	if (!reference) {
		return {
			id,
			name,
			api: "openai-completions" as const,
			provider: "qwen-portal" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		};
	}
	return {
		...reference,
		id,
		name,
		api: "openai-completions",
		provider: "qwen-portal",
		baseUrl,
		contextWindow: positiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	fetchImpl: typeof fetch,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Qwen Portal token is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Qwen Portal models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid Qwen Portal model catalog response");

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Qwen Portal returned an empty model catalog");
	return [...models.values()];
}

export function qwenPortalProvider(options: QwenPortalProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl) ?? QWEN_PORTAL_BASE_URL;
	const staticModels = Object.values(QWEN_PORTAL_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "qwen-portal",
		name: "Qwen Portal",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Qwen Portal token", ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, options.fetch ?? globalThis.fetch, baseUrl, staticModels),
		api: openAICompletionsApi(),
	});
}
