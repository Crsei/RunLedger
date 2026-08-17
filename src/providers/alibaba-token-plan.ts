import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth, AuthContext, ModelAuth } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { ALIBABA_TOKEN_PLAN_MODELS } from "./alibaba-token-plan.models.ts";

const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const ALIBABA_TOKEN_PLAN_BASE_URL_ENV = "ALIBABA_TOKEN_PLAN_BASE_URL";
const ALIBABA_TOKEN_PLAN_ENV_VARS = ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"] as const;

export interface AlibabaTokenPlanProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
	const configured = value?.trim();
	if (!configured) return undefined;
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function modelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

interface TokenPlanCredential {
	token: string;
	baseUrl?: string;
}

// 凭证可以是裸 token,也可以是 JSON:{"token","cookie"?,"baseUrl"?}。
// cookie 仅用于源码侧配额展示,不参与请求鉴权。
function parseTokenPlanKey(value: string): TokenPlanCredential {
	const raw = value.trim();
	if (!raw.startsWith("{")) return { token: raw };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed) && typeof parsed.token === "string" && parsed.token.trim()) {
			return {
				token: parsed.token.trim(),
				...(typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
					? { baseUrl: parsed.baseUrl.trim() }
					: {}),
			};
		}
	} catch {
		// 非法 JSON 按裸 token 处理
	}
	return { token: raw };
}

async function firstEnv(
	ctx: AuthContext,
	names: readonly string[],
): Promise<{ name: string; value: string } | undefined> {
	for (const name of names) {
		const value = await ctx.env(name);
		if (value) return { name, value };
	}
	return undefined;
}

const alibabaTokenPlanAuth: ApiKeyAuth = {
	name: "QwenCloud Token Plan token",
	login: async (interaction) => {
		const key = await interaction.prompt({
			type: "secret",
			message: "Enter QwenCloud Token Plan token (bare token or JSON {\"token\": ..., \"cookie\"?, \"baseUrl\"?})",
		});
		return { type: "api_key", key };
	},
	resolve: async ({ ctx, credential }) => {
		const ambient = credential?.key ? undefined : await firstEnv(ctx, ALIBABA_TOKEN_PLAN_ENV_VARS);
		const rawKey = credential?.key ?? ambient?.value;
		if (!rawKey) return undefined;
		const parsed = parseTokenPlanKey(rawKey);
		// 区域锁定的 key 只认自己的端点:解析出的 baseUrl 优先,其次环境变量,最后保持静态 baseUrl
		const baseUrl = normalizeBaseUrl(parsed.baseUrl ?? (await ctx.env(ALIBABA_TOKEN_PLAN_BASE_URL_ENV)));
		const auth: ModelAuth = { apiKey: parsed.token };
		if (baseUrl) auth.baseUrl = baseUrl;
		return { auth, source: ambient?.name ?? "stored credential" };
	},
};

// 与源码一致:过滤非对话模型(ASR/图像/音频/视频生成/向量)
const ALIBABA_TOKEN_PLAN_NON_CHAT_PREFIXES = [
	"fun-asr",
	"happyhorse-",
	"qwen-audio-",
	"qwen-image-",
	"text-embedding-",
	"wan2.7-",
] as const;

function isChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	return (
		normalized.length > 0 &&
		!ALIBABA_TOKEN_PLAN_NON_CHAT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
	);
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id || !isChatModelId(id)) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const name = modelName(entry.name, reference?.name ?? id);
	if (!reference) {
		return {
			id,
			name,
			api: "openai-completions" as const,
			provider: "alibaba-token-plan" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		};
	}
	return {
		...reference,
		id,
		name,
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl,
		contextWindow: positiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	fetchImpl: typeof fetch,
	envBaseUrl: string | undefined,
	defaultBaseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const rawKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const parsedCredential = rawKey ? parseTokenPlanKey(rawKey) : undefined;
	if (!parsedCredential?.token) throw new Error("QwenCloud Token Plan token is not configured");
	// 与 auth.resolve 同优先级:解析 baseUrl > env 覆盖 > 静态默认端点
	const baseUrl = normalizeBaseUrl(parsedCredential.baseUrl ?? envBaseUrl) ?? defaultBaseUrl;
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: `Bearer ${parsedCredential.token}` },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(
			`Could not load QwenCloud Token Plan models: ${response.status}: ${truncateBody(await response.text())}`,
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid QwenCloud Token Plan model catalog response");
	}

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of payload.data) {
		if (!isRecord(rawEntry)) continue;
		const model = mapModel(rawEntry, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("QwenCloud Token Plan returned an empty model catalog");
	return [...models.values()];
}

export function alibabaTokenPlanProvider(
	options: AlibabaTokenPlanProviderOptions = {},
): Provider<"openai-completions"> {
	const envBaseUrl = process.env[ALIBABA_TOKEN_PLAN_BASE_URL_ENV] || undefined;
	const defaultBaseUrl = normalizeBaseUrl(options.baseUrl ?? envBaseUrl) ?? ALIBABA_TOKEN_PLAN_BASE_URL;
	const staticModels = Object.values(ALIBABA_TOKEN_PLAN_MODELS).map((model) => ({ ...model, baseUrl: defaultBaseUrl }));
	return createProvider({
		id: "alibaba-token-plan",
		name: "QwenCloud Token Plan",
		baseUrl: defaultBaseUrl,
		auth: { apiKey: alibabaTokenPlanAuth },
		models: staticModels,
		fetchModels: (context) =>
			fetchModels(context, options.fetch ?? globalThis.fetch, envBaseUrl, defaultBaseUrl, staticModels),
		api: openAICompletionsApi(),
	});
}
