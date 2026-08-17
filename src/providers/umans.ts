import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, ThinkingLevelMap } from "../types.ts";
import { UMANS_MODELS } from "./umans.models.ts";

const UMANS_DEFAULT_BASE_URL = "https://api.code.umans.ai";
const UMANS_MODELS_INFO_PATH = "/models/info";
const UMANS_REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const UMANS_DEFAULT_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export interface UmansProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 请求/静态模型用 anthropic 根;发现端点另加 /v1。 */
function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || UMANS_DEFAULT_BASE_URL;
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function modelName(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function umansReasoningSupported(value: unknown): boolean {
	return isRecord(value) ? value.supported === true : value === true;
}

/** reasoning.levels → thinkingLevelMap;can_disable:false 时 off 不可用。 */
function mapThinkingLevels(value: unknown): ThinkingLevelMap | undefined {
	if (!umansReasoningSupported(value)) return undefined;
	const levels = isRecord(value) && Array.isArray(value.levels) ? value.levels : [];
	const mapped: ThinkingLevelMap = {
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	let found = false;
	for (const level of levels) {
		if (typeof level !== "string" || !UMANS_REASONING_LEVELS.has(level)) continue;
		mapped[level as keyof ThinkingLevelMap] = level;
		found = true;
	}
	if (!found) {
		// 无 levels 时沿用源默认 minimal..xhigh
		for (const level of UMANS_DEFAULT_REASONING_LEVELS) {
			mapped[level] = level;
		}
	}
	if (isRecord(value) && value.can_disable === false) mapped.off = null;
	return mapped;
}

function mapUmansModelInfo(
	modelId: string,
	raw: JsonRecord,
	baseUrl: string,
	reference: Model<"anthropic-messages"> | undefined,
): Model<"anthropic-messages"> | undefined {
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const reasoning = umansReasoningSupported(capabilities.reasoning);
	const thinkingLevelMap = mapThinkingLevels(capabilities.reasoning);
	return {
		...(reference ?? {
			id: modelId,
			name: modelId,
			api: "anthropic-messages" as const,
			provider: "umans" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id: modelId,
		name: modelName(raw.display_name, modelName(raw.name, modelId)),
		provider: "umans",
		baseUrl,
		reasoning,
		thinkingLevelMap,
		// 仅 supports_vision === true 表示原生图像输入;哨兵值(如 "via-handoff")映射为纯文本
		input: capabilities.supports_vision === true ? ["text", "image"] : ["text"],
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveNumber(capabilities.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(
			capabilities.recommended_max_tokens,
			positiveNumber(capabilities.max_completion_tokens, reference?.maxTokens ?? 4096),
		),
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
	staticModels: readonly Model<"anthropic-messages">[],
): Promise<readonly Model<"anthropic-messages">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) throw new Error("Umans AI Coding Plan API key is not configured");
	const discoveryBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
	const response = await fetchImpl(`${discoveryBaseUrl}${UMANS_MODELS_INFO_PATH}`, {
		method: "GET",
		headers: { Accept: "application/json", "x-api-key": apiKey },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Umans models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload)) throw new Error("Invalid Umans model catalog response");

	// models/info 返回以 model id 为 key 的对象
	const models = new Map<string, Model<"anthropic-messages">>();
	for (const [modelId, rawEntry] of Object.entries(payload)) {
		if (!isRecord(rawEntry)) continue;
		const model = mapUmansModelInfo(
			modelId,
			rawEntry,
			baseUrl,
			staticModels.find((entry) => entry.id === modelId),
		);
		if (model) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Umans returned an empty model catalog");
	return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function umansProvider(options: UmansProviderOptions = {}): Provider<"anthropic-messages"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const staticModels = Object.values(UMANS_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "umans",
		name: "Umans AI Coding Plan",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Umans AI Coding Plan API key", ["UMANS_AI_CODING_PLAN_API_KEY"]) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: anthropicMessagesApi(),
	});
}
