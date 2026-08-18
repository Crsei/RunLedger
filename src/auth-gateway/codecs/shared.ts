import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	StopReason,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../../types.ts";

export interface GatewayOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly reasoning?: string;
	readonly toolChoice?: unknown;
	readonly cacheRetention?: "none" | "short" | "long";
	readonly sessionId?: string;
	readonly metadata?: Record<string, unknown>;
	readonly [key: string]: unknown;
}

export interface GatewayRequest {
	readonly model: string;
	readonly context: Context;
	readonly options: GatewayOptions;
	readonly stream: boolean;
}

export class GatewayCodecError extends Error {
	readonly code = "invalid_request";

	constructor(message: string) {
		super(message);
		this.name = "GatewayCodecError";
	}
}

export type JsonRecord = Record<string, unknown>;
export type GatewayEventSource = Iterable<AssistantMessageEvent> | AsyncIterable<AssistantMessageEvent>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) throw new GatewayCodecError(`${label} must be an object`);
	return value;
}

export function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new GatewayCodecError(`${label} must be a non-empty string`);
	return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new GatewayCodecError(`${label} must be a string`);
	return value;
}

export function optionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new GatewayCodecError(`${label} must be a finite number`);
	return value;
}

export function optionalThinking(value: unknown, label: string): string | undefined {
	const thinking = optionalString(value, label);
	if (thinking === undefined) return undefined;
	if (thinking === "none") return undefined;
	if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
		throw new GatewayCodecError(`${label} has an unsupported value`);
	}
	return thinking;
}

export function decodeJsonObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "string") {
		if (isRecord(value)) return value;
		throw new GatewayCodecError(`${label} must be a JSON object`);
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) throw new GatewayCodecError(`${label} must decode to a JSON object`);
		return parsed;
	} catch (error) {
		if (error instanceof GatewayCodecError) throw error;
		throw new GatewayCodecError(`${label} must contain valid JSON`);
	}
}

export function decodeDataImage(value: unknown, label: string): ImageContent {
	const url = requiredString(value, label);
	const match = /^data:([^;,\s]+);base64,(.*)$/su.exec(url);
	if (!match) throw new GatewayCodecError(`${label} must be a base64 data URL`);
	return { type: "image", mimeType: match[1]!, data: match[2]! };
}

export function decodeTextImageParts(value: unknown, label: string): string | (TextContent | ImageContent)[] {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) throw new GatewayCodecError(`${label} must be a string or content array`);
	const parts: (TextContent | ImageContent)[] = [];
	for (const [index, rawPart] of value.entries()) {
		const part = asRecord(rawPart, `${label}[${index}]`);
		if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
			parts.push({ type: "text", text: requiredString(part.text, `${label}[${index}].text`) });
			continue;
		}
		if (part.type === "image_url") {
			const imageUrl = asRecord(part.image_url, `${label}[${index}].image_url`);
			parts.push(decodeDataImage(imageUrl.url, `${label}[${index}].image_url.url`));
			continue;
		}
		if (part.type === "input_image") {
			parts.push(decodeDataImage(part.image_url, `${label}[${index}].image_url`));
			continue;
		}
		if (part.type === "image") {
			const source = asRecord(part.source, `${label}[${index}].source`);
			if (source.type !== "base64") throw new GatewayCodecError(`${label}[${index}] only supports base64 images`);
			const mediaType = requiredString(source.media_type, `${label}[${index}].source.media_type`);
			const data = requiredString(source.data, `${label}[${index}].source.data`);
			parts.push({ type: "image", mimeType: mediaType, data });
			continue;
		}
		throw new GatewayCodecError(`${label}[${index}] has an unsupported content type`);
	}
	return parts;
}

