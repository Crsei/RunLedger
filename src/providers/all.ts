import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { aiandProvider } from "./aiand.ts";
import { aimlapiProvider } from "./aimlapi.ts";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.ts";
import { alibabaTokenPlanProvider } from "./alibaba-token-plan.ts";
import { basetenProvider } from "./baseten.ts";
import { bedrockMantleProvider } from "./bedrock-mantle.ts";
import { coreweaveProvider } from "./coreweave.ts";
import { firepassProvider } from "./firepass.ts";
import { gmiCloudProvider } from "./gmi-cloud.ts";
import { llamaCppProvider } from "./llama-cpp.ts";
import { kiloProvider } from "./kilo.ts";
import { kimiCodeProvider } from "./kimi-code.ts";
import { litellmProvider } from "./litellm.ts";
import { lmStudioProvider } from "./lm-studio.ts";
import { metaProvider } from "./meta.ts";
import { minimaxCodeProvider } from "./minimax-code.ts";
import { minimaxCodeCnProvider } from "./minimax-code-cn.ts";
import { nanogptProvider } from "./nanogpt.ts";
import { novitaProvider } from "./novita.ts";
import { opencodeZenProvider } from "./opencode-zen.ts";
import { qianfanProvider } from "./qianfan.ts";
import { qwenPortalProvider } from "./qwen-portal.ts";
import { sakanaProvider } from "./sakana.ts";
import { siliconflowProvider } from "./siliconflow.ts";
import { siliconflowCnProvider } from "./siliconflow-cn.ts";
import { syntheticProvider } from "./synthetic.ts";
import { umansProvider } from "./umans.ts";
import { veniceProvider } from "./venice.ts";
import { vllmProvider } from "./vllm.ts";
import { waferServerlessProvider } from "./wafer-serverless.ts";
import { zenmuxProvider } from "./zenmux.ts";
import { zhipuCodingPlanProvider } from "./zhipu-coding-plan.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { openrouterImagesProvider } from "./openrouter-images.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

export { radiusProvider };

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinModelApi<
	TProvider extends BuiltinProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

/** Typed read of the generated built-in catalog. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models?.[modelId as string] as Model<BuiltinModelApi<TProvider, TModelId>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models
		? (Object.values(models) as Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[])
		: [];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [
		aiandProvider(),
		aimlapiProvider(),
		alibabaCodingPlanProvider(),
		alibabaTokenPlanProvider(),
		basetenProvider(),
		bedrockMantleProvider(),
		coreweaveProvider(),
		firepassProvider(),
		gmiCloudProvider(),
		kiloProvider(),
		kimiCodeProvider(),
		llamaCppProvider(),
		litellmProvider(),
		lmStudioProvider(),
		metaProvider(),
		minimaxCodeProvider(),
		minimaxCodeCnProvider(),
		nanogptProvider(),
		novitaProvider(),
		opencodeZenProvider(),
		qianfanProvider(),
		qwenPortalProvider(),
		sakanaProvider(),
		siliconflowProvider(),
		siliconflowCnProvider(),
		syntheticProvider(),
		umansProvider(),
		veniceProvider(),
		vllmProvider(),
		waferServerlessProvider(),
		zenmuxProvider(),
		zhipuCodingPlanProvider(),
		antLingProvider(),
		amazonBedrockProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		radiusProvider(),
		togetherProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [openrouterImagesProvider()];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
