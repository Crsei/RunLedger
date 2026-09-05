import { fetchUpdatedProviderModels } from "./updated-provider-discovery.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPINFRA_MODELS } from "./deepinfra.models.ts";

export function deepinfraProvider(options: { baseUrl?: string; fetch?: typeof fetch } = {}): Provider<"openai-completions"> {
	const baseUrl = (options.baseUrl ?? "https://api.deepinfra.com/v1/openai").replace(/\/+$/u, "");
	const models = Object.values(DEEPINFRA_MODELS).map((model) => ({ ...model, baseUrl }));
	return createProvider({
		id: "deepinfra",
		name: "DeepInfra",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("DeepInfra API key", ["DEEPINFRA_API_KEY"]) },
		models,
		fetchModels: (context) => fetchUpdatedProviderModels({ provider: "deepinfra", api: "openai-completions", baseUrl, models, context, fetch: options.fetch ?? globalThis.fetch }),
		api: openAICompletionsApi(),
	});
}
