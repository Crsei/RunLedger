import { fetchUpdatedProviderModels } from "./updated-provider-discovery.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ABLITERATION_MODELS } from "./abliteration.models.ts";

export function abliterationProvider(options: { baseUrl?: string; fetch?: typeof fetch } = {}): Provider<"openai-responses"> {
	const baseUrl = (options.baseUrl ?? "https://api.abliteration.ai/v1").replace(/\/+$/u, "");
	const models = Object.values(ABLITERATION_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "abliteration",
		name: "Abliteration",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Abliteration API key", ["ABLITERATION_API_KEY", "ABLIT_KEY"]) },
		models,
		// 端点返回完整目录:成功刷新后剪除基线里已被 provider 下线的模型。
		dynamicModelsAuthoritative: true,
		fetchModels: (context) => fetchUpdatedProviderModels({ provider: "abliteration", api: "openai-responses", baseUrl, models, context, fetch: options.fetch ?? globalThis.fetch }),
		api: openAIResponsesApi(),
	});
}
