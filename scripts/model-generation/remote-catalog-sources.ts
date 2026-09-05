/**
 * S9 拆分:remote catalog sources(NVIDIA NIM / OpenRouter / Vercel AI Gateway)。
 *
 * 冻结快照模式不得访问网络;fetch 调用只在显式参数控制下由 generate-models 主入口触发。
 */

import type { KnownProvider, Model, ModelCost, OpenAICompletionsCompat } from "../../src/types.ts";
import { normalizeNvidiaModelId, roundCost } from "./provider-normalization.ts";

interface NvidiaNimModelListItem {
	id: string;
}

interface OpenRouterCatalogModel {
	id: string;
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
	top_provider?: { context_length?: number; max_completion_tokens?: number };
	context_length?: number;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

export const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
export async function fetchNvidiaNimModelIds(strict: boolean): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (strict) throw error;
		return new Map();
	}
}

export async function fetchOpenRouterModels(strict: boolean): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const data = await response.json() as { data: OpenRouterCatalogModel[] };

		const models: Model<any>[] = [];

		for (const model of data.data) {
			// Only include models that support tools
			if (!model.supported_parameters?.includes("tools")) continue;

			// Parse provider from model ID
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// Convert pricing from $/token to $/million tokens
			const inputCost = roundCost(parseFloat(model.pricing?.prompt || "0") * 1_000_000);
			const outputCost = roundCost(parseFloat(model.pricing?.completion || "0") * 1_000_000);
			const cacheReadCost = roundCost(parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000);
			const cacheWriteCost = roundCost(parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000);

			const contextWindow = model.top_provider?.context_length || model.context_length || 4096;

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (strict) throw error;
		return [];
	}
}

export async function fetchAiGatewayModels(strict: boolean): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json() as { data?: AiGatewayModel[] };
		const models: Model<any>[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = roundCost(toNumber(model.pricing?.input) * 1_000_000);
			const outputCost = roundCost(toNumber(model.pricing?.output) * 1_000_000);
			const cacheReadCost = roundCost(toNumber(model.pricing?.input_cache_read) * 1_000_000);
			const cacheWriteCost = roundCost(toNumber(model.pricing?.input_cache_write) * 1_000_000);

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable models from Vercel AI Gateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (strict) throw error;
		return [];
	}
}
