import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CODE_CN_MODELS } from "./minimax-code-cn.models.ts";

// 源码仅提供静态描述符(minimax-cn-coding-plan),没有 /v1/models 运行时发现配置,故仅静态。
export function minimaxCodeCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "minimax-code-cn",
		name: "MiniMax Token Plan (China)",
		baseUrl: "https://api.minimaxi.com/v1",
		auth: { apiKey: envApiKeyAuth("MiniMax Token Plan China API key", ["MINIMAX_CODE_CN_API_KEY"]) },
		models: Object.values(MINIMAX_CODE_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
