/**
 * Codex Responses adapter —— 公共入口 facade。
 *
 * S8.1 拆分后实现位于 `openai-codex-responses/`:
 * - `request.ts`             request body、service tier 定价、URL 解析;
 * - `headers.ts`             auth/header 构造;
 * - `errors.ts`              错误 taxonomy + retry/error-response helpers;
 * - `sse-transport.ts`       SSE parse/process + zstd 压缩;
 * - `websocket-transport.ts` WebSocket connect/acquire/parse/process;
 * - `websocket-cache.ts`     session cache、debug stats、continuation 构造;
 * - `event-mapper.ts`        Codex event → ResponseStreamEvent;
 * - `types.ts`               公共选项类型。
 *
 * 本文件只保留 stream/streamSimple 装配与公共 export,不复制实现;
 * 顶层 adapter export 与 lazy adapter import 路径不变。
 */

import { notifyRequestPrepared } from "./request-observer.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
} from "../types.ts";
import { clampThinkingLevel } from "../models.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { fetchWithProviderProxy } from "../utils/fetch-provider-proxy.ts";
import { headersToRecord } from "../utils/headers.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions } from "./simple-options.ts";
import {
	buildRequestBody,
	resolveCodexUrl,
	resolveCodexWebSocketUrl,
	normalizeTimeoutMs,
	type RequestBody,
} from "./openai-codex-responses/request.ts";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses/types.ts";
import { buildSSEHeaders, buildWebSocketHeaders, extractAccountId } from "./openai-codex-responses/headers.ts";
import {
	CodexApiError,
	DEFAULT_MAX_RETRIES,
	BASE_DELAY_MS,
	isRetryableError,
	getRetryAfterDelayMs,
	capRetryDelayMs,
	sleep,
	parseErrorResponse,
	isCodexNonTransportError,
	isWebSocketConnectionLimitReachedError,
} from "./openai-codex-responses/errors.ts";
import { compressRequestBodyZstd, processStream } from "./openai-codex-responses/sse-transport.ts";
import { processWebSocketStream } from "./openai-codex-responses/websocket-transport.ts";
import {
	isWebSocketSseFallbackActive,
	recordWebSocketSseFallback,
	recordWebSocketFailure,
} from "./openai-codex-responses/websocket-cache.ts";

export type { OpenAICodexResponsesOptions } from "./openai-codex-responses/types.ts";
export {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	closeOpenAICodexWebSocketSessions,
	resolveCodexWebSocketProxyUrl,
	type OpenAICodexWebSocketDebugStats,
} from "./openai-codex-responses/websocket-cache.ts";

// ============================================================================
// Main Stream Function
// ============================================================================

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			await notifyRequestPrepared(options, body, model);
			const codexSessionId = clampOpenAIPromptCacheKey(options?.sessionId);
			const websocketRequestId = codexSessionId || uuidv7();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, codexSessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = options?.transport || "auto";
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(options?.sessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							options,
						);

						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						stream.push({
							type: "done",
							reason: output.stopReason as "stop" | "length" | "toolUse",
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								fallbackTransport: websocketStarted ? undefined : "sse",
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(options?.sessionId, error);
						if (websocketStarted) {
							throw error;
						}
						recordWebSocketSseFallback(options?.sessionId);
						break;
					}
				}
			}

			// Compress the request body once for the SSE path. The Codex backend
			// decodes Content-Encoding: zstd; the WebSocket transport above sends the
			// uncompressed JSON frame, matching the official Codex client.
			const compressedBody = compressRequestBodyZstd(bodyJson);
			if (compressedBody) {
				sseHeaders.set("content-encoding", "zstd");
			}
			const sseBody: Uint8Array | string = compressedBody ?? bodyJson;

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await fetchWithProviderProxy(
							model.provider,
							resolveCodexUrl(model.baseUrl),
							{
								method: "POST",
								headers: sseHeaders,
								body: sseBody,
								signal: combinedSignal.signal,
							},
							options?.env,
						);
					} catch (error) {
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
						const delayMs =
							retryAfterDelayMs === undefined
								? BASE_DELAY_MS * 2 ** attempt
								: response.status === 429
									? capRetryDelayMs(retryAfterDelayMs, options)
									: retryAfterDelayMs;

						await sleep(delayMs, options?.signal);
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new Error(info.friendlyMessage || info.message);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					if (attempt < maxRetries && !lastError.message.includes("usage limit")) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });
			await processStream(response, output, stream, model, options);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};
