import { fetchUpdatedProviderModels } from "./updated-provider-discovery.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLINE_PASS_MODELS } from "./cline-pass.models.ts";

export function clinePassProvider(options: { baseUrl?: string; fetch?: typeof fetch } = {}): Provider<"openai-completions"> {
	const baseUrl = (options.baseUrl ?? "https://api.cline.bot/api/v1").replace(/\/+$/u, "");
	const models = Object.values(CLINE_PASS_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "cline-pass",
		name: "ClinePass",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("ClinePass API key", ["CLINE_API_KEY"]) },
		models,
		// 端点返回完整目录:成功刷新后剪除基线里已被 provider 下线的模型。
		dynamicModelsAuthoritative: true,
		fetchModels: (context) => fetchUpdatedProviderModels({ provider: "cline-pass", api: "openai-completions", baseUrl, models, context, fetch: options.fetch ?? globalThis.fetch }),
		api: openAICompletionsApi(),
	});
}