export function decodeToolResultContent(value: unknown, label: string): (TextContent | ImageContent)[] {
	const content = decodeTextImageParts(value, label);
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function decodeTools(value: unknown, label: string, style: "chat" | "anthropic" | "responses" = "chat"): Tool[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new GatewayCodecError(`${label} must be an array`);
	return value.map((rawTool, index) => {
		const tool = asRecord(rawTool, `${label}[${index}]`);
		const source = style === "chat" ? asRecord(tool.function, `${label}[${index}].function`) : tool;
		const name = requiredString(source.name, `${label}[${index}].name`);
		const description = typeof source.description === "string" ? source.description : "";
		const parameters = style === "anthropic" ? source.input_schema : source.parameters;
		return { name, description, parameters: asRecord(parameters ?? { type: "object" }, `${label}[${index}].parameters`) } as Tool;
	});
}

export function decodeNativeTool(value: unknown, label: string): Tool {
	const tool = asRecord(value, label);
	return {
		name: requiredString(tool.name, `${label}.name`),
		description: typeof tool.description === "string" ? tool.description : "",
		parameters: asRecord(tool.parameters ?? { type: "object" }, `${label}.parameters`),
	};
}

export function decodeInternalContent(value: unknown, label: string): (TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) throw new GatewayCodecError(`${label} must be a string or content array`);
	return value.map((rawBlock, index) => {
		const block = asRecord(rawBlock, `${label}[${index}]`);
		if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text } satisfies TextContent;
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			return { type: "image", data: block.data, mimeType: block.mimeType } satisfies ImageContent;
		}
		throw new GatewayCodecError(`${label}[${index}] is not a valid internal content block`);
	});
}

export function decodeNativeMessage(value: unknown, label: string): Message {
	const message = asRecord(value, label);
	if (message.role === "user") {
		return { role: "user", content: typeof message.content === "string" ? message.content : decodeInternalContent(message.content, `${label}.content`), timestamp: numberOrNow(message.timestamp) } satisfies UserMessage;
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: requiredString(message.toolCallId, `${label}.toolCallId`),
			toolName: requiredString(message.toolName, `${label}.toolName`),
			content: decodeInternalContent(message.content, `${label}.content`),
			isError: message.isError === true,
			timestamp: numberOrNow(message.timestamp),
		} satisfies ToolResultMessage;
	}
	if (message.role === "assistant") {
		const api = requiredString(message.api, `${label}.api`) as Api;
		const content = message.content;
		if (!Array.isArray(content)) throw new GatewayCodecError(`${label}.content must be an array`);
		return {
			role: "assistant",
			content: content.map((rawBlock, index) => decodeNativeAssistantBlock(rawBlock, `${label}.content[${index}]`)),
			api,
			provider: requiredString(message.provider, `${label}.provider`),
			model: requiredString(message.model, `${label}.model`),
			responseId: optionalString(message.responseId, `${label}.responseId`),
			usage: decodeUsage(message.usage, `${label}.usage`),
			stopReason: decodeStopReason(message.stopReason, `${label}.stopReason`),
			errorMessage: optionalString(message.errorMessage, `${label}.errorMessage`),
			timestamp: numberOrNow(message.timestamp),
		} satisfies AssistantMessage;
	}
	throw new GatewayCodecError(`${label}.role is unsupported`);
}

function decodeNativeAssistantBlock(value: unknown, label: string): AssistantMessage["content"][number] {
	const block = asRecord(value, label);
	if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text, ...(typeof block.textSignature === "string" ? { textSignature: block.textSignature } : {}) };
	if (block.type === "thinking" && typeof block.thinking === "string") return { type: "thinking", thinking: block.thinking, ...(typeof block.thinkingSignature === "string" ? { thinkingSignature: block.thinkingSignature } : {}) };
	if (block.type === "toolCall") return { type: "toolCall", id: requiredString(block.id, `${label}.id`), name: requiredString(block.name, `${label}.name`), arguments: asRecord(block.arguments, `${label}.arguments`) } satisfies ToolCall;
	throw new GatewayCodecError(`${label}.type is unsupported`);
}

