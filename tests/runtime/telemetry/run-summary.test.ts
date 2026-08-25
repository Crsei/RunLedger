/**
 * run-collector 聚合单测(移植自 oh-my-pi `agent/test/run-summary.test.ts`)。
 *
 * 直接驱动 `AgentRunCollector`(begin/end chat+tool、orphan tool、available tools),
 * 断言 snapshot 的 summary/coverage 形状,以及跨 run 聚合 helper 的元素级求和。
 */

import { describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll } from "vitest";

import {
	AgentRunCollector,
	aggregateAgentRunCoverage,
	aggregateAgentRunSummaries,
	emptyAgentRunCoverage,
	emptyAgentRunSummary,
	ToolCallBlockedError,
} from "../../../src/runtime/telemetry/run-collector.ts";
import { mockModel } from "../../../src/index.ts";
import type { AssistantMessage } from "../../../src/types.ts";

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
	await provider.shutdown();
	exporter.reset();
});

function zeroUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function messageFor(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: mockModel.api,
		provider: mockModel.provider,
		model: mockModel.id,
		usage: zeroUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentRunCollector", () => {
	it("aggregates chats, tools, usage, cost, and errors into a summary", () => {
		const collector = new AgentRunCollector();
		const tracer = trace.getTracer("test");

		const chatSpan1 = tracer.startSpan("chat 1");
		collector.beginChat(chatSpan1, { stepNumber: 0, model: mockModel });
		collector.noteAvailableTools([{ name: "read" }, { name: "write" }]);
		const chat1 = messageFor("stop");
		chat1.usage = {
			input: 10,
			output: 20,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 35,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		collector.endChat(chatSpan1, chat1, { costUsd: 0.001, costUnavailableReason: undefined });

		const chatSpan2 = tracer.startSpan("chat 2");
		collector.beginChat(chatSpan2, { stepNumber: 1, model: mockModel });
		collector.endChat(chatSpan2, messageFor("toolUse"), { costUsd: undefined, costUnavailableReason: "unknown-pricing" });

		const toolSpan = tracer.startSpan("execute_tool read");
		collector.beginTool(toolSpan, { toolCallId: "call-1", toolName: "read" });
		collector.endTool(toolSpan, { status: "ok", errorType: undefined });

		const toolSpan2 = tracer.startSpan("execute_tool write");
		collector.beginTool(toolSpan2, { toolCallId: "call-2", toolName: "write" });
		collector.endTool(toolSpan2, { status: "error", errorType: "ToolError" });

		const snapshot = collector.snapshot({ stepCount: 2 });
		const summary = snapshot.summary;
		const coverage = snapshot.coverage;

		expect(summary.chats.total).toBe(2);
		expect(summary.chats.byStopReason).toEqual({ stop: 1, toolUse: 1 });
		expect(summary.tools.total).toBe(2);
		expect(summary.tools.ok).toBe(1);
		expect(summary.tools.error).toBe(1);
		expect(summary.tools.byName.read).toMatchObject({ total: 1, ok: 1, error: 0 });
		expect(summary.tools.byName.write).toMatchObject({ total: 1, ok: 0, error: 1 });
		expect(summary.usage.inputTokens).toBe(15);
		expect(summary.usage.outputTokens).toBe(20);
		expect(summary.usage.cachedInputTokens).toBe(2);
		expect(summary.usage.cacheWriteTokens).toBe(3);
		expect(summary.usage.totalTokens).toBe(35);
		expect(summary.cost.estimatedUsd).toBeCloseTo(0.001);
		expect(summary.cost.unavailableReasons).toEqual(["unknown-pricing"]);
		expect(summary.errors.total).toBe(1);
		expect(summary.errors.byType).toEqual({ ToolError: 1 });
		expect(summary.stepCount).toBe(2);

		expect(coverage.toolsAvailable).toEqual(["read", "write"]);
		expect(coverage.toolsInvoked).toEqual(["read", "write"]);
		expect(coverage.toolsUnused).toEqual([]);
		expect(coverage.modelsUsed).toEqual(["mock-1"]);
		expect(coverage.providersUsed).toEqual(["mock"]);
	});

	it("records orphan tools (skipped) with zero latency and coverage", () => {
		const collector = new AgentRunCollector();
		collector.recordOrphanTool({ toolCallId: "call-1", toolName: "read", status: "skipped" });
		const { summary, coverage } = collector.snapshot({ stepCount: 1 });
		expect(summary.tools.total).toBe(1);
		expect(summary.tools.skipped).toBe(1);
		expect(summary.tools.totalLatencyMs).toBe(0);
		expect(coverage.toolsInvoked).toEqual(["read"]);
		expect(coverage.toolsAvailable).toEqual([]);
		expect(coverage.toolsUnused).toEqual([]);
	});

	it("keeps coverage stable (sorted, deduped) across repeated notes", () => {
		const collector = new AgentRunCollector();
		collector.noteAvailableTools([{ name: "b" }, { name: "a" }, { name: "b" }]);
		const { coverage } = collector.snapshot({ stepCount: 0 });
		expect(coverage.toolsAvailable).toEqual(["a", "b"]);
	});

	it("markRunEnded is idempotent", () => {
		const collector = new AgentRunCollector();
		expect(collector.runEnded).toBe(false);
		expect(collector.markRunEnded()).toBe(true);
		expect(collector.markRunEnded()).toBe(false);
		expect(collector.runEnded).toBe(true);
	});

	it("failChat records a failed chat with zero usage and error type", () => {
		const collector = new AgentRunCollector();
		const tracer = trace.getTracer("test");
		const span = tracer.startSpan("chat");
		collector.beginChat(span, { stepNumber: 0, model: mockModel });
		collector.failChat(span, { errorType: "ProviderError" });
		const { summary } = collector.snapshot({ stepCount: 1 });
		expect(summary.chats.total).toBe(1);
		expect(summary.chats.byStopReason).toEqual({ error: 1 });
		expect(summary.errors.byType).toEqual({ ProviderError: 1 });
		expect(summary.usage.totalTokens).toBe(0);
	});
});

