import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FIREPASS_MODELS } from "./firepass.models.ts";

export interface FirepassProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || "https://api.fireworks.ai/inference/v1";
	const normalized = configured.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function firepassProvider(options: FirepassProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.FIREPASS_BASE_URL);
	const staticModels = Object.values(FIREPASS_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "firepass",
		name: "Fire Pass",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Fire Pass API key", ["FIREPASS_API_KEY"]) },
		models: staticModels,
		// 静态目录:Fire Pass 的 fpk_ 前缀密钥无法调用 /models 接口,动态发现不可用。
		api: openAICompletionsApi(),
	});
}
