import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { BEDROCK_MANTLE_MODELS } from "./bedrock-mantle.models.ts";

const BEDROCK_MANTLE_BASE_TEMPLATE = "https://bedrock-mantle.{region}.api.aws/openai/v1";
const BEDROCK_MANTLE_DEFAULT_REGION = "us-east-1";

export interface BedrockMantleProviderOptions {
	/** AWS region substituted into the service endpoint。默认 AWS_REGION / AWS_DEFAULT_REGION / us-east-1。 */
	region?: string;
	/** 覆盖推理 base URL(默认 {region} 模板)。 */
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRegion(options: BedrockMantleProviderOptions): string {
	const explicit = options.region?.trim();
	const ambientRegion = process.env.AWS_REGION?.trim();
	const ambientDefault = process.env.AWS_DEFAULT_REGION?.trim();
	return explicit || ambientRegion || ambientDefault || BEDROCK_MANTLE_DEFAULT_REGION;
}

function resolveBaseUrl(options: BedrockMantleProviderOptions): string {
	const region = encodeURIComponent(resolveRegion(options));
	const configured = (options.baseUrl?.trim() || BEDROCK_MANTLE_BASE_TEMPLATE).replaceAll("{region}", region);
	return configured.replace(/\/+$/u, "");
}

/** 发现端点与推理端点只差 /openai/v1 → /v1。 */
function discoveryBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/openai\/v1\/?$/u, "/v1");
}

/**
 * 仅 ambient/bearer:无交互 login,fail closed。没有 stored key 或
 * AWS_BEARER_TOKEN_BEDROCK 时视为未配置。
 */
const bedrockMantleAuth: ApiKeyAuth = {
	name: "AWS bearer token",
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env("AWS_BEARER_TOKEN_BEDROCK"));
		if (!key) return undefined;
		return {
			auth: { apiKey: key },
			source: credential?.key ? "stored credential" : "AWS_BEARER_TOKEN_BEDROCK",
		};
	},
};

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
	return {
		...(reference ?? {
			id,
			name,
			api: "openai-responses" as const,
			provider: "bedrock-mantle" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		provider: "bedrock-mantle",
		baseUrl,
		contextWindow: positiveNumber(entry.context_length ?? entry.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 4096),
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
	staticModels: readonly Model<"openai-responses">[],
): Promise<readonly Model<"openai-responses">[]> {
	const bearer = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!bearer) throw new Error("Amazon Bedrock Mantle bearer token is not configured");
	const response = await fetchImpl(`${discoveryBaseUrl(baseUrl)}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Amazon Bedrock Mantle models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid Amazon Bedrock Mantle model catalog response");
	}

	const models = new Map<string, Model<"openai-responses">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Amazon Bedrock Mantle returned an empty model catalog");
	return [...models.values()];
}

export function bedrockMantleProvider(options: BedrockMantleProviderOptions = {}): Provider<"openai-responses"> {
	const baseUrl = resolveBaseUrl(options);
	const staticModels = Object.values(BEDROCK_MANTLE_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "bedrock-mantle",
		name: "Amazon Bedrock Mantle",
		baseUrl,
		auth: { apiKey: bedrockMantleAuth },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels),
		api: openAIResponsesApi(),
	});
}
