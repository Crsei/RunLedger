/**
 * Production summarizer adapter —— 通过 Model Compatibility Router 的
 * `summarizer` alias 选择模型，调用真实 LLM 生成 compaction 摘要。
 *
 * 约束：
 *   - summarizer 目标 profile 必须 disable tools（router 已校验）；
 *   - 输出有界（maxSummaryChars），非空校验；
 *   - 不注入 builder 的 credential/tools；只使用模型本身的 auth；
 *   - 失败返回 typed code，不静默降级为 mock/fake。
 */

import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { Models } from "../models.ts";
import type { ModelCompatibilityRouter } from "../runtime/model-routing/router.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "../runtime/model-routing/types.ts";

export const SUMMARIZER_ALIAS = "summarizer";
export const MAX_SUMMARY_CHARS = 32_000;

export type SummarizerResult =
	| { readonly ok: true; readonly summary: string; readonly summaryDigest: ReturnType<typeof runtimeDigest>; readonly route: ModelRouteDecision }
	| { readonly ok: false; readonly code: "summarizer_route_denied" | "summarizer_model_unavailable" | "summarizer_request_failed" | "summarizer_output_invalid"; readonly message: string };

export interface ProductionSummarizer {
	(input: { readonly transcript: string; readonly focus?: string; readonly sessionId?: string }): Promise<SummarizerResult>;
}

export function createProductionSummarizer(options: {
	readonly models: Models;
	readonly router: ModelCompatibilityRouter;
	readonly maxSummaryChars?: number;
}): ProductionSummarizer {
	return async (input) => {
		const manifest = options.router.manifest();
		const profileId = manifest.aliases[SUMMARIZER_ALIAS];
		if (profileId === undefined) {
			return { ok: false, code: "summarizer_route_denied", message: `model compatibility manifest has no ${SUMMARIZER_ALIAS} alias` };
		}
		const targetProfileId = manifest.aliases[profileId] ?? profileId;
		const profile = manifest.profiles.find((candidate) => candidate.profileId === targetProfileId);
		if (profile === undefined) {
			return { ok: false, code: "summarizer_route_denied", message: `summarizer profile is not in the manifest: ${targetProfileId}` };
		}
		const contextDigest = runtimeDigest(input.transcript);
		const requestId = createRuntimeId("command", runtimeDigest({ sessionId: input.sessionId ?? "summarizer", operation: "summarize", contextDigest }).digest.slice(0, 48));
		const traceId = createRuntimeId("trace", runtimeDigest({ requestId, sessionId: input.sessionId ?? "summarizer" }).digest.slice(0, 48));
		const routeRequest: ModelRouteRequest = {
			requestId,
			operation: "summarize",
			sourceProfileId: undefined,
			targetProfileId: targetProfileId,
			contextDigest,
			planDigest: runtimeDigest({ kind: "plan-state", sessionId: input.sessionId ?? "summarizer" }),
			resourceDigest: runtimeDigest({ kind: "summarizer", tools: 0 }),
			requiredContextTokens: Math.ceil(Buffer.byteLength(input.transcript, "utf8") / 3) + 512,
			requiredOutputTokens: Math.min(profile.maxOutputTokens, Math.ceil((options.maxSummaryChars ?? MAX_SUMMARY_CHARS) / 3)),
			requiresTools: false,
			requiresReasoningReplay: false,
			requiresImages: false,
			traceId,
		};
		const route = options.router.route(routeRequest);
		if (route.outcome !== "compatible") {
			return { ok: false, code: "summarizer_route_denied", message: `summarizer route denied: ${route.reasonCode}` };
		}
		const model = options.models.getModel(profile.providerId, profile.modelId);
		if (model === undefined) {
			return { ok: false, code: "summarizer_model_unavailable", message: `summarizer model is not loaded: ${profile.providerId}/${profile.modelId}` };
		}
		const prompt = input.focus === undefined
			? "Summarize the following agent transcript into a compact factual replacement. Keep all decisions, file paths, tool calls with outcomes, and unresolved questions. Do not invent facts."
			: `Summarize the following agent transcript into a compact factual replacement, focusing on: ${input.focus}. Keep all decisions, file paths, tool calls with outcomes, and unresolved questions. Do not invent facts.`;
		const context = {
			systemPrompt: prompt,
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: input.transcript.slice(0, 200_000) }] },
			],
		};
		let message;
		try {
			message = await options.models.completeSimple(model, context as never, {});
		} catch (error) {
			return { ok: false, code: "summarizer_request_failed", message: error instanceof Error ? error.message : "summarizer model request failed" };
		}
		const text = message.content
			.filter((part): part is { readonly type: "text"; readonly text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		const maxChars = options.maxSummaryChars ?? MAX_SUMMARY_CHARS;
		if (text.length === 0) {
			return { ok: false, code: "summarizer_output_invalid", message: "summarizer returned an empty replacement" };
		}
		const summary = text.length > maxChars ? text.slice(0, maxChars) : text;
		return { ok: true, summary, summaryDigest: runtimeDigest(summary), route };
	};
}
