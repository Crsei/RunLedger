import type { AssistantMessageEvent } from "../../types.ts";
import type { PiMessagesEvent } from "../../api/pi-messages.ts";
import type { GatewayEventSource, GatewayRequest } from "./shared.ts";
import {
	asRecord,
	decodeNativeContext,
	GatewayCodecError,
	optionalNumber,
	optionalString,
	optionalThinking,
	sseData,
	terminalErrorMessage,
	requiredString,
} from "./shared.ts";

/** Decode the native RunLedger pi-messages request without accepting unknown context shapes. */
export function decodeRequest(body: unknown): GatewayRequest {
	const request = asRecord(body, "request");
	const options = request.options === undefined ? {} : asRecord(request.options, "options");
	const temperature = optionalNumber(options.temperature, "options.temperature");
	const maxTokens = optionalNumber(options.maxTokens, "options.maxTokens");
	const reasoning = optionalThinking(options.reasoning, "options.reasoning");
	const sessionId = optionalString(options.sessionId, "options.sessionId");
	const cacheRetention = options.cacheRetention;
	if (cacheRetention !== undefined && cacheRetention !== "none" && cacheRetention !== "short" && cacheRetention !== "long") throw new GatewayCodecError("options.cacheRetention is invalid");
	const normalizedCacheRetention: "none" | "short" | "long" | undefined = cacheRetention === "none"
		? "none"
		: cacheRetention === "short"
			? "short"
			: cacheRetention === "long"
				? "long"
				: undefined;
	const decodedOptions = {
		...(temperature === undefined ? {} : { temperature }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(reasoning === undefined ? {} : { reasoning }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(normalizedCacheRetention === undefined ? {} : { cacheRetention: normalizedCacheRetention }),
		...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
		...(options.debug === undefined ? {} : { debug: options.debug === true }),
	};
	return {
		model: requiredString(request.model, "model"),
		context: decodeNativeContext(request.context),
		options: decodedOptions,
		stream: request.stream !== false,
	};
}

function toPiEvent(event: AssistantMessageEvent): PiMessagesEvent {
	switch (event.type) {
		case "start":
			return { type: "start" };
		case "text_start":
			return { type: "text_start", contentIndex: event.contentIndex };
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return { type: "text_end", contentIndex: event.contentIndex, content: event.content };
		case "thinking_start":
			return { type: "thinking_start", contentIndex: event.contentIndex };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return { type: "thinking_end", contentIndex: event.contentIndex, content: event.content };
		case "toolcall_start": {
			const block = event.partial.content[event.contentIndex];
			return { type: "toolcall_start", contentIndex: event.contentIndex, id: block?.type === "toolCall" ? block.id : `call_${event.contentIndex}`, toolName: block?.type === "toolCall" ? block.name : "tool" };
		}
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
		case "done":
			return { type: "done", reason: event.reason, usage: event.message.usage, ...(event.message.responseId === undefined ? {} : { responseId: event.message.responseId }) };
		case "error":
			return { type: "error", reason: event.reason, usage: event.error.usage, errorMessage: event.error.errorMessage };
	}
}

/** Encode common assistant events as native pi-messages SSE records. */
export async function* encodeStream(source: GatewayEventSource): AsyncGenerator<string> {
	for await (const event of source) yield sseData(toPiEvent(event));
}
