import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { OPENCODE_ZEN_MODELS } from "./opencode-zen.models.ts";

const OPENCODE_ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

export interface OpencodeZenProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type OpenCodeZenApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

type JsonRecord = Record<string, unknown>;

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || OPENCODE_ZEN_DEFAULT_BASE_URL;
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

// Mirrors source OPENCODE_ZEN_API_RESOLUTION (openai-compat.ts): models.dev
// declares minimax-m3/minimax-m3-free with npm "@ai-sdk/anthropic", but the
// Zen gateway only serves them at /zen/v1/chat/completions (#1617).
const OPENCODE_ZEN_COMPLETIONS_OVERRIDE_IDS: Readonly<Record<string, true>> = {
	"minimax-m3": true,
	"minimax-m3-free": true,
};

const OPENCODE_ZEN_NPM_API: Readonly<Record<string, OpenCodeZenApi>> = {
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/google": "google-generative-ai",
};

function entryNpm(entry: JsonRecord): string | undefined {
	const provider = entry.provider;
	if (typeof provider === "object" && provider !== null && !Array.isArray(provider)) {
		const npm = (provider as { npm?: unknown }).npm;
		if (typeof npm === "string") return npm;
	}
	if (typeof entry.npm === "string") return entry.npm;
	return undefined;
}

function resolveOpenCodeZenApi(
	entry: JsonRecord,
	baseUrl: string,
	reference: Model<OpenCodeZenApi> | undefined,
): { api: OpenCodeZenApi; baseUrl: string } {
	const id = typeof entry.id === "string" ? entry.id : "";
	// anthropic-messages posts to the bare base path; the Anthropic client appends /v1/messages.
	const anthropicBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
	if (OPENCODE_ZEN_COMPLETIONS_OVERRIDE_IDS[id]) {
		return { api: "openai-completions", baseUrl };
	}
	const npm = entryNpm(entry);
	if (npm && OPENCODE_ZEN_NPM_API[npm]) {
		return npm === "@ai-sdk/anthropic"
			? { api: "anthropic-messages", baseUrl: anthropicBaseUrl }
			: { api: OPENCODE_ZEN_NPM_API[npm], baseUrl };
	}
	// The live /models entries are bare {id, object, created, owned_by}; the
	// bundled catalog is authoritative for api/baseUrl of known models.
	if (reference) return { api: reference.api, baseUrl: reference.baseUrl };
	return { api: "openai-completions", baseUrl };
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<OpenCodeZenApi>[],
): Model<OpenCodeZenApi> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const resolution = resolveOpenCodeZenApi(entry, baseUrl, reference);
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : reference?.name ?? id;
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "opencode-zen" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		api: resolution.api,
		baseUrl: resolution.baseUrl,
		provider: "opencode-zen",
		contextWindow: positiveNumber(entry.context_length, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<OpenCodeZenApi>[],
): Promise<readonly Model<OpenCodeZenApi>[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("OpenCode Zen API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load OpenCode Zen models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Invalid OpenCode Zen model catalog response");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw new Error("Invalid OpenCode Zen model catalog response");

	const models = new Map<string, Model<OpenCodeZenApi>>();
	for (const rawEntry of data) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
		const model = mapModel(rawEntry as JsonRecord, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("OpenCode Zen returned an empty model catalog");
	return [...models.values()];
}

export function opencodeZenProvider(options: OpencodeZenProviderOptions = {}): Provider<OpenCodeZenApi> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const staticModels = Object.values(OPENCODE_ZEN_MODELS);
	return createProvider({
		id: "opencode-zen",
		name: "OpenCode Zen",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleGenerativeAIApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