describe("aggregateAgentRunSummaries", () => {
	it("sums element-wise across runs and merges sets", () => {
		const a: ReturnType<typeof emptyAgentRunSummary> = emptyAgentRunSummary();
		const b: ReturnType<typeof emptyAgentRunSummary> = emptyAgentRunSummary();
		// 用 collector 构造两份真实 summary 再聚合
		const c1 = new AgentRunCollector();
		const c2 = new AgentRunCollector();
		const tracer = trace.getTracer("test");
		const s1 = tracer.startSpan("chat");
		c1.beginChat(s1, { stepNumber: 0, model: mockModel });
		c1.endChat(s1, messageFor("stop"), { costUsd: 0.01, costUnavailableReason: undefined });
		const t1 = tracer.startSpan("tool");
		c1.beginTool(t1, { toolCallId: "c1", toolName: "read" });
		c1.endTool(t1, { status: "ok", errorType: undefined });
		const s2 = tracer.startSpan("chat");
		c2.beginChat(s2, { stepNumber: 0, model: mockModel });
		c2.endChat(s2, messageFor("error"), { costUsd: undefined, costUnavailableReason: "no-rate" });
		const t2 = tracer.startSpan("tool");
		c2.beginTool(t2, { toolCallId: "c2", toolName: "write" });
		c2.endTool(t2, { status: "error", errorType: "ToolError" });

		const agg = aggregateAgentRunSummaries([
			c1.snapshot({ stepCount: 1 }).summary,
			c2.snapshot({ stepCount: 1 }).summary,
		]);
		expect(agg.chats.total).toBe(2);
		expect(agg.chats.byStopReason).toEqual({ stop: 1, error: 1 });
		expect(agg.tools.total).toBe(2);
		expect(agg.tools.ok).toBe(1);
		expect(agg.tools.error).toBe(1);
		expect(agg.tools.byName.read).toBeDefined();
		expect(agg.tools.byName.write).toBeDefined();
		expect(agg.cost.estimatedUsd).toBeCloseTo(0.01);
		expect(agg.cost.unavailableReasons).toEqual(["no-rate"]);
		expect(agg.errors.byType).toEqual({ ToolError: 1, error: 1 });
		expect(agg.stepCount).toBe(2);
		void a;
		void b;
	});

	it("returns empty summary for zero inputs", () => {
		expect(aggregateAgentRunSummaries([])).toBe(emptyAgentRunSummary());
	});

	it("returns the single summary unchanged", () => {
		const c = new AgentRunCollector();
		const summary = c.snapshot({ stepCount: 3 }).summary;
		expect(aggregateAgentRunSummaries([summary])).toBe(summary);
	});
});

describe("aggregateAgentRunCoverage", () => {
	it("union-merges coverage preserving sorted+deduped invariant", () => {
		const c1 = new AgentRunCollector();
		c1.noteAvailableTools([{ name: "read" }, { name: "write" }]);
		const c2 = new AgentRunCollector();
		c2.noteAvailableTools([{ name: "write" }, { name: "bash" }]);
		const coverage = aggregateAgentRunCoverage([c1.snapshot({ stepCount: 0 }).coverage, c2.snapshot({ stepCount: 0 }).coverage]);
		expect(coverage.toolsAvailable).toEqual(["bash", "read", "write"]);
		expect(coverage.toolsUnused).toEqual(["bash", "read", "write"]);
	});

	it("returns empty coverage for zero inputs", () => {
		expect(aggregateAgentRunCoverage([])).toBe(emptyAgentRunCoverage());
	});
});

describe("ToolCallBlockedError", () => {
	it("carries a distinguishable name and message", () => {
		const error = new ToolCallBlockedError("nope");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ToolCallBlockedError");
		expect(error.message).toBe("nope");
		expect(new ToolCallBlockedError().message).toBe("Tool execution was blocked");
	});
});
