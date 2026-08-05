/** Assemble the one model-request projection owned by the resident Host. */

import type { Api, Message, Model } from "../../types.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { assembleRuntimeContext, type RuntimeContextSource } from "./runtime-adapter.ts";
import type { ModelContextAssemblyInput, ModelContextAssemblyResult } from "../types.ts";

const MAX_TOOL_RESERVE_TOKENS = 4_096;

/**
 * Converts the provider-facing context into bounded Runtime fragments, then
 * reconstructs the provider request only from the selected projection. The
 * original provider timestamps are intentionally excluded from fragment
 * identity so a replay has a stable context digest.
 */
export function assembleAgentModelContext(input: ModelContextAssemblyInput): ModelContextAssemblyResult {
	const seed = runtimeDigest({
		kind: "model-context-request",
		sessionId: input.sessionId,
		turn: input.turn,
		provider: input.model.provider,
		model: input.model.id,
	});
	const requestId = createRuntimeId("command", seed.digest.slice(0, 48));
	const traceId = createRuntimeId("trace", runtimeDigest({ requestId, turn: input.turn }).digest.slice(0, 48));
	const sources: RuntimeContextSource[] = [
		{
			fragmentId: "agent-system-prompt",
			key: "agent-system-prompt",
			layer: "policy",
			content: input.context.systemPrompt ?? "",
			trust: "trusted",
			taint: "none",
			priority: "required",
		},
		...(input.sources ?? []),
		...input.context.messages.map((message, index) => ({
			fragmentId: `agent-history-${index}`,
			key: `agent-history-${index}`,
			layer: "history" as const,
			content: JSON.stringify(stableMessage(message)),
			trust: "mixed" as const,
			taint: message.role === "toolResult" ? "tool_output" as const : "user_input" as const,
			priority: index === input.context.messages.length - 1 ? "required" as const : "normal" as const,
		})),
	];
	const outputReserve = Math.min(input.model.maxTokens, Math.max(0, input.model.contextWindow - 1));
	const toolReserve = input.context.tools === undefined || input.context.tools.length === 0
		? 0
		: Math.min(MAX_TOOL_RESERVE_TOKENS, Math.max(0, input.model.contextWindow - outputReserve));
	const assembled = assembleRuntimeContext({
		request: {
			requestId,
			modelProfileId: `${input.model.provider}/${input.model.id}`,
			contextWindow: input.model.contextWindow,
			outputReserve,
			toolReserve,
			traceId,
		},
		sources,
	});
	const selected = new Set(assembled.receipt.fragmentIds);
	const messages = input.context.messages.filter((_message, index) => selected.has(`agent-history-${index}`));
	const systemPrompt = selected.has("agent-system-prompt") ? input.context.systemPrompt : undefined;
	return {
		context: {
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			messages,
			tools: input.context.tools,
		},
		receipt: assembled.receipt,
	};
}

function stableMessage(message: Message): unknown {
	if (message.role === "user") return { role: message.role, content: message.content };
	if (message.role === "toolResult") return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
		isError: message.isError,
		addedToolNames: message.addedToolNames,
	};
	return {
		role: message.role,
		content: message.content,
		api: message.api,
		provider: message.provider,
		model: message.model,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		usage: message.usage,
	};
}
