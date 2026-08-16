import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { defaultProviderAuthContext } from "../auth/context.ts";
import type { ApiKeyAuth, AuthContext } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import type { ProviderEnv } from "../types.ts";
import { COREWEAVE_MODELS } from "./coreweave.models.ts";

export const COREWEAVE_PROJECT_HEADER = "OpenAI-Project" as const;

export interface CoreweaveProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** 注入的环境读取器;默认读取 process.env。测试可传 fake AuthContext。 */
	authContext?: AuthContext;
}

type JsonRecord = Record<string, unknown>;

interface CoreWeaveEnv {
	COREWEAVE_PROJECT?: string;
	WANDB_INFERENCE_PROJECT?: string;
	WANDB_ENTITY?: string;
	WANDB_PROJECT?: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://api.inference.wandb.ai/v1";
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function mapCost(entry: JsonRecord): ModelCost {
	const currency = typeof entry.currency === "string" ? entry.currency.toLowerCase() : "usd";
	if (currency !== "usd") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		input: nonNegativeNumber(entry.input_per_1m),
		output: nonNegativeNumber(entry.output_per_1m),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function modelName(entry: JsonRecord, fallback: string): string {
	for (const candidate of [entry.description, entry.name]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return fallback;
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
	const reasoning = capabilities.includes("reasoning") || (reference?.reasoning ?? false);
	const hasWireCost =
		typeof entry.currency === "string" || entry.input_per_1m !== undefined || entry.output_per_1m !== undefined;
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "coreweave" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		name: modelName(entry, reference?.name ?? id),
		provider: "coreweave",
		baseUrl,
		reasoning,
		input: capabilities.includes("vision") || entry.supports_vision === true
			? (["text", "image"] as const)
			: (reference?.input ?? ["text"]),
		...(hasWireCost ? { cost: mapCost(entry) } : {}),
		contextWindow: positiveNumber(entry.context_window, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_tokens ?? entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/** 与上游 wire/coreweave.ts 一致的 project 解析:显式变量优先,其次 WANDB_PROJECT(+ENTITY 前缀)。 */
function resolveProjectFromEnv(env: CoreWeaveEnv): string | undefined {
	const explicitProject = env.COREWEAVE_PROJECT?.trim() || env.WANDB_INFERENCE_PROJECT?.trim();
	if (explicitProject) return explicitProject;

	const wandbProject = env.WANDB_PROJECT?.trim();
	if (!wandbProject) return undefined;
	if (wandbProject.includes("/")) return wandbProject;

	const wandbEntity = env.WANDB_ENTITY?.trim();
	return wandbEntity ? `${wandbEntity}/${wandbProject}` : undefined;
}

async function resolveProject(
	credentialEnv: ProviderEnv | undefined,
	authCtx: AuthContext,
): Promise<string | undefined> {
	return resolveProjectFromEnv({
		COREWEAVE_PROJECT: credentialEnv?.COREWEAVE_PROJECT ?? (await authCtx.env("COREWEAVE_PROJECT")),
		WANDB_INFERENCE_PROJECT:
			credentialEnv?.WANDB_INFERENCE_PROJECT ?? (await authCtx.env("WANDB_INFERENCE_PROJECT")),
		WANDB_ENTITY: credentialEnv?.WANDB_ENTITY ?? (await authCtx.env("WANDB_ENTITY")),
		WANDB_PROJECT: credentialEnv?.WANDB_PROJECT ?? (await authCtx.env("WANDB_PROJECT")),
	});
}

/**
 * CoreWeave 密钥与 project 缺一不可(fail closed):stream 必须带
 * OpenAI-Project 头,project 无法解析时不产生任何 auth。
 */
const coreweaveAuth: ApiKeyAuth = {
	name: "CoreWeave Serverless Inference API key",
	resolve: async ({ ctx, credential }) => {
		const project = await resolveProject(credential?.env, ctx);
		let key: string | undefined;
		let source: string | undefined;
		if (credential?.key) {
			key = credential.key;
			source = "stored credential";
		} else {
			key = (await ctx.env("COREWEAVE_API_KEY")) ?? undefined;
			source = key ? "COREWEAVE_API_KEY" : undefined;
			if (!key) {
				key = (await ctx.env("WANDB_API_KEY")) ?? undefined;
				source = key ? "WANDB_API_KEY" : undefined;
			}
		}
		if (!key || !project) return undefined;
		return {
			auth: { apiKey: key, headers: { [COREWEAVE_PROJECT_HEADER]: project } },
			env: { COREWEAVE_PROJECT: project },
			source,
		};
	},
};

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
	authCtx: AuthContext,
): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const credentialEnv = context.credential?.type === "api_key" ? context.credential.env : undefined;
	const project = await resolveProject(credentialEnv, authCtx);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	if (project) headers[COREWEAVE_PROJECT_HEADER] = project;

	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers,
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(
			`Could not load CoreWeave Serverless Inference models: ${response.status}: ${truncateBody(await response.text())}`,
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid CoreWeave Serverless Inference model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("CoreWeave Serverless Inference returned an empty model catalog");
	return [...models.values()];
}

export function coreweaveProvider(options: CoreweaveProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.COREWEAVE_BASE_URL);
	const authCtx = options.authContext ?? defaultProviderAuthContext();
	const staticModels = Object.values(COREWEAVE_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "coreweave",
		name: "CoreWeave Serverless Inference",
		baseUrl,
		auth: { apiKey: coreweaveAuth },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, options.fetch ?? globalThis.fetch, staticModels, authCtx),
		api: openAICompletionsApi(),
	});
}
