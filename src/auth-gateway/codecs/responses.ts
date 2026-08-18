import type { AssistantMessage, AssistantMessageEvent, Context, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "../../types.ts";
import type { GatewayEventSource, GatewayRequest } from "./shared.ts";
import {
	asRecord,
	assistantId,
	assistantModel,
	assistantUsage,
	blockThinking,
	blockText,
	decodeCommonOptions,
	decodeJsonObject,
	decodeTextImageParts,
	decodeToolResultContent,
	decodeTools,
	GatewayCodecError,
	isRecord,
	optionalString,
	requiredString,
	sseData,
	terminalErrorMessage,
} from "./shared.ts";

function inputText(value: unknown, label: string): string | (TextContent | { type: "image"; data: string; mimeType: string })[] {
	return decodeTextImageParts(value, label);
}

function decodeResponsesMessage(value: unknown, label: string, messages: Context["messages"], systemPrompts: string[], model: string): void {
	const message = asRecord(value, label);
	const role = requiredString(message.role, `${label}.role`);
	if (role === "system" || role === "developer") {
		const content = inputText(message.content, `${label}.content`);
		systemPrompts.push(typeof content === "string" ? content : content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n"));
		return;
	}
	if (role !== "user" && role !== "assistant") throw new GatewayCodecError(`${label}.role is unsupported`);
	const content = inputText(message.content, `${label}.content`);
	if (role === "user") {
		messages.push({ role, content, timestamp: Date.now() });
		return;
	}
	const assistantContent: (TextContent | ThinkingContent | ToolCall)[] = [];
	if (typeof content === "string") assistantContent.push({ type: "text", text: content });
	else {
		for (const part of content) {
			if (part.type !== "text") throw new GatewayCodecError(`${label}.content does not support images on assistant messages`);
			assistantContent.push(part);
		}
	}
	if (message.reasoning_content !== undefined) assistantContent.unshift({ type: "thinking", thinking: requiredString(message.reasoning_content, `${label}.reasoning_content`) });
	messages.push({ role: "assistant", content: assistantContent, api: "openai-responses", provider: "gateway", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
}

/** Decode an OpenAI Responses request into the common gateway context. */
export function decodeRequest(body: unknown): GatewayRequest {
	const request = asRecord(body, "request");
	const model = requiredString(request.model, "model");
	const systemPrompts: string[] = [];
	if (request.instructions !== undefined) systemPrompts.push(requiredString(request.instructions, "instructions"));
	const messages: Context["messages"] = [];
	const input = request.input;
	if (typeof input === "string") messages.push({ role: "user", content: input, timestamp: Date.now() });
	else if (Array.isArray(input)) {
		for (const [index, rawItem] of input.entries()) {
			const label = `input[${index}]`;
			const item = asRecord(rawItem, label);
			if (item.type === "message" || (item.type === undefined && item.role !== undefined)) decodeResponsesMessage(item, label, messages, systemPrompts, model);
			else if (item.type === "function_call") messages.push({ role: "assistant", content: [{ type: "toolCall", id: requiredString(item.call_id ?? item.id, `${label}.call_id`), name: requiredString(item.name, `${label}.name`), arguments: decodeJsonObject(item.arguments ?? "{}", `${label}.arguments`) }], api: "openai-responses", provider: "gateway", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
			else if (item.type === "function_call_output") messages.push({ role: "toolResult", toolCallId: requiredString(item.call_id, `${label}.call_id`), toolName: "tool", content: decodeToolResultContent(item.output ?? "", `${label}.output`), isError: false, timestamp: Date.now() } satisfies ToolResultMessage);
			else if (item.type === "reasoning") {
				const summary = Array.isArray(item.summary) ? item.summary.map((entry, summaryIndex) => requiredString(asRecord(entry, `${label}.summary[${summaryIndex}]`).text, `${label}.summary[${summaryIndex}].text`)).join("\n\n") : "";
				if (summary) messages.push({ role: "assistant", content: [{ type: "thinking", thinking: summary }], api: "openai-responses", provider: "gateway", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
			}
		}
	} else {
		throw new GatewayCodecError("input must be a string or array");
	}
	const toolNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
	}
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === "tool") {
			const toolName = toolNames.get(message.toolCallId);
			if (toolName !== undefined) messages[index] = { ...message, toolName };
		}
	}
	const reasoningValue = isRecord(request.reasoning) ? request.reasoning.effort : undefined;
	const options = decodeCommonOptions(request, { maxTokens: request.max_output_tokens, reasoning: reasoningValue });
	const tools = decodeTools(request.tools, "tools", "responses");
	return {
		model,
		context: {
			...(systemPrompts.length === 0 ? {} : { systemPrompt: systemPrompts.join("\n\n") }),
			messages,
			...(tools === undefined ? {} : { tools }),
		},
		options,
		stream: request.stream !== false,
	};
}

function responseCreated(id: string, model: string): Record<string, unknown> {
	return { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [], usage: null } };
}

function usagePayload(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): Record<string, number> {
	const usage = assistantUsage(event);
	return { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.totalTokens };
}

function responseOutput(message: AssistantMessage): Record<string, unknown>[] {
	return message.content.map((block, index) => {
		if (block.type === "text") return { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: block.text, annotations: [] }] };
		if (block.type === "thinking") return { type: "reasoning", id: block.thinkingSignature ?? `reasoning_${index}`, summary: [{ type: "summary_text", text: block.thinking }] };
		return { type: "function_call", id: `fc_${block.id}`, call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments), status: "completed" };
	});
}

/** Encode common assistant events as OpenAI Responses SSE records. */
export async function* encodeStream(source: GatewayEventSource): AsyncGenerator<string> {
	let started = false;
	const closedItems = new Set<number>();
	for await (const event of source) {
		const id = assistantId(event);
		const model = assistantModel(event);
		if (event.type === "start") {
			started = true;
			yield sseData(responseCreated(id, model));
			continue;
		}
		if (!started) {
			started = true;
			yield sseData(responseCreated(id, model));
		}
		if (event.type === "text_start") {
			const itemId = `msg_${event.contentIndex}`;
			yield sseData({ type: "response.output_item.added", output_index: event.contentIndex, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
			yield sseData({ type: "response.content_part.added", item_id: itemId, output_index: event.contentIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		} else if (event.type === "text_delta") {
			yield sseData({ type: "response.output_text.delta", item_id: `msg_${event.contentIndex}`, output_index: event.contentIndex, content_index: 0, delta: blockText(event) });
		} else if (event.type === "text_end" && !closedItems.has(event.contentIndex)) {
			closedItems.add(event.contentIndex);
			yield sseData({ type: "response.output_text.done", item_id: `msg_${event.contentIndex}`, output_index: event.contentIndex, content_index: 0, text: blockText(event) });
			yield sseData({ type: "response.content_part.done", item_id: `msg_${event.contentIndex}`, output_index: event.contentIndex, content_index: 0, part: { type: "output_text", text: blockText(event), annotations: [] } });
			yield sseData({ type: "response.output_item.done", output_index: event.contentIndex, item: { type: "message", id: `msg_${event.contentIndex}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: blockText(event), annotations: [] }] } });
		} else if (event.type === "thinking_start") {
			yield sseData({ type: "response.output_item.added", output_index: event.contentIndex, item: { type: "reasoning", id: `reasoning_${event.contentIndex}`, summary: [] } });
		} else if (event.type === "thinking_delta") {
			yield sseData({ type: "response.reasoning_summary_text.delta", item_id: `reasoning_${event.contentIndex}`, output_index: event.contentIndex, summary_index: 0, delta: blockThinking(event) });
		} else if (event.type === "thinking_end" && !closedItems.has(event.contentIndex)) {
			closedItems.add(event.contentIndex);
			yield sseData({ type: "response.reasoning_summary_part.done", item_id: `reasoning_${event.contentIndex}`, output_index: event.contentIndex, summary_index: 0 });
			yield sseData({ type: "response.output_item.done", output_index: event.contentIndex, item: { type: "reasoning", id: `reasoning_${event.contentIndex}`, summary: [{ type: "summary_text", text: event.content }] } });
		} else if (event.type === "toolcall_start") {
			const block = event.partial.content[event.contentIndex];
			const toolCall = block?.type === "toolCall" ? block : undefined;
			yield sseData({ type: "response.output_item.added", output_index: event.contentIndex, item: { type: "function_call", id: `fc_${toolCall?.id ?? event.contentIndex}`, call_id: toolCall?.id ?? `call_${event.contentIndex}`, name: toolCall?.name ?? "tool", arguments: "", status: "in_progress" } });
		} else if (event.type === "toolcall_delta") {
			yield sseData({ type: "response.function_call_arguments.delta", item_id: `fc_${event.contentIndex}`, output_index: event.contentIndex, delta: event.delta });
		} else if (event.type === "toolcall_end") {
			yield sseData({ type: "response.function_call_arguments.done", item_id: `fc_${event.contentIndex}`, output_index: event.contentIndex, arguments: JSON.stringify(event.toolCall.arguments) });
			yield sseData({ type: "response.output_item.done", output_index: event.contentIndex, item: { type: "function_call", id: `fc_${event.toolCall.id}`, call_id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments), status: "completed" } });
		} else if (event.type === "done") {
			yield sseData({ type: event.reason === "length" ? "response.incomplete" : "response.completed", response: { id, object: "response", status: event.reason === "length" ? "incomplete" : "completed", model, output: responseOutput(event.message), usage: usagePayload(event) } });
		} else if (event.type === "error") {
			yield sseData({ type: "response.failed", response: { id, object: "response", status: "failed", model, output: [], error: { code: event.reason, message: terminalErrorMessage(event) }, usage: usagePayload(event) } });
		}
	}
}
