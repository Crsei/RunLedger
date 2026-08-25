/**
 * oneshot LLM 调用插桩单测(移植自 oh-my-pi `agent/test/compaction-telemetry.test.ts`)。
 *
 * 断言 `pi.gen_ai.oneshot.kind` 标签:
 *   - compaction_summary(生产 summarizer 走 instrumentedCompleteSimple)
 *   - auto_title(title lifecycle 走 instrumentedCompleteSimple)
 *   - child_agent(child runtime streamFn 在 streamSimple 层打 span)
 *   - gateway(auth-gateway dispatch 走同一 helper)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { mockModel } from "../../../src/index.ts";
import { createSessionModelStreamFn } from "../../../src/runtime/agents/child-model-runtime.ts";
import { instrumentedCompleteSimple, resolveTelemetry } from "../../../src/runtime/telemetry/telemetry.ts";
import { PiGenAIAttr } from "../../../src/runtime/telemetry/semconv.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { Models } from "../../../src/models.ts";

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
	trace.disable();
	context.disable();
	contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
	exporter.reset();
});

afterAll(async () => {
	await provider.shutdown();
	context.disable();
	trace.disable();
});

function zeroUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function messageFor(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
	return spans.find(s => s.name === name);
}

describe("oneshot kinds", () => {
	it.each([
		["compaction_summary", "compaction_summary"],
		["auto_title", "auto_title"],
		["child_agent", "child_agent"],
		["gateway", "gateway"],
	])("stamps pi.gen_ai.oneshot.kind=%s on the chat span", async (_label, kind) => {
		const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
		const message = messageFor(mockModel, "oneshot result");
		await instrumentedCompleteSimple(mockModel, { messages: [] }, {}, {
			telemetry,
			oneshotKind: kind,
			completeImpl: () => Promise.resolve(message),
		});
		const finished = exporter.getFinishedSpans();
		expect(finished).toHaveLength(1);
		expect(finished[0]!.name).toBe("chat mock-1");
		expect(finished[0]!.attributes[PiGenAIAttr.OneshotKind]).toBe(kind);
		expect(finished[0]!.attributes[PiGenAIAttr.AgentStepNumber]).toBe(-1);
	});
});

describe("child runtime streamFn telemetry", () => {
	it("emits a child_agent chat span for the session streamFn when telemetry is configured", async () => {
		const models = {
			streamSimple: (_model: Model, _context: Context, _options?: SimpleStreamOptions) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = messageFor(mockModel, "child reply");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
		} as unknown as Models;

		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "child-session",
			telemetry: { captureMessageContent: "none" },
			oneshotKind: "child_agent",
		});
		const stream = await streamFn(mockModel, {
			systemPrompt: "child system",
			messages: [{ role: "user", content: "go", timestamp: Date.now() }],
			tools: [],
		}, {});
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		// finishChatSpan 在 result() 之后异步收尾,等一个 macrotask
		await new Promise(resolve => setTimeout(resolve, 10));

		const finished = exporter.getFinishedSpans();
		expect(finished).toHaveLength(1);
		const chat = findSpan(finished, "chat mock-1");
		expect(chat).toBeDefined();
		expect(chat!.attributes[PiGenAIAttr.OneshotKind]).toBe("child_agent");
		expect(chat!.attributes["gen_ai.operation.name"]).toBe("chat");
		expect(chat!.attributes["gen_ai.request.model"]).toBe("mock-1");
	});

	it("emits no span when child streamFn telemetry is unset", async () => {
		const models = {
			streamSimple: (_model: Model, _context: Context, _options?: SimpleStreamOptions) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = messageFor(mockModel, "child reply");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
		} as unknown as Models;

		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "child-session",
		});
		const stream = await streamFn(mockModel, {
			systemPrompt: "child system",
			messages: [{ role: "user", content: "go", timestamp: Date.now() }],
			tools: [],
		}, {});
		await stream.result();
		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("fails the child chat span when the stream errors", async () => {
		const models = {
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const error = messageFor(mockModel, "upstream failed");
					error.stopReason = "error";
					error.errorMessage = "boom";
					stream.push({ type: "start", partial: error });
					stream.push({ type: "error", reason: "error", error });
					stream.end(error);
				});
				return stream;
			},
		} as unknown as Models;

		const streamFn = createSessionModelStreamFn({
			models,
			sessionId: "child-session",
			telemetry: { captureMessageContent: "none" },
			oneshotKind: "child_agent",
		});
		const stream = await streamFn(mockModel, {
			systemPrompt: "child system",
			messages: [{ role: "user", content: "go", timestamp: Date.now() }],
			tools: [],
		}, {});
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		await new Promise(resolve => setTimeout(resolve, 10));
		const finished = exporter.getFinishedSpans();
		expect(finished).toHaveLength(1);
		expect(finished[0]!.status.code).toBe(2); // ERROR
	});
});

describe("instrumentedCompleteSimple request snapshot", () => {
	it("captures available tools, system prompt, and messages from context", async () => {
		const telemetry = resolveTelemetry({ captureMessageContent: "summary" }, "conv");
		let capturedOptions: SimpleStreamOptions | undefined;
		const message = messageFor(mockModel, "summary");
		await instrumentedCompleteSimple(
			mockModel,
			{
				systemPrompt: "summarize",
				messages: [{ role: "user", content: "transcript", timestamp: Date.now() }],
				tools: [{ name: "read", description: "r", parameters: {} as never }],
			},
			{ maxTokens: 256, temperature: 0 },
			{
				telemetry,
				oneshotKind: "compaction_summary",
				completeImpl: (_m, _c, options) => {
					capturedOptions = options;
					return Promise.resolve(message);
				},
			},
		);
		const finished = exporter.getFinishedSpans();
		const chat = findSpan(finished, "chat mock-1");
		expect(chat!.attributes["gen_ai.request.max_tokens"]).toBe(256);
		expect(chat!.attributes["gen_ai.request.temperature"]).toBe(0);
		expect(chat!.attributes["pi.gen_ai.request.available_tools"]).toEqual(["read"]);
		const requestMessages = JSON.parse(chat!.attributes["pi.gen_ai.request.messages"] as string);
		expect(requestMessages).toContainEqual({ role: "system", content: "summarize" });
		expect(requestMessages).toContainEqual({ role: "user", content: "transcript" });
		expect(capturedOptions?.maxTokens).toBe(256);
	});
});
