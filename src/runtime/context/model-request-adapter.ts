/** Session Owner 的请求投影：完整依赖组、最近工作优先与最终输入预算。 */

import type { Message } from "../../types.ts";
import { transformMessages } from "../../api/transform-messages.ts";
import { groupRequestHistory } from "./history-groups.ts";
import { conservativeTokenEstimate } from "./token-estimator.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { assembleRuntimeContext, type RuntimeContextSource } from "./runtime-adapter.ts";
import type { ModelContextAssemblyInput, ModelContextAssemblyResult } from "../types.ts";

// 覆盖请求 envelope、消息分隔与工具表外层；正文和 schema 分别估算。
const REQUEST_ENVELOPE_RESERVE = 128;

/**
 * Converts the provider-facing context into bounded Runtime fragments, then
 * reconstructs the provider request only from the selected projection. The
 * original provider timestamps are intentionally excluded from fragment
 * identity so a replay has a stable context digest.
 */
export function assembleAgentModelContext(input: ModelContextAssemblyInput): ModelContextAssemblyResult {
	const groups = groupRequestHistory(input.context.messages);
	const requestContextDigest = runtimeDigest({
		systemPrompt: input.context.systemPrompt ?? null,
		messages: input.context.messages.map(stableMessage),
		tools: input.context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) ?? [],
		sources: input.sources ?? [],
	});
	const seed = runtimeDigest({
		kind: "model-context-request",
		sessionId: input.sessionId,
		turn: input.turn,
		provider: input.model.provider,
		model: input.model.id,
		requestContextDigest,
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
		...groups.map((group) => ({
			fragmentId: `agent-history-${group.start}`,
			key: `agent-history-${group.start}`,
			layer: "history" as const,
			content: JSON.stringify(transformMessages(group.messages, input.model).map(stableMessage)),
			order: input.context.messages.length - 1 - group.end,
			trust: "mixed" as const,
			taint: group.messages.some((message) => message.role === "toolResult") ? "tool_output" as const : "user_input" as const,
			priority: group.required ? "required" as const : "normal" as const,
		})),
	];
	const outputReserve = input.model.maxTokens;
	const toolDefinitions = input.context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) ?? [];
	const toolReserve = REQUEST_ENVELOPE_RESERVE + (toolDefinitions.length === 0 ? 0 : conservativeTokenEstimate(JSON.stringify(toolDefinitions)));
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
	const messages = groups.filter((group) => selected.has(`agent-history-${group.start}`)).flatMap((group) => group.messages);
	const baseSystemPrompt = selected.has("agent-system-prompt") ? input.context.systemPrompt : undefined;
	const selectedSourceContent = assembled.fragments
		.filter((fragment) => fragment.fragmentId !== "agent-system-prompt" && !fragment.fragmentId.startsWith("agent-history-"))
		.map((fragment) => assembled.contentByFragmentId[fragment.fragmentId])
		.filter((content): content is string => typeof content === "string" && content.length > 0);
	const systemPrompt = selectedSourceContent.length === 0
		? baseSystemPrompt
		: [baseSystemPrompt, ...selectedSourceContent].filter((content): content is string => typeof content === "string" && content.length > 0).join("\n\n");
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
		...(message.addedToolNames === undefined ? {} : { addedToolNames: message.addedToolNames }),
	};
	return {
		role: message.role,
		content: message.content,
		stopReason: message.stopReason,
		...(message.api === undefined ? {} : { api: message.api }),
		...(message.provider === undefined ? {} : { provider: message.provider }),
		...(message.model === undefined ? {} : { model: message.model }),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(message.usage === undefined ? {} : { usage: message.usage }),
	};
}
