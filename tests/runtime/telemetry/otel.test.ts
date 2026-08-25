/**
 * agent-loop OpenTelemetry 插桩单测(移植自 oh-my-pi `agent/test/otel.test.ts`)。
 *
 * 用 InMemorySpanExporter 同步捕获 span,断言 span 名 / 属性 / 父子关系 /
 * 状态码 / 生命周期 hook 分发。mock streamFn 替代 pi mock provider。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { echoTool, mockModel, mockStreamFn } from "../../../src/index.ts";
import { runAgentLoop } from "../../../src/runtime/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "../../../src/runtime/types.ts";
import type { AssistantMessage, Model } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import {
	classifyGatewayResponseCacheStatus,
	detectGatewayFromHeaders,
	type AgentTelemetryConfig,
	type ChatUsageEvent,
	recordHandoff,
	recordManualChatTelemetry,
	resolveTelemetry,
	type TelemetryHookContext,
	instrumentedCompleteSimple,
	recordTelemetryWarning,
} from "../../../src/runtime/telemetry/telemetry.ts";
import { GenAIAttr, GenAIOperation, OpenAIAttr, PiGenAIAttr } from "../../../src/runtime/telemetry/semconv.ts";
import type { StreamFn } from "../../../src/runtime/types.ts";
import type { Context, SimpleStreamOptions } from "../../../src/types.ts";

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

function messageFor(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	usage: AssistantMessage["usage"] = zeroUsage(),
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

/** 单轮(不触发工具)的 streamFn:直接产出最终 assistant 消息。 */
function singleTurnStreamFn(message: AssistantMessage): StreamFn {
	return (_model, _context, _options) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

async function runLoop(
	config: Partial<AgentLoopConfig>,
	ctx: Partial<AgentContext> = {},
	streamFn: StreamFn = mockStreamFn,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const context: AgentContext = {
		systemPrompt: "system",
		messages: [],
		tools: [echoTool],
		...ctx,
	};
	await runAgentLoop(
		[{ role: "user", content: [{ type: "text", text: "hi" }] }],
		context,
		{ model: mockModel, ...config },
		(event) => {
			events.push(event);
		},
		undefined,
		streamFn,
	);
	return events;
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
	return spans.find(s => s.name === name);
}

describe("agent-loop OTEL instrumentation", () => {
	it("emits no spans when telemetry is unset (zero-cost path)", async () => {
		await runLoop({});
		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("emits invoke_agent → chat hierarchy with OTEL and pi.gen_ai extension attributes", async () => {
		const message = messageFor(mockModel, [{ type: "text", text: "hello" }], "stop", {
			input: 12,
			output: 34,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 58,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			reasoning: 11,
		});
		await runLoop(
			{
				telemetry: {
					agent: { id: "agent-1", name: "researcher", description: "test-agent" },
					conversationId: "conv-42",
					captureMessageContent: "none",
				},
			},
			{},
			singleTurnStreamFn(message),
		);

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent researcher");
		const chat = findSpan(finished, "chat mock-1");
		expect(invoke).toBeDefined();
		expect(chat).toBeDefined();
		expect(chat?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);

		// invoke_agent envelope
		expect(invoke?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.InvokeAgent);
		expect(invoke?.attributes[GenAIAttr.AgentId]).toBe("agent-1");
		expect(invoke?.attributes[GenAIAttr.AgentName]).toBe("researcher");
		expect(invoke?.attributes[GenAIAttr.AgentDescription]).toBe("test-agent");
		expect(invoke?.attributes[GenAIAttr.ConversationId]).toBe("conv-42");
		expect(invoke?.attributes[PiGenAIAttr.AgentStepCount]).toBe(1);

		// chat envelope
		expect(chat?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Chat);
		expect(chat?.attributes[GenAIAttr.ProviderName]).toBe("mock");
		expect(chat?.attributes[GenAIAttr.RequestModel]).toBe("mock-1");
		expect(chat?.attributes[PiGenAIAttr.AgentStepNumber]).toBe(0);
		expect(chat?.attributes[GenAIAttr.RequestStream]).toBe(true);
		expect(chat?.attributes[GenAIAttr.OutputType]).toBe("text");

		// response + usage
		expect(chat?.attributes[GenAIAttr.ResponseModel]).toBe("mock-1");
		expect(chat?.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["stop"]);
		expect(chat?.attributes[GenAIAttr.UsageInputTokens]).toBe(24); // input + cacheRead + cacheWrite
		expect(chat?.attributes[GenAIAttr.UsageOutputTokens]).toBe(34);
		expect(chat?.attributes[GenAIAttr.UsageCacheReadInputTokens]).toBe(5);
		expect(chat?.attributes[GenAIAttr.UsageCacheCreationInputTokens]).toBe(7);
		expect(chat?.attributes[GenAIAttr.UsageReasoningOutputTokens]).toBe(11);
		expect(chat?.attributes[PiGenAIAttr.UsageTotalTokens]).toBe(58);

		// content capture none → 无正文属性
		expect(chat?.attributes[PiGenAIAttr.RequestMessages]).toBeUndefined();
		expect(chat?.attributes[PiGenAIAttr.ResponseText]).toBeUndefined();
		expect(chat?.attributes[GenAIAttr.InputMessages]).toBeUndefined();
		expect(chat?.attributes[GenAIAttr.OutputMessages]).toBeUndefined();
	});

	it("emits execute_tool span under invoke_agent with terminal status", async () => {
		// mockStreamFn:首轮 text + echo toolCall(toolUse),第二轮 stop。
		await runLoop({ telemetry: { captureMessageContent: "none" } });

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent");
		const chat = findSpan(finished, "chat mock-1");
		const tool = findSpan(finished, "execute_tool echo");
		expect(invoke).toBeDefined();
		expect(chat).toBeDefined();
		expect(tool).toBeDefined();
		expect(tool?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);

		expect(tool?.attributes[GenAIAttr.ToolName]).toBe("echo");
		expect(tool?.attributes[GenAIAttr.ToolCallId]).toBeTypeOf("string");
		expect(tool?.attributes[GenAIAttr.ToolType]).toBe("function");
		expect(tool?.attributes[GenAIAttr.ToolDescription]).toBe(echoTool.description);
		expect(tool?.attributes[PiGenAIAttr.ToolStatus]).toBe("ok");
		expect(tool?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	it("marks failed chat spans with ERROR status and recordException", async () => {
		const failing: StreamFn = (_model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const error = messageFor(mockModel, [], "error");
				error.errorMessage = "boom";
				stream.push({ type: "start", partial: error });
				stream.push({ type: "error", reason: "error", error });
				stream.end(error);
			});
			return stream;
		};
		await runLoop({ telemetry: { captureMessageContent: "none" } }, {}, failing);

		const finished = exporter.getFinishedSpans();
		const chat = findSpan(finished, "chat mock-1");
		expect(chat).toBeDefined();
		expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
		expect(chat?.attributes[GenAIAttr.ErrorType]).toBe("error");
		expect(chat?.attributes[PiGenAIAttr.AgentStepCount]).toBeUndefined();
		// invoke_agent span 仍在,step count 记 1
		const invoke = findSpan(finished, "invoke_agent");
		expect(invoke?.attributes[PiGenAIAttr.AgentStepCount]).toBe(1);
	});

	describe("content capture", () => {
		const requestCtx: Partial<AgentContext> = {
			systemPrompt: "system prompt text",
			tools: [echoTool],
		};

		it("summary emits bounded summaries, not full payloads", async () => {
			const message = messageFor(mockModel, [{ type: "text", text: "response text" }], "stop");
			await runLoop(
				{ telemetry: { captureMessageContent: "summary" } },
				requestCtx,
				singleTurnStreamFn(message),
			);
			const chat = findSpan(exporter.getFinishedSpans(), "chat mock-1");
			const requestMessages = chat?.attributes[PiGenAIAttr.RequestMessages];
			expect(requestMessages).toBeTypeOf("string");
			expect(JSON.parse(requestMessages as string)).toEqual([
				{ role: "system", content: "system prompt text" },
				{ role: "user", content: [{ type: "text", text: "hi" }] },
			]);
			expect(chat?.attributes[PiGenAIAttr.ResponseText]).toBeTypeOf("string");
			expect(JSON.parse(chat?.attributes[PiGenAIAttr.ResponseText] as string)).toEqual(["response text"]);
			// summary 不发 full payload
			expect(chat?.attributes[GenAIAttr.InputMessages]).toBeUndefined();
			expect(chat?.attributes[GenAIAttr.OutputMessages]).toBeUndefined();
		});

		it("full emits both summaries and OTEL message payloads", async () => {
			const message = messageFor(mockModel, [{ type: "text", text: "response text" }], "stop");
			await runLoop({ telemetry: { captureMessageContent: "full" } }, requestCtx, singleTurnStreamFn(message));
			const chat = findSpan(exporter.getFinishedSpans(), "chat mock-1");
			expect(chat?.attributes[GenAIAttr.SystemInstructions]).toBeTypeOf("string");
			expect(chat?.attributes[GenAIAttr.InputMessages]).toBeTypeOf("string");
			expect(chat?.attributes[GenAIAttr.OutputMessages]).toBeTypeOf("string");
			expect(chat?.attributes[PiGenAIAttr.RequestMessages]).toBeTypeOf("string");
			expect(chat?.attributes[PiGenAIAttr.ResponseText]).toBeTypeOf("string");
		});

		it("respects OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=summary default", async () => {
			// 本测试必须是本文件第一个不带显式 capture 的 resolveTelemetry 调用,
			// 因为 env 解析结果在模块级缓存。
			process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "summary";
			try {
				const telemetry = resolveTelemetry({}, "session");
				expect(telemetry?.contentCapture).toBe("summary");
				expect(telemetry?.captureMessageContent).toBe(false);
			} finally {
				delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
			}
		});
	});

	describe("lifecycle hooks", () => {
		it("fires onSpanStart / onSpanEnd / onRunEnd and swallows hook failures", async () => {
			const started: TelemetryHookContext[] = [];
			const ended: TelemetryHookContext[] = [];
			let runEnded: unknown;
			const warnings: string[] = [];
			await runLoop({
				telemetry: {
					captureMessageContent: "none",
					onSpanStart: ctx => {
						started.push(ctx);
					},
					onSpanEnd: ctx => {
						ended.push(ctx);
						throw new Error("hook boom"); // 非致命
					},
					onRunEnd: (summary, coverage) => {
						runEnded = { summary, coverage };
					},
					onTelemetryWarning: warning => {
						warnings.push(warning.code);
					},
				},
			});

			expect(started.some(ctx => ctx.kind === "invoke_agent")).toBe(true);
			expect(started.some(ctx => ctx.kind === "chat")).toBe(true);
			expect(started.some(ctx => ctx.kind === "execute_tool")).toBe(true);
			expect(ended.length).toBeGreaterThan(0);
			expect(warnings).toContain("on_span_end_failed");
			expect(runEnded).toBeDefined();
			const summary = (runEnded as { summary: { chats: { total: number }; tools: { ok: number }; stepCount: number } }).summary;
			// mockStreamFn:phase0 文本+toolUse,phase1 继续 3 轮 toolUse,phase2 stop
			expect(summary.chats.total).toBe(5);
			expect(summary.tools.ok).toBe(4);
			expect(summary.stepCount).toBe(5);
		});
	});

	describe("manual helpers", () => {
		it("recordHandoff emits a handoff span between named agents", () => {
			const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
			recordHandoff(telemetry, {
				fromAgent: { id: "a1", name: "researcher" },
				toAgent: { id: "a2", name: "coder" },
			});
			const spans = exporter.getFinishedSpans();
			expect(spans).toHaveLength(1);
			const span = spans[0]!;
			expect(span.name).toBe("handoff researcher → coder");
			expect(span.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Handoff);
			expect(span.attributes[PiGenAIAttr.HandoffFromAgentName]).toBe("researcher");
			expect(span.attributes[PiGenAIAttr.HandoffFromAgentId]).toBe("a1");
			expect(span.attributes[PiGenAIAttr.HandoffToAgentName]).toBe("coder");
			expect(span.attributes[PiGenAIAttr.HandoffToAgentId]).toBe("a2");
		});

		it("recordManualChatTelemetry records response/usage/cost on a chat span", async () => {
			const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
			const usage = zeroUsage();
			const span = await recordManualChatTelemetry(telemetry, {
				model: mockModel,
				usage,
				finishReason: "stop",
				responseId: "resp-1",
				responseText: "manual reply",
			});
			expect(span).toBeDefined();
			const finished = exporter.getFinishedSpans();
			expect(finished).toHaveLength(1);
			expect(finished[0]!.name).toBe("chat mock-1");
			expect(finished[0]!.attributes[GenAIAttr.ResponseId]).toBe("resp-1");
			expect(finished[0]!.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["stop"]);
			expect(JSON.parse(finished[0]!.attributes[PiGenAIAttr.ResponseText] as string)).toEqual(["manual reply"]);
		});
	});

	describe("instrumentedCompleteSimple", () => {
		it("wraps completeImpl with a chat span tagged with oneshot kind", async () => {
			const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
			const called: string[] = [];
			const message = messageFor(mockModel, [{ type: "text", text: "summary" }], "stop");
			const result = await instrumentedCompleteSimple(mockModel, { messages: [] }, {}, {
				telemetry,
				oneshotKind: "compaction_summary",
				completeImpl: (_m, _c, _o) => {
					called.push("complete");
					return Promise.resolve(message);
				},
			});
			expect(result).toBe(message);
			expect(called).toEqual(["complete"]);
			const finished = exporter.getFinishedSpans();
			expect(finished).toHaveLength(1);
			expect(finished[0]!.name).toBe("chat mock-1");
			expect(finished[0]!.attributes[PiGenAIAttr.OneshotKind]).toBe("compaction_summary");
		});

		it("fails the span when completeImpl throws", async () => {
			const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
			await expect(
				instrumentedCompleteSimple(mockModel, { messages: [] }, {}, {
					telemetry,
					oneshotKind: "gateway",
					completeImpl: () => Promise.reject(new Error("upstream failed")),
				}),
			).rejects.toThrow("upstream failed");
			const finished = exporter.getFinishedSpans();
			expect(finished).toHaveLength(1);
			expect(finished[0]!.status.code).toBe(SpanStatusCode.ERROR);
			expect(finished[0]!.attributes[GenAIAttr.ErrorType]).toBe("Error");
		});

		it("short-circuits (no span) when telemetry is undefined", async () => {
			const called: string[] = [];
			const message = messageFor(mockModel, [{ type: "text", text: "x" }], "stop");
			await instrumentedCompleteSimple(mockModel, { messages: [] }, {}, {
				telemetry: undefined,
				oneshotKind: "compaction_summary",
				completeImpl: () => {
					called.push("complete");
					return Promise.resolve(message);
				},
			});
			expect(called).toEqual(["complete"]);
			expect(exporter.getFinishedSpans()).toHaveLength(0);
		});
	});

	describe("gateway detection", () => {
		it("detects LiteLLM from headers", () => {
			const detected = detectGatewayFromHeaders({ "x-litellm-call-id": "call-1", "x-litellm-model-id": "upstream-7b" });
			expect(detected).toEqual({ name: "litellm", callId: "call-1", routedTo: "upstream-7b" });
		});

		it("returns undefined for non-gateway traffic", () => {
			expect(detectGatewayFromHeaders({ "content-type": "text/event-stream" })).toBeUndefined();
		});

		it("classifies Cloudflare response-cache status", () => {
			expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "HIT" })).toBe("hit");
			expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "miss" })).toBe("miss");
			expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "BY-PASS" })).toBe("unknown");
			expect(classifyGatewayResponseCacheStatus({})).toBeUndefined();
		});

		it("stamps gateway attributes on the chat span from response headers", async () => {
			const telemetry = resolveTelemetry({ captureMessageContent: "none" }, "conv");
			const message = messageFor(mockModel, [{ type: "text", text: "via gateway" }], "stop");
			const span = await recordManualChatTelemetry(telemetry, {
				model: mockModel,
				usage: zeroUsage(),
				finishReason: "stop",
				responseHeaders: { "x-litellm-call-id": "call-9", "cf-aig-cache-status": "HIT" },
			});
			expect(span).toBeDefined();
			const finished = exporter.getFinishedSpans();
			expect(finished[0]!.attributes[PiGenAIAttr.GatewayName]).toBe("litellm");
			expect(finished[0]!.attributes[PiGenAIAttr.GatewayCallId]).toBe("call-9");
			expect(finished[0]!.attributes[PiGenAIAttr.GatewayResponseCacheStatus]).toBe("hit");
			void message;
		});
	});

	describe("warnings", () => {
		it("recordTelemetryWarning routes to onTelemetryWarning hook", () => {
			const warnings: string[] = [];
			const telemetry = resolveTelemetry({ onTelemetryWarning: w => warnings.push(w.code) }, "conv");
			recordTelemetryWarning(telemetry, { code: "cost_estimator_failed", message: "boom" });
			expect(warnings).toEqual(["cost_estimator_failed"]);
		});

		it("fallback console.warn when no hook", () => {
			const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				recordTelemetryWarning(undefined, { code: "cost_estimator_failed", message: "boom" });
				expect(spy).toHaveBeenCalledWith("[runledger] boom");
			} finally {
				spy.mockRestore();
			}
		});
	});

	it("service tier attribute only when provider supports it", async () => {
		const message = messageFor(mockModel, [{ type: "text", text: "x" }], "stop");
		// mock provider 不是 openai/google 系列 → 不发 service tier
		await runLoop(
			{
				telemetry: { captureMessageContent: "none" },
			},
			{},
			singleTurnStreamFn(message),
		);
		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-1");
		expect(chat?.attributes[OpenAIAttr.RequestServiceTier]).toBeUndefined();
	});

	it("fires onChatUsage per chat step with usage snapshot", async () => {
		const usageEvents: ChatUsageEvent[] = [];
		const message = messageFor(mockModel, [{ type: "text", text: "x" }], "stop", {
			input: 10,
			output: 20,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 35,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		await runLoop(
			{ telemetry: { captureMessageContent: "none", onChatUsage: event => void usageEvents.push(event) } },
			{},
			singleTurnStreamFn(message),
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]!.usage.inputTokens).toBe(15);
		expect(usageEvents[0]!.usage.outputTokens).toBe(20);
		expect(usageEvents[0]!.usage.totalTokens).toBe(35);
		expect(usageEvents[0]!.provider).toBe("mock");
	});
});
