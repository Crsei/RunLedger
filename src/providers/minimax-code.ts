import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CODE_MODELS } from "./minimax-code.models.ts";

// 源码仅提供静态描述符(minimax-coding-plan),没有 /v1/models 运行时发现配置,故仅静态。
export function minimaxCodeProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "minimax-code",
		name: "MiniMax Token Plan (International)",
		baseUrl: "https://api.minimax.io/v1",
		auth: { apiKey: envApiKeyAuth("MiniMax Token Plan API key", ["MINIMAX_CODE_API_KEY"]) },
		models: Object.values(MINIMAX_CODE_MODELS),
		api: openAICompletionsApi(),
	});
}
