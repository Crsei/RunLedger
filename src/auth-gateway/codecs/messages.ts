import type { AssistantMessageEvent, Context, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "../../types.ts";
import type { GatewayEventSource, GatewayRequest } from "./shared.ts";
import {
	asRecord,
	assistantId,
	assistantModel,
	assistantUsage,
	blockThinking,
	blockText,
	decodeCommonOptions,
	decodeDataImage,
	decodeJsonObject,
	decodeTextImageParts,
	decodeToolResultContent,
	decodeTools,
	GatewayCodecError,
	isRecord,
	optionalString,
	requiredString,
	sseEvent,
	terminalErrorMessage,
} from "./shared.ts";

function decodeAnthropicAssistantBlocks(value: unknown, label: string): (TextContent | ThinkingContent | ToolCall)[] {
	const rawBlocks = typeof value === "string" ? [{ type: "text", text: value }] : value;
	if (!Array.isArray(rawBlocks)) throw new GatewayCodecError(`${label} must be a string or content array`);
	return rawBlocks.map((rawBlock, index) => {
		const block = asRecord(rawBlock, `${label}[${index}]`);
		if (block.type === "text") return { type: "text", text: requiredString(block.text, `${label}[${index}].text`) } satisfies TextContent;
		if (block.type === "thinking") return { type: "thinking", thinking: requiredString(block.thinking, `${label}[${index}].thinking`) } satisfies ThinkingContent;
		if (block.type === "redacted_thinking") return { type: "thinking", thinking: "", thinkingSignature: requiredString(block.data, `${label}[${index}].data`), redacted: true } satisfies ThinkingContent;
		if (block.type === "tool_use") return {
				type: "toolCall",
				id: requiredString(block.id, `${label}[${index}].id`),
				name: requiredString(block.name, `${label}[${index}].name`),
				arguments: decodeJsonObject(block.input ?? {}, `${label}[${index}].input`),
			} satisfies ToolCall;
		throw new GatewayCodecError(`${label}[${index}] has an unsupported type`);
	});
}

function appendAnthropicUserContent(value: unknown, label: string, messages: Context["messages"]): void {
	if (typeof value === "string") {
		messages.push({ role: "user", content: value, timestamp: Date.now() });
		return;
	}
	if (!Array.isArray(value)) throw new GatewayCodecError(`${label} must be a string or content array`);
	const normalContent: (TextContent | { type: "image"; data: string; mimeType: string })[] = [];
	for (const [index, rawBlock] of value.entries()) {
		const block = asRecord(rawBlock, `${label}[${index}]`);
		if (block.type === "tool_result") {
			if (normalContent.length > 0) {
				messages.push({ role: "user", content: normalContent, timestamp: Date.now() });
				normalContent.length = 0;
			}
			messages.push({
				role: "toolResult",
				toolCallId: requiredString(block.tool_use_id, `${label}[${index}].tool_use_id`),
				toolName: typeof block.name === "string" ? block.name : "tool",
				content: decodeToolResultContent(block.content ?? "", `${label}[${index}].content`),
				isError: block.is_error === true,
				timestamp: Date.now(),
			} satisfies ToolResultMessage);
			continue;
		}
		if (block.type === "text") {
			normalContent.push({ type: "text", text: requiredString(block.text, `${label}[${index}].text`) });
			continue;
		}
		if (block.type === "image") {
			const source = asRecord(block.source, `${label}[${index}].source`);
			if (source.type !== "base64") throw new GatewayCodecError(`${label}[${index}] only supports base64 images`);
			normalContent.push(decodeDataImage(`data:${requiredString(source.media_type, `${label}[${index}].source.media_type`)};base64,${requiredString(source.data, `${label}[${index}].source.data`)}`, `${label}[${index}].source`));
			continue;
		}
		throw new GatewayCodecError(`${label}[${index}] has an unsupported type`);
	}
	if (normalContent.length > 0 || value.length === 0) messages.push({ role: "user", content: normalContent, timestamp: Date.now() });
}

/** Decode an Anthropic Messages request into the common gateway context. */
export function decodeRequest(body: unknown): GatewayRequest {
	const request = asRecord(body, "request");
	const model = requiredString(request.model, "model");
	if (!Array.isArray(request.messages)) throw new GatewayCodecError("messages must be an array");
	const systemParts: string[] = [];
	if (request.system !== undefined) {
		const system = decodeTextImageParts(request.system, "system");
		if (typeof system === "string") systemParts.push(system);
		else systemParts.push(system.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n\n"));
	}
	const messages: Context["messages"] = [];
	for (const [index, rawMessage] of request.messages.entries()) {
		const label = `messages[${index}]`;
		const message = asRecord(rawMessage, label);
		const role = requiredString(message.role, `${label}.role`);
		if (role === "user") appendAnthropicUserContent(message.content, `${label}.content`, messages);
		else if (role === "assistant") messages.push({ role: "assistant", content: decodeAnthropicAssistantBlocks(message.content, `${label}.content`), api: "anthropic-messages", provider: "gateway", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		else throw new GatewayCodecError(`${label}.role must be user or assistant`);
	}
	const toolNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
		}
	}
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === "tool") {
			const toolName = toolNames.get(message.toolCallId);
			if (toolName !== undefined) messages[index] = { ...message, toolName };
		}
	}
	const thinking = isRecord(request.thinking) && request.thinking.type === "enabled" ? (typeof request.thinking.effort === "string" ? request.thinking.effort : "high") : undefined;
	const options = decodeCommonOptions(request, { maxTokens: request.max_tokens, reasoning: thinking });
	const tools = decodeTools(request.tools, "tools", "anthropic");
	return {
		model,
		context: {
			...(systemParts.length === 0 ? {} : { systemPrompt: systemParts.join("\n\n") }),
			messages,
			...(tools === undefined ? {} : { tools }),
		},
		options,
		stream: request.stream !== false,
	};
}

