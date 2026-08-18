import type { AssistantMessageEvent, Context, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "../../types.ts";
import type { GatewayEventSource, GatewayRequest } from "./shared.ts";
import {
	asRecord,
	assistantId,
	assistantModel,
	assistantUsage,
	blockText,
	decodeCommonOptions,
	decodeDataImage,
	decodeJsonObject,
	decodeTextImageParts,
	decodeToolResultContent,
	decodeTools,
	GatewayCodecError,
	optionalString,
	requiredString,
	sseData,
	terminalErrorMessage,
	finishReason,
} from "./shared.ts";

function decodeAssistantContent(value: unknown, label: string): (TextContent | ThinkingContent | ToolCall)[] {
	if (value === undefined || value === null || value === "") return [];
	const content = decodeTextImageParts(value, label);
	const parts = typeof content === "string" ? [{ type: "text", text: content } satisfies TextContent] : content.map((part) => {
		if (part.type !== "text") throw new GatewayCodecError(`${label} does not support image blocks on assistant messages`);
		return part;
	});
	return parts;
}

function decodeChatMessage(value: unknown, index: number, systemPrompts: string[], messages: Context["messages"]): void {
	const label = `messages[${index}]`;
	const message = asRecord(value, label);
	const role = requiredString(message.role, `${label}.role`);
	if (role === "system" || role === "developer") {
		const content = decodeTextImageParts(message.content, `${label}.content`);
		if (typeof content === "string") systemPrompts.push(content);
		else systemPrompts.push(content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n"));
		return;
	}
	if (role === "user") {
		messages.push({ role, content: decodeTextImageParts(message.content, `${label}.content`), timestamp: Date.now() });
		return;
	}
	if (role === "assistant") {
		const content = decodeAssistantContent(message.content, `${label}.content`);
		const reasoning = optionalString(message.reasoning_content ?? message.reasoning, `${label}.reasoning_content`);
		if (reasoning) content.unshift({ type: "thinking", thinking: reasoning });
		if (message.tool_calls !== undefined) {
			if (!Array.isArray(message.tool_calls)) throw new GatewayCodecError(`${label}.tool_calls must be an array`);
			for (const [toolIndex, rawToolCall] of message.tool_calls.entries()) {
				const toolCall = asRecord(rawToolCall, `${label}.tool_calls[${toolIndex}]`);
				const fn = asRecord(toolCall.function, `${label}.tool_calls[${toolIndex}].function`);
				content.push({
					type: "toolCall",
					id: requiredString(toolCall.id, `${label}.tool_calls[${toolIndex}].id`),
					name: requiredString(fn.name, `${label}.tool_calls[${toolIndex}].function.name`),
					arguments: decodeJsonObject(fn.arguments ?? "{}", `${label}.tool_calls[${toolIndex}].function.arguments`),
				});
			}
		}
		messages.push({
			role,
			content,
			api: "openai-completions",
			provider: "gateway",
			model: "gateway-input",
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
		});
		return;
	}
	if (role === "tool") {
		messages.push({
			role: "toolResult",
			toolCallId: requiredString(message.tool_call_id, `${label}.tool_call_id`),
			toolName: typeof message.name === "string" ? message.name : "tool",
			content: decodeToolResultContent(message.content, `${label}.content`),
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage);
		return;
	}
	throw new GatewayCodecError(`${label}.role is unsupported`);
}

/** Decode an OpenAI Chat Completions request into the common gateway context. */
export function decodeRequest(body: unknown): GatewayRequest {
	const request = asRecord(body, "request");
	const model = requiredString(request.model, "model");
	if (!Array.isArray(request.messages)) throw new GatewayCodecError("messages must be an array");
	const systemPrompts: string[] = [];
	const messages: Context["messages"] = [];
	request.messages.forEach((message, index) => decodeChatMessage(message, index, systemPrompts, messages));
	const options = decodeCommonOptions(request, {
		maxTokens: request.max_tokens ?? request.max_completion_tokens,
		reasoning: request.reasoning_effort,
	});
	const toolChoice = request.tool_choice;
	const tools = decodeTools(request.tools, "tools", "chat");
	return {
		model,
		context: {
			...(systemPrompts.length === 0 ? {} : { systemPrompt: systemPrompts.join("\n\n") }),
			messages,
			...(tools === undefined ? {} : { tools }),
		},
		options: toolChoice === undefined ? options : { ...options, toolChoice },
		stream: request.stream !== false,
	};
}

function chunk(
	id: string,
	model: string,
	delta: Record<string, unknown>,
	finish: string | null = null,
	usage?: Record<string, number>,
): Record<string, unknown> {
	return {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(usage === undefined ? {} : { usage }),
	};
}

function toolCallAt(event: Extract<AssistantMessageEvent, { type: "toolcall_start" }>): ToolCall | undefined {
	const block = event.partial.content[event.contentIndex];
	return block?.type === "toolCall" ? block : undefined;
}

function usagePayload(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): Record<string, number> {
	const usage = assistantUsage(event);
	return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens };
}

/** Encode common assistant events as OpenAI Chat Completions SSE records. */
export async function* encodeStream(source: GatewayEventSource): AsyncGenerator<string> {
	let started = false;
	const textIndices = new Set<number>();
	for await (const event of source) {
		const id = assistantId(event);
		const model = assistantModel(event);
		if (event.type === "start") {
			started = true;
			yield sseData(chunk(id, model, { role: "assistant" }));
			continue;
		}
		if (!started) {
			started = true;
			yield sseData(chunk(id, model, { role: "assistant" }));
		}
		if (event.type === "text_delta") {
			textIndices.add(event.contentIndex);
			yield sseData(chunk(id, model, { content: event.delta }));
		} else if (event.type === "text_end" && !textIndices.has(event.contentIndex)) {
			yield sseData(chunk(id, model, { content: blockText(event) }));
		} else if (event.type === "thinking_delta") {
			yield sseData(chunk(id, model, { reasoning_content: event.delta }));
		} else if (event.type === "toolcall_start") {
			const toolCall = toolCallAt(event);
			yield sseData(chunk(id, model, {
				tool_calls: [{ index: event.contentIndex, ...(toolCall?.id === undefined ? {} : { id: toolCall.id }), type: "function", function: { ...(toolCall?.name === undefined ? {} : { name: toolCall.name }), arguments: "" } }],
			}));
		} else if (event.type === "toolcall_delta") {
			yield sseData(chunk(id, model, { tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }] }));
		} else if (event.type === "done") {
			yield sseData(chunk(id, model, {}, finishReason(event.reason), usagePayload(event)));
			yield "data: [DONE]\n\n";
		} else if (event.type === "error") {
			yield sseData({ error: { message: terminalErrorMessage(event), type: "gateway_error", code: event.reason } });
			yield "data: [DONE]\n\n";
		}
	}
}
