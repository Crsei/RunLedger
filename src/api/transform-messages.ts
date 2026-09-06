import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const usedToolCallIds = new Set<string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// 不重放失败正文或未完成的签名；其工具结果在配对阶段降为普通历史文本。
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				const boundary: AssistantMessage = {
					...assistantMsg,
					content: [{ type: "text", text: assistantMsg.stopReason === "aborted"
						? "[Previous assistant response was interrupted before completion.]"
						: "[Previous assistant response failed before completion.]" }],
					stopReason: "stop",
				};
				delete boundary.errorMessage;
				return boundary;
			}
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: `${block.thinking}\n\n`,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					let normalizedId = !isSameModel && normalizeToolCallId
						? normalizeToolCallId(toolCall.id, model, assistantMsg) : toolCall.id;
					// 截断或去掉 Responses item 部分可能产生冲突；前缀保留唯一性并再次经过目标规范化。
					if (usedToolCallIds.has(normalizedId)) {
						let suffix = usedToolCallIds.size;
						const limit = suffix * 2 + 2;
						do {
							const candidate = `rl${suffix++}_${toolCall.id}`;
							normalizedId = normalizeToolCallId ? normalizeToolCallId(candidate, model, assistantMsg) : candidate;
						} while (usedToolCallIds.has(normalizedId) && suffix < limit);
						if (usedToolCallIds.has(normalizedId)) throw new Error("Tool call ID normalizer cannot produce distinct IDs");
						normalizedToolCall = { ...normalizedToolCall };
						delete normalizedToolCall.thoughtSignature;
					}
					usedToolCallIds.add(normalizedId);
					toolCallIdMap.set(toolCall.id, normalizedId);
					if (normalizedId !== toolCall.id) normalizedToolCall = { ...normalizedToolCall, id: normalizedId };

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// 每个保留的调用后恰好放一个结果；延迟到达的真实结果优先于合成结果。
	type IndexedResult = { index: number; message: ToolResultMessage };
	const resultsById = new Map<string, IndexedResult[]>();
	for (let index = 0; index < transformed.length; index++) {
		const message = transformed[index];
		if (message.role !== "toolResult") continue;
		const entries = resultsById.get(message.toolCallId) ?? [];
		entries.push({ index, message });
		resultsById.set(message.toolCallId, entries);
	}
	const result: Message[] = [];
	for (let index = 0; index < transformed.length; index++) {
		const message = transformed[index];
		if (message.role === "toolResult") {
			if (!usedToolCallIds.has(message.toolCallId)) {
				// 压缩/失败边界可能留下孤立结果；按低权限 user 文本保留，不伪造 tool_use。
				const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");
				if (text) result.push({ role: "user", content: `[Previous tool result: ${message.toolName}]\n${text}`, timestamp: message.timestamp });
			}
			continue;
		}
		result.push(message);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const actual = resultsById.get(block.id)?.find((entry) => entry.index > index);
			result.push(actual?.message ?? {
				role: "toolResult", toolCallId: block.id, toolName: block.name,
				content: [{ type: "text", text: "No result provided" }], isError: true,
				timestamp: message.timestamp,
			});
		}
	}
	return result;
}
