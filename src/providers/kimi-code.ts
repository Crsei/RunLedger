import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createKimiCodeOAuth } from "../auth/oauth/kimi-code.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { KIMI_CODE_MODELS } from "./kimi-code.models.ts";

const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
// Kimi 服务端要求的固定请求头;模型级 headers 经 getAuth 合并进每次请求
const KIMI_CODE_HEADERS: Record<string, string> = {
	"User-Agent": "KimiCLI/1.0",
	"X-Msh-Platform": "kimi_cli",
};

export interface KimiCodeProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || KIMI_CODE_BASE_URL;
	return configured.replace(/\/+$/u, "");
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
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
	const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
	const reasoning = Array.isArray(entry.capabilities)
		? capabilities.includes("reasoning")
		: (reference?.reasoning ?? false);
	// 未知模型默认不支持 developer role;已知模型保留生成目录中的 compat(含 thinkingFormat "zai"),不覆盖
	const compat = reference?.compat ?? (isRecord(entry.compat) ? entry.compat : { supportsDeveloperRole: false });
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "kimi-code" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : reference?.name ?? id,
		provider: "kimi-code",
		baseUrl,
		headers: KIMI_CODE_HEADERS,
		reasoning,
		input: capabilities.includes("vision") ? ["text", "image"] : (reference?.input ?? ["text"]),
		contextWindow: positiveNumber(entry.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_tokens ?? entry.max_completion_tokens, reference?.maxTokens ?? 4096),
		compat,
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Kimi Code API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Kimi Code models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid Kimi Code model catalog response");

	const models: Model<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !seen.has(model.id)) {
			seen.add(model.id);
			models.push(model);
		}
	}
	if (models.length === 0) throw new Error("Kimi Code returned an empty model catalog");
	return models;
}

export function kimiCodeProvider(options: KimiCodeProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.KIMI_CODE_BASE_URL);
	const staticModels = Object.values(KIMI_CODE_MODELS).map((model) => ({
		...model,
		baseUrl,
		headers: KIMI_CODE_HEADERS,
	}));
	return createProvider({
		id: "kimi-code",
		name: "Kimi Code",
		baseUrl,
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kimi Code",
				loginLabel: "Sign in with Kimi",
				load: async () => createKimiCodeOAuth(),
			}),
		},
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAICompletionsApi(),
	});
}
