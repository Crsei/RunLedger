/**
 * S8.2 拆分:AgentMessage → ChatCompletionMessageParam 转换。
 */

import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import type {
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../../types.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { transformMessages } from "../transform-messages.ts";
import { convertTools } from "./tool-conversion.ts";
import type { ResolvedOpenAICompletionsCompat } from "./compat-detection.ts";

type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

export function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

export function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

export function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

export function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
export function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

export function getDeferredToolNames(messages: Message[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				names.add(name);
			}
		}
	}
	return names;
}

export function getToolsByName(tools: Tool[] | undefined, names: Iterable<string>): Tool[] {
	if (!tools) return [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	return Array.from(names)
		.map((name) => toolsByName.get(name))
		.filter((tool): tool is Tool => tool !== undefined);
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		if (id.includes("|")) {
			const [callId] = id.split("|");
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						} satisfies ChatCompletionContentPartText;
					} else {
						return {
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage;
					}
				});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// Some providers don't accept null content, use empty string instead
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const nonEmptyThinkingBlocks = msg.content
				.filter(isThinkingContentBlock)
				.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// Always send assistant content as a plain string (OpenAI Chat Completions
					// API standard format). Sending as an array of {type:"text", text:"..."}
					// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
					// NVIDIA NIM) to mirror the content-block structure literally in their
					// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
					let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					if (model.provider === "opencode-go" && signature === "reasoning") {
						signature = "reasoning_content";
					}
					if (signature && signature.length > 0) {
						(assistantMsg as any)[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
					}
				}
			} else if (assistantText.length > 0) {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				assistantMsg.content = assistantText;
			}

			const toolCalls = msg.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				}));
				const reasoningDetails = toolCalls
					.filter((tc) => tc.thoughtSignature)
					.map((tc) => {
						try {
							return JSON.parse(tc.thoughtSignature!);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					(assistantMsg as any).reasoning_details = reasoningDetails;
				}
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				(assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
			) {
				(assistantMsg as { reasoning_content?: string }).reasoning_content = "";
			}
			// Skip assistant messages that have no content and no tool calls.
			// Some providers require "either content or tool_calls, but not none".
			// Other providers also don't accept empty assistant messages.
			// This handles aborted assistant responses that got no content.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			const deferredToolNames = new Set<string>();
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// Some providers require the 'name' field in tool results
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (compat.deferredToolsMode === "kimi") {
					for (const name of toolMsg.addedToolNames ?? []) {
						deferredToolNames.add(name);
					}
				}

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			if (deferredToolNames.size > 0) {
				const deferredTools = getToolsByName(context.tools, deferredToolNames);
				if (deferredTools.length > 0) {
					const kimiToolMessage: KimiToolSystemMessageParam = {
						role: "system",
						tools: convertTools(deferredTools, compat),
					};
					// Kimi accepts a system message with tools but omits the standard content field.
					params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
				}
			}
			continue;
		}

		lastRole = msg.role;
	}

	return params;
}
