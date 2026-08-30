/**
 * S8.3 拆分:Anthropic client 构造与 auth/header 解析。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Model, ProviderEnv, ProviderHeaders } from "../../types.ts";
import { getCachedProviderProxyUrl } from "../../utils/node-http-proxy.ts";
import { createProxyFetchForUrl } from "../../utils/proxy-agent.ts";
import { claudeCodeVersion } from "./message-conversion.ts";
import { getAnthropicCompat } from "./types.ts";

export const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
export const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

export function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for provider: ${provider}`);
}

export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

export function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	env?: ProviderEnv,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}
	const proxyUrl = getCachedProviderProxyUrl(model.provider, model.baseUrl, env);
	const proxyFetch = proxyUrl ? createProxyFetchForUrl(model.baseUrl, proxyUrl) : undefined;

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			...(proxyFetch ? { fetch: proxyFetch } : {}),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			...(proxyFetch ? { fetch: proxyFetch } : {}),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key or header-owned auth.
	const sessionAffinityHeaders: ProviderHeaders =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	const useAuthHeader = model.compat?.authHeader === true;
	const client = new Anthropic({
		apiKey: useAuthHeader ? null : (apiKey ?? null),
		authToken: useAuthHeader ? (apiKey ?? null) : null,
		baseURL: model.baseUrl,
		...(proxyFetch ? { fetch: proxyFetch } : {}),
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}
