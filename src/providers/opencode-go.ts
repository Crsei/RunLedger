import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";

export function opencodeGoProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "opencode-go",
		name: "OpenCode Zen Go",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models: Object.values(OPENCODE_GO_MODELS),
		api: {
			"anthropic-messages": withGoHeaders(anthropicMessagesApi()),
			"openai-completions": withGoHeaders(openAICompletionsApi()),
			"openai-responses": withGoHeaders(openAIResponsesApi()),
		},
	});
}

/** Go 的路由标识独立于缓存开关，统一覆盖三种 API。 */
function withGoHeaders(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) => streams.stream(model, context, { ...options, headers: requestHeaders(options) }),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, headers: requestHeaders(options) }),
	};
}

function requestHeaders(options?: StreamOptions): ProviderHeaders {
	const headers: ProviderHeaders = { ...options?.headers };
	const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
	if (!names.has("user-agent")) headers["User-Agent"] = "RunLedger";
	if (options?.sessionId && !names.has("x-opencode-session")) headers["x-opencode-session"] = options.sessionId;
	return headers;
}
