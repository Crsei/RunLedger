/**
 * S8.1 拆分:request body 构建、service tier 定价与 URL 解析。
 */

import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";
import type { Context, Model, Usage } from "../../types.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import { splitDeferredTools } from "../../utils/deferred-tools.ts";
import { convertResponsesMessages, convertResponsesTools } from "../openai-responses-shared.ts";
import type { OpenAICodexResponsesOptions } from "./types.ts";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto" | "none" | "required";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

export function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): RequestBody {
	const toolPlacement = splitDeferredTools(context, model.compat?.supportsToolSearch ?? false);
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		deferredTools: toolPlacement.deferred,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		body.tools = convertResponsesTools(toolPlacement.immediate, { strict: null });
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

export function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

export function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}
