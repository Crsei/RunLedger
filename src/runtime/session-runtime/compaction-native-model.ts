import type { TraceRecorderFactory } from "../trace/composition.ts";
/** 原生 Responses compact 的受控 provider port；不提供工具执行能力。 */
import { compactOpenAIResponses } from "../../api/openai-responses.ts";
import { calculateCost } from "../../models.ts";
import type { Models } from "../../models.ts";
import type { Context, Model, Usage } from "../../types.ts";
import { createCatalogModelRouter } from "../model-routing/catalog-router.ts";
import type { ModelRequestRouter } from "../interactive-session-controller.ts";
import type { CompactionLimits, NativeCompactionPort } from "../context/compaction/strategy.ts";
import { conservativeTokenEstimate } from "../context/token-estimator.ts";
import { redactSummaryInput } from "../context/compaction/history.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import type { SummaryUsage } from "../context/compaction/budgeted-model.ts";

export function createNativeCompactionPort(options: {
	readonly models: Models;
	readonly model: Model<"openai-responses">;
	readonly router?: ModelRequestRouter;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly sessionId: string;
	readonly context: Context;
	readonly inputDigest: RuntimeDigest;
	readonly limits: CompactionLimits;
	readonly onUsage: (usage: SummaryUsage) => void;
}): NativeCompactionPort {
	let called = false;
	return {
		async generate(signal) {
			if (called || signal.aborted || Date.now() >= options.limits.deadlineMs) throw new Error("native_compaction_cancelled");
			called = true;
			// 已有 opaque 窗口按原样传递；新历史中的明文凭据先脱敏。
			const context: Context = { ...options.context, tools: [], messages: JSON.parse(redactSummaryInput(JSON.stringify(options.context.messages))) as Context["messages"] };
			const inputTokens = conservativeTokenEstimate(JSON.stringify(context));
			if (inputTokens > options.limits.maxInputTokensPerCall || inputTokens > options.limits.maxTotalInputTokens
				|| options.model.maxTokens > options.limits.maxTotalOutputTokens || options.limits.maxModelCalls < 1) throw new Error("native_compaction_budget_exhausted");
			options.onUsage({ calls: 1, input: inputTokens, output: options.model.maxTokens });
			const requestId = createRuntimeId("command", options.inputDigest.digest.slice(0, 48));
			const routed = await (options.router ?? createCatalogModelRouter(options.models)).route({
				requestId, operation: "summarize", requestKind: "compaction-summary", targetProfileId: `${options.model.provider}/${options.model.id}`,
				contextDigest: runtimeDigest(JSON.parse(JSON.stringify(context))), planDigest: options.inputDigest, resourceDigest: runtimeDigest({ tools: [] }),
				requiredContextTokens: inputTokens, requiredOutputTokens: options.model.maxTokens, requiresTools: false, requiresImages: false, requiresReasoningReplay: false,
				traceId: createRuntimeId("trace", runtimeDigest({ requestId }).digest.slice(0, 48)),
			});
			if (routed.outcome !== "compatible") throw new Error("native_compaction_model_incompatible");
			const auth = await options.models.getAuth(options.model);
			if (auth === undefined || signal.aborted) throw new Error("native_compaction_auth_unavailable");
			const model = auth.auth.baseUrl === undefined ? options.model : { ...options.model, baseUrl: auth.auth.baseUrl };
			const recorder = await options.traceRecorderFactory?.create({ sessionId: options.sessionId, traceId: createRuntimeId("trace", runtimeDigest({ requestId }).digest.slice(0, 48)), metadata: { requestKind: "compaction-summary", strategy: "openai-responses-native" } });
			const handle = await recorder?.startModel({ turn: 1, model, context: { ...context, tools: [] } });
			try {
				const result = await compactOpenAIResponses(model, context, { apiKey: auth.auth.apiKey, headers: auth.auth.headers, env: auth.env,
					signal, sessionId: options.sessionId, timeoutMs: Math.max(1, options.limits.deadlineMs - Date.now()) });
				const cached = result.usage.input_tokens_details?.cached_tokens ?? 0;
				const usage: Usage = { input: result.usage.input_tokens - cached, output: result.usage.output_tokens, cacheRead: cached, cacheWrite: 0, totalTokens: result.usage.total_tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				calculateCost(model, usage);
				if (handle !== undefined) await recorder?.finishModel(handle, { role: "assistant", content: [], stopReason: "stop", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
					usage });
				await recorder?.finishRun({ phase: "finished" });
				return { kind: "openai-responses-compaction", formatVersion: 1, inputDigest: options.inputDigest, state: result.state };
			} catch (error) {
				if (handle !== undefined) await recorder?.finishModel(handle).catch(() => undefined);
				await recorder?.finishRun({ phase: "failed" }).catch(() => undefined);
				throw error;
			}
		},
	};
}
