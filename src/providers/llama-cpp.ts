import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

/**
 * llama.cpp (Local OpenAI-compatible)。registry-only provider 移植决策见
 * 02-oh-my-pi-provider-port-execution-checklist.md §P5:与 litellm / lm-studio /
 * vllm 同构 —— optional key(sentinel)+ base URL env + 纯动态 /models,无静态
 * bundled catalog(同 radius 先例,不进入 models.generated.ts)。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
/** 无 key 的本地服务哨兵 key(来源 emptyKeyFallback 约定;目标 openai adapter 需要非空 apiKey)。 */
const DEFAULT_LOCAL_TOKEN = "llama-cpp-local";

export interface LlamaCppProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || DEFAULT_BASE_URL;
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

const llamaCppAuth: ApiKeyAuth = {
	name: "llama.cpp API key (optional)",
	login: async (interaction) => {
		const key = await interaction.prompt({
			type: "secret",
			message: "Paste your llama.cpp API key if your server requires auth (empty for local no-auth)",
			placeholder: DEFAULT_LOCAL_TOKEN,
		});
		return { type: "api_key", key: key.trim() || undefined };
	},
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env("LLAMA_CPP_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "LLAMA_CPP_API_KEY" };
		// 本地无认证模式:哨兵 key,允许无 key 可用(与“未配置 endpoint”不同,
		// 未配置 endpoint 由 factory baseUrl 明确给出默认本地地址)。
		return { auth: { apiKey: DEFAULT_LOCAL_TOKEN }, source: "local no-auth" };
	},
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<readonly Model<"openai-completions">[]> {
	// 无网络能力(offline 初始化)时由 createProvider 的 store 恢复,不进网络。
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: {
			Accept: "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load llama.cpp models: ${response.status}: ${truncateBody(await response.text())}`);
	}
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid llama.cpp model catalog response");
	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const id = typeof rawEntry.id === "string" ? rawEntry.id.trim() : "";
		if (!id || models.has(id)) continue;
		const contextWindow = positiveNumber(rawEntry.context_window, 4096);
		models.set(id, {
			id,
			name: typeof rawEntry.name === "string" && rawEntry.name.trim() ? rawEntry.name.trim() : id,
			api: "openai-completions",
			provider: "llama.cpp",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: positiveNumber(rawEntry.max_tokens, Math.min(contextWindow, 65_536)),
		});
	}
	if (models.size === 0) throw new Error("llama.cpp returned an empty model catalog");
	return [...models.values()];
}

export function llamaCppProvider(options: LlamaCppProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLAMA_CPP_BASE_URL);
	return createProvider({
		id: "llama.cpp",
		name: "llama.cpp (Local OpenAI-compatible)",
		baseUrl,
		auth: { apiKey: llamaCppAuth },
		// 纯动态 provider:无静态 baseline,首次 discovery 前列表为空(与来源一致)。
		models: [],
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch),
		api: openAICompletionsApi(),
	});
}
