import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type {
	Model,
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

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/** 路由目录只能收窄已审核的套餐清单,不据裸 ID 猜测可用性或模型能力。 */
function mapDiscoveredModel(
	entry: JsonRecord,
	staticModels: readonly Model<OpenCodeGoApi>[],
): Model<OpenCodeGoApi> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	const reference = staticModels.find((model) => model.id === id);
	if (!reference) return undefined;
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : reference.name;
	return { ...reference, name };
}

/** /models 是较宽的路由目录；与套餐取交集,失败保留上次成功结果。 */
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
		const model = mapDiscoveredModel(rawEntry as JsonRecord, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("OpenCode Go returned an empty model catalog");
	return [...models.values()];
}

export function opencodeGoProvider(options: OpencodeGoProviderOptions = {}): Provider<OpenCodeGoApi> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const models = Object.values(OPENCODE_GO_MODELS);
	const provider = createProvider<OpenCodeGoApi>({
		id: "opencode-go",
		name: "OpenCode Zen Go",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models,
		// 已过滤的路由目录可剪除基线缺失项,不可扩展套餐范围。
		dynamicModelsAuthoritative: true,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, models),
		api: {
			"anthropic-messages": withGoHeaders(anthropicMessagesApi()),
			"openai-completions": withGoHeaders(openAICompletionsApi()),
			"openai-responses": withGoHeaders(openAIResponsesApi()),
		},
	});
	const included = new Set<string>(models.map((model) => model.id));
	return {
		...provider,
		// 旧进程留下的缓存可能有 37 个路由 ID,离线恢复同样不能让套餐外模型复活。
		getModels: () => provider.getModels().filter((model) => included.has(model.id)),
	};
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
