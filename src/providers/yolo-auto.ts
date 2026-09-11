import { fetchUpdatedProviderModels } from "./updated-provider-discovery.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { YOLO_AUTO_MODELS } from "./yolo-auto.models.ts";

export function yoloAutoProvider(options: { baseUrl?: string; fetch?: typeof fetch } = {}): Provider<"openai-completions"> {
	const baseUrl = (options.baseUrl ?? "https://yolo-auto.com/v1").replace(/\/+$/u, "");
	const models = Object.values(YOLO_AUTO_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "yolo-auto",
		name: "Yolo-Auto",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Yolo-Auto API key", ["YOLO_AUTO_API_KEY"]) },
		models,
		// 端点返回完整目录:成功刷新后剪除基线里已被 provider 下线的模型。
		dynamicModelsAuthoritative: true,
		fetchModels: (context) => fetchUpdatedProviderModels({ provider: "yolo-auto", api: "openai-completions", baseUrl, models, context, fetch: options.fetch ?? globalThis.fetch }),
		api: openAICompletionsApi(),
	});
}
