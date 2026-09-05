/**
 * S8.2 拆分:OpenAI client 构造与 api key/header 解析。
 */

import OpenAI from "openai";
import { clinePassHeaders } from "../cline-pass-headers.ts";
import type { Context, Model, ProviderEnv, ProviderHeaders } from "../../types.ts";
import { getCachedProviderProxyUrl } from "../../utils/node-http-proxy.ts";
import { createProxyFetchForUrl } from "../../utils/proxy-agent.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../github-copilot-headers.ts";
import { getCompat, type ResolvedOpenAICompletionsCompat } from "./compat-detection.ts";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

export function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

export function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	env?: ProviderEnv,
) {
	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "cline-pass") Object.assign(headers, clinePassHeaders(sessionId));
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}
	const proxyUrl = getCachedProviderProxyUrl(model.provider, model.baseUrl, env);
	const proxyFetch = proxyUrl ? createProxyFetchForUrl(model.baseUrl, proxyUrl) : undefined;

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		...(proxyFetch ? { fetch: proxyFetch } : {}),
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}
