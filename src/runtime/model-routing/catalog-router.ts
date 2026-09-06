/** 标准会话按当前目录路由；历史协议由请求侧 adapter 转换，不依赖用户认证清单。 */

import type { Models } from "../../models.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { isModelRouteRequest } from "./schema.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "./types.ts";

export function createCatalogModelRouter(models: Pick<Models, "getModel">): {
	route(request: ModelRouteRequest): ModelRouteDecision;
} {
	return {
		route(request) {
			const slash = request.targetProfileId.indexOf("/");
			const model = slash > 0
				? models.getModel(request.targetProfileId.slice(0, slash), request.targetProfileId.slice(slash + 1))
				: undefined;
			// 只摘要能力字段，不把 endpoint、headers 或凭据纳入路由记录。
			const manifestDigest = runtimeDigest(model === undefined ? { model: request.targetProfileId } : {
				provider: model.provider, model: model.id, api: model.api,
				contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
				maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
				reasoning: model.reasoning, input: model.input,
				historyConversion: "request-adapter",
			});
			let reasonCode = "catalog_compatible";
			let message: string | undefined;
			if (!isModelRouteRequest(request)) {
				reasonCode = "invalid_request";
				message = "model route request failed validation";
			} else if (model === undefined) {
				reasonCode = "model_unknown";
				message = "selected model is no longer in the provider catalog";
			} else if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
				|| !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
				reasonCode = "model_metadata_invalid";
				message = "selected model has invalid token limits";
			} else if (request.requiredOutputTokens > model.maxTokens) {
				reasonCode = "output_budget_insufficient";
				message = "requested output exceeds the selected model output limit";
			} else if (request.requiredContextTokens + request.requiredOutputTokens > model.contextWindow) {
				reasonCode = "context_window_insufficient";
				message = "estimated context and output exceed the selected model context window";
			}
			const decision: Omit<ModelRouteDecision, "decisionDigest"> = {
				requestId: request.requestId,
				outcome: message === undefined ? "compatible" : "deny",
				targetProviderId: model?.provider ?? "unknown",
				targetModelId: model?.id ?? "unknown",
				targetProfileId: request.targetProfileId,
				manifestDigest,
				reasonCode,
				diagnostics: message === undefined ? [] : [{ code: reasonCode, severity: "error", message }],
			};
			return { ...decision, decisionDigest: runtimeDigest(decision) };
		},
	};
}
