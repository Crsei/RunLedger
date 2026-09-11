import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type {
	Model,
	OpenAICompletionsCompat,
	ProviderHeaders,
	ProviderStreams,
	StreamOptions,
} from "../types.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";

const OPENCODE_GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

export interface OpencodeGoProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type OpenCodeGoApi = "anthropic-messages" | "openai-completions" | "openai-responses";

type JsonRecord = Record<string, unknown>;

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || OPENCODE_GO_DEFAULT_BASE_URL;
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

/**
 * Go 端点以 models.dev 的 npm 声明决定 wire;与生成器 models-dev-source 的映射一致,
 * 不含 @ai-sdk/google(Go provider 未装配 Google API)。
 */
const OPENCODE_GO_NPM_API: Readonly<Record<string, OpenCodeGoApi>> = {
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/openai-compatible": "openai-completions",
	"@ai-sdk/alibaba": "openai-completions",
};

/**
 * 生成器对 Go 端点的已验证修正:这些模型由 /v1/chat/completions 提供,
 * 不接受 Anthropic SDK 认证(models.dev 的 npm 声明在此不可信)。
 */
const OPENCODE_GO_COMPLETIONS_OVERRIDE_IDS: Readonly<Record<string, true>> = {
	"minimax-m2.7": true,
	"qwen3.5-plus": true,
	"qwen3.6-plus": true,
};

/** Go 端点已验证的 completions 兼容参数(与生成器 compat 规则一致)。 */
function completionsCompat(id: string): OpenAICompletionsCompat {
	const compat: OpenAICompletionsCompat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" };
	if (id === "qwen3.5-plus" || id === "qwen3.6-plus") return { ...compat, thinkingFormat: "qwen" };
	// Kimi K2.6 接受 Anthropic 风格 thinking 对象,拒绝字符串 thinking 与 reasoning_effort。
	if (id === "kimi-k2.6") return { ...compat, thinkingFormat: "deepseek", supportsReasoningEffort: false };
	return compat;
}

function entryNpm(entry: JsonRecord): string | undefined {
	const provider = entry.provider;
	if (typeof provider === "object" && provider !== null && !Array.isArray(provider)) {
		const npm = (provider as { npm?: unknown }).npm;
		if (typeof npm === "string") return npm;
	}
	if (typeof entry.npm === "string") return entry.npm;
	return undefined;
}

/**
 * /models 的条目是裸 `{id, object, created, owned_by}`,不含 api 元数据;
 * 已审核的 bundled catalog 对已知 id 是权威(它带有端点实测过的 api/baseUrl/compat)。
 */
function resolveApi(entry: JsonRecord, reference: Model<OpenCodeGoApi> | undefined): OpenCodeGoApi {
	const id = typeof entry.id === "string" ? entry.id : "";
	if (reference) return reference.api;
	if (OPENCODE_GO_COMPLETIONS_OVERRIDE_IDS[id]) return "openai-completions";
	const npm = entryNpm(entry);
	return (npm && OPENCODE_GO_NPM_API[npm]) || "openai-completions";
}

function mapDiscoveredModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<OpenCodeGoApi>[],
): Model<OpenCodeGoApi> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const api = resolveApi(entry, reference);
	// anthropic-messages 提交到裸 base path;Anthropic 客户端自行追加 /v1/messages。
	const anthropicBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
	const modelBaseUrl = reference?.baseUrl ?? (api === "anthropic-messages" ? anthropicBaseUrl : baseUrl);
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : reference?.name ?? id;
	if (reference) return { ...reference, id, name, provider: "opencode-go" };
	// /models 不返回模型能力;endpoint 已提供、但已审核 catalog 与 models.dev 都没有的
	// 新模型只能用保守默认(与其它动态 provider 的 discovery 约定一致),选中后由
	// provider 侧真实限制决定成败,不在这里臆测更大的窗口。
	const metadata = {
		id,
		name,
		provider: "opencode-go" as const,
		baseUrl: modelBaseUrl,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveNumber(entry.context_length, 128_000),
		maxTokens: positiveNumber(entry.max_completion_tokens, 8_192),
	};
	if (api === "openai-completions") {
		const model: Model<"openai-completions"> = { ...metadata, api: "openai-completions", compat: completionsCompat(id) };
		return model;
	}
	if (api === "anthropic-messages") {
		const model: Model<"anthropic-messages"> = { ...metadata, api: "anthropic-messages" };
		return model;
	}
	const model: Model<"openai-responses"> = { ...metadata, api: "openai-responses" };
	return model;
}

/** /models 是官方文档公布的完整列表来源;失败时 createProvider 保留上次成功结果。 */
async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<OpenCodeGoApi>[],
): Promise<readonly Model<OpenCodeGoApi>[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("OpenCode Go API key is not configured");
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load OpenCode Go models: ${response.status}: ${truncateBody(await response.text())}`);
	}
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Invalid OpenCode Go model catalog response");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw new Error("Invalid OpenCode Go model catalog response");
	const models = new Map<string, Model<OpenCodeGoApi>>();
	for (const rawEntry of data) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
		const model = mapDiscoveredModel(rawEntry as JsonRecord, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("OpenCode Go returned an empty model catalog");
	return [...models.values()];
}

export function opencodeGoProvider(options: OpencodeGoProviderOptions = {}): Provider<OpenCodeGoApi> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const models = Object.values(OPENCODE_GO_MODELS);
	return createProvider<OpenCodeGoApi>({
		id: "opencode-go",
		name: "OpenCode Zen Go",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models,
		// 端点返回完整目录:成功刷新后剪除基线里已被 provider 下线的模型。
		dynamicModelsAuthoritative: true,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, models),
		api: {
			"anthropic-messages": withGoHeaders(anthropicMessagesApi()),
			"openai-completions": withGoHeaders(openAICompletionsApi()),
			"openai-responses": withGoHeaders(openAIResponsesApi()),
		},
	});
}

/** Go 的路由标识独立于缓存开关，统一覆盖三种 API。 */
function withGoHeaders(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) => streams.stream(model, context, { ...options, headers: requestHeaders(options) }),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, headers: requestHeaders(options) }),
	};
}

function requestHeaders(options?: StreamOptions): ProviderHeaders {
	const headers: ProviderHeaders = { ...options?.headers };
	const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
	if (!names.has("user-agent")) headers["User-Agent"] = "RunLedger";
	if (options?.sessionId && !names.has("x-opencode-session")) headers["x-opencode-session"] = options.sessionId;
	return headers;
}
