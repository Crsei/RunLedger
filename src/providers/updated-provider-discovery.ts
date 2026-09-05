import { clinePassHeaders } from "../api/cline-pass-headers.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

type UpdatedProvider = "abliteration" | "cline-pass" | "deepinfra" | "yolo-auto";
type DiscoveryApi = "openai-completions" | "openai-responses";
type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function rate(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 四个新 provider 共用请求生命周期；各自的目录格式与计费语义单独处理。 */
export async function fetchUpdatedProviderModels<TApi extends DiscoveryApi>(options: {
	provider: UpdatedProvider;
	api: TApi;
	baseUrl: string;
	models: readonly Model<TApi>[];
	context: RefreshModelsContext;
	fetch: typeof fetch;
}): Promise<readonly Model<TApi>[]> {
	const { provider, api, baseUrl, models, context } = options;
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!key && (provider === "abliteration" || provider === "yolo-auto")) {
		throw new Error(`${provider} API key is not configured`);
	}
	const path = provider === "cline-pass" ? "/ai/cline/recommended-models"
		: provider === "deepinfra" ? "/models?filter=with_meta&sort_by=omp" : "/models";
	const timeout = AbortSignal.timeout(5000);
	const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
	const response = await options.fetch(`${baseUrl}${path}`, {
		method: "GET", signal,
		headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(provider === "cline-pass" ? clinePassHeaders() : {}) },
	});
	if (!response.ok) throw new Error(`${provider} model discovery failed: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	const entries = record(payload) ? payload[provider === "cline-pass" ? "clinePass" : "data"] : undefined;
	if (!Array.isArray(entries)) throw new Error(`Invalid ${provider} model catalog`);
	const references = new Map(models.map((model) => [model.id, model]));
	const result = new Map<string, Model<TApi>>();

	function add(entry: unknown, free = false): void {
		if (!record(entry) || typeof entry.id !== "string") return;
		let id = entry.id.trim();
		if (provider === "cline-pass") {
			if (free ? id.startsWith("cline-pass/") : !id.startsWith("cline-pass/")) return;
			if (!free) id = id.slice("cline-pass/".length).trim();
		}
		if (!id || result.has(id)) return;
		const reference = references.get(id);
		const metadata = record(entry.metadata) ? entry.metadata : {};
		const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
		if (provider === "deepinfra" && !tags.includes("chat")) return;
		const model: Model<TApi> = {
			id, name: id, api, provider, baseUrl, reasoning: provider === "abliteration",
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 8192, ...reference,
		};
		model.contextWindow = positive(entry.context_length ?? entry.context_window, model.contextWindow);
		model.maxTokens = positive(entry.max_completion_tokens, model.maxTokens);
		if (provider === "deepinfra") {
			const pricing = record(metadata.pricing) ? metadata.pricing : {};
			model.reasoning = tags.includes("reasoning") || tags.includes("reasoning_effort");
			model.input = tags.includes("vision") || tags.includes("vlm") ? ["text", "image"] : ["text"];
			model.cost = { input: rate(pricing.input_tokens), output: rate(pricing.output_tokens), cacheRead: rate(pricing.cache_read_tokens), cacheWrite: 0 };
			model.contextWindow = positive(metadata.context_length, model.contextWindow);
			const output = positive(metadata.max_tokens, 0);
			// 上游 max_tokens 常与 context 相同，不能把总容量当作输出上限。
			model.maxTokens = output > 0 && output < model.contextWindow ? output : Math.min(model.maxTokens, model.contextWindow);
		}
		if (provider === "abliteration") {
			const responses = model as Model<"openai-responses">;
			responses.compat = { ...responses.compat, supportsDeveloperRole: false, supportsLongCacheRetention: false, includeEncryptedReasoning: false };
		}
		if (provider === "yolo-auto") {
			const completions = model as Model<"openai-completions">;
			completions.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			completions.compat = { ...completions.compat, supportsStore: false, supportsDeveloperRole: false };
		}
		if (provider === "cline-pass") {
			const completions = model as Model<"openai-completions">;
			completions.compat = { ...completions.compat, supportsDeveloperRole: false,
				wireModelId: free ? id : `cline-pass/${id}`, ...(free ? { supportsReasoningEffort: false } : {}) };
			if (free) completions.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		}
		result.set(id, model);
	}
	for (const entry of entries) add(entry);
	if (result.size === 0) throw new Error(`${provider} returned an empty model catalog`);
	if (provider === "cline-pass" && record(payload) && Array.isArray(payload.free)) {
		for (const entry of payload.free) add(entry, true);
	}
	return [...result.values()];
}