export function decodeNativeContext(value: unknown): Context {
	const context = asRecord(value, "context");
	if (!Array.isArray(context.messages)) throw new GatewayCodecError("context.messages must be an array");
	const tools = context.tools === undefined ? undefined : context.tools instanceof Array ? context.tools.map((tool, index) => decodeNativeTool(tool, `context.tools[${index}]`)) : (() => { throw new GatewayCodecError("context.tools must be an array"); })();
	return {
		...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}),
		messages: context.messages.map((message, index) => decodeNativeMessage(message, `context.messages[${index}]`)),
		...(tools === undefined ? {} : { tools }),
	};
}

function decodeUsage(value: unknown, label: string): Usage {
	const usage = asRecord(value, label);
	const input = finiteNumber(usage.input, `${label}.input`);
	const output = finiteNumber(usage.output, `${label}.output`);
	const cacheRead = finiteNumber(usage.cacheRead, `${label}.cacheRead`);
	const cacheWrite = finiteNumber(usage.cacheWrite, `${label}.cacheWrite`);
	const totalTokens = finiteNumber(usage.totalTokens, `${label}.totalTokens`);
	const cost = asRecord(usage.cost, `${label}.cost`);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: finiteNumber(cost.input, `${label}.cost.input`),
			output: finiteNumber(cost.output, `${label}.cost.output`),
			cacheRead: finiteNumber(cost.cacheRead, `${label}.cost.cacheRead`),
			cacheWrite: finiteNumber(cost.cacheWrite, `${label}.cost.cacheWrite`),
			total: finiteNumber(cost.total, `${label}.cost.total`),
		},
	};
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new GatewayCodecError(`${label} must be a finite number`);
	return value;
}

function numberOrNow(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function decodeStopReason(value: unknown, label: string): StopReason {
	if (value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted") return value;
	throw new GatewayCodecError(`${label} is not a valid stop reason`);
}

export function decodeCommonOptions(body: JsonRecord, values: { readonly maxTokens?: unknown; readonly reasoning?: unknown }): GatewayOptions {
	const temperature = optionalNumber(body.temperature, "temperature");
	const maxTokens = optionalNumber(values.maxTokens, "max_tokens");
	const reasoning = optionalThinking(values.reasoning, "reasoning");
	const cacheRetention = body.cache_retention ?? body.cacheRetention;
	if (cacheRetention !== undefined && cacheRetention !== "none" && cacheRetention !== "short" && cacheRetention !== "long") {
		throw new GatewayCodecError("cache_retention must be none, short, or long");
	}
	const sessionId = optionalString(body.session_id ?? body.sessionId, "session_id");
	return {
		...(temperature === undefined ? {} : { temperature }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(reasoning === undefined ? {} : { reasoning }),
		...(cacheRetention === undefined ? {} : { cacheRetention }),
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

export function sseData(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseEvent(name: string, payload: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function assistantId(event: AssistantMessageEvent): string {
	if (event.type === "done") return event.message.responseId ?? "runledger-response";
	if (event.type === "error") return event.error.responseId ?? "runledger-response";
	return event.partial.responseId ?? "runledger-response";
}

export function assistantModel(event: AssistantMessageEvent): string {
	if (event.type === "done") return event.message.model;
	if (event.type === "error") return event.error.model;
	return event.partial.model;
}

export function assistantUsage(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): Usage {
	return event.type === "done" ? event.message.usage : event.error.usage;
}

export function finishReason(reason: Extract<StopReason, "stop" | "length" | "toolUse">): string {
	return reason === "toolUse" ? "tool_calls" : reason;
}

export function terminalErrorMessage(event: Extract<AssistantMessageEvent, { type: "error" }>): string {
	return event.error.errorMessage ?? (event.reason === "aborted" ? "Request aborted" : "Request failed");
}

export function blockText(event: Extract<AssistantMessageEvent, { type: "text_delta" | "text_end" }>): string {
	return event.type === "text_delta" ? event.delta : event.content;
}

export function blockThinking(event: Extract<AssistantMessageEvent, { type: "thinking_delta" | "thinking_end" }>): string {
	return event.type === "thinking_delta" ? event.delta : event.content;
}