function messageStart(id: string, model: string): Record<string, unknown> {
	return { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
}

function ensureStarted(started: boolean, id: string, model: string): { started: boolean; line?: string } {
	return started ? { started } : { started: true, line: sseEvent("message_start", messageStart(id, model)) };
}

function stopReason(reason: "stop" | "length" | "toolUse"): string {
	return reason === "toolUse" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn";
}

/** Encode common assistant events as Anthropic Messages SSE records. */
export async function* encodeStream(source: GatewayEventSource): AsyncGenerator<string> {
	let started = false;
	const closedBlocks = new Set<number>();
	for await (const event of source) {
		const id = assistantId(event);
		const model = assistantModel(event);
		if (event.type === "start") {
			started = true;
			yield sseEvent("message_start", messageStart(id, model));
			continue;
		}
		const ensured = ensureStarted(started, id, model);
		started = ensured.started;
		if (ensured.line) yield ensured.line;
		if (event.type === "text_start") {
			yield sseEvent("content_block_start", { type: "content_block_start", index: event.contentIndex, content_block: { type: "text", text: "" } });
		} else if (event.type === "text_delta") {
			yield sseEvent("content_block_delta", { type: "content_block_delta", index: event.contentIndex, delta: { type: "text_delta", text: blockText(event) } });
		} else if (event.type === "text_end" && !closedBlocks.has(event.contentIndex)) {
			closedBlocks.add(event.contentIndex);
			yield sseEvent("content_block_stop", { type: "content_block_stop", index: event.contentIndex });
		} else if (event.type === "thinking_start") {
			yield sseEvent("content_block_start", { type: "content_block_start", index: event.contentIndex, content_block: { type: "thinking", thinking: "" } });
		} else if (event.type === "thinking_delta") {
			yield sseEvent("content_block_delta", { type: "content_block_delta", index: event.contentIndex, delta: { type: "thinking_delta", thinking: blockThinking(event) } });
		} else if (event.type === "thinking_end" && !closedBlocks.has(event.contentIndex)) {
			closedBlocks.add(event.contentIndex);
			yield sseEvent("content_block_stop", { type: "content_block_stop", index: event.contentIndex });
		} else if (event.type === "toolcall_start") {
			const block = event.partial.content[event.contentIndex];
			const toolCall = block?.type === "toolCall" ? block : undefined;
			yield sseEvent("content_block_start", { type: "content_block_start", index: event.contentIndex, content_block: { type: "tool_use", id: toolCall?.id ?? "tool_call", name: toolCall?.name ?? "tool", input: {} } });
		} else if (event.type === "toolcall_delta") {
			yield sseEvent("content_block_delta", { type: "content_block_delta", index: event.contentIndex, delta: { type: "input_json_delta", partial_json: event.delta } });
		} else if (event.type === "toolcall_end") {
			if (!closedBlocks.has(event.contentIndex)) {
				closedBlocks.add(event.contentIndex);
				yield sseEvent("content_block_stop", { type: "content_block_stop", index: event.contentIndex });
			}
		} else if (event.type === "done") {
			const usage = assistantUsage(event);
			yield sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(event.reason), stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } });
			yield sseEvent("message_stop", { type: "message_stop" });
		} else if (event.type === "error") {
			yield sseEvent("error", { type: "error", error: { type: event.reason === "aborted" ? "abort_error" : "api_error", message: terminalErrorMessage(event) } });
		}
	}
}
