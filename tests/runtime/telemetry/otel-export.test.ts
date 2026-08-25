/**
 * OTLP 导出引导单测:signal 判定矩阵、SDK 禁用 no-op、log level 过滤、
 * metrics 记录(AgentMetricRecorder + InMemoryMetricReader)。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { metrics } from "@opentelemetry/api";

import {
	AgentMetricRecorder,
	createTelemetryExportConfig,
	initTelemetryExport,
	isTelemetryExportEnabled,
	parseOtelLogLevel,
	resolveSignalConfig,
	shutdownTelemetryExport,
	signalEnabled,
	type SignalConfig,
} from "../../../src/runtime/telemetry/otel-export.ts";
import type { ChatUsageEvent } from "../../../src/runtime/telemetry/telemetry.ts";
import type { AgentRunCoverage, AgentRunSummary } from "../../../src/runtime/telemetry/run-collector.ts";
import { emptyAgentRunCoverage, emptyAgentRunSummary } from "../../../src/runtime/telemetry/run-collector.ts";

const ENV_KEYS = [
	"OTEL_SDK_DISABLED",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_LOG_LEVEL",
] as const;

function withEnv(env: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of ENV_KEYS) previous.set(key, process.env[key]);
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		Object.assign(process.env, env);
		return Promise.resolve(fn());
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

afterEach(() => {
	void shutdownTelemetryExport();
});

describe("signalEnabled matrix", () => {
	it("enables a signal only when an endpoint is set", () => {
		expect(signalEnabled("trace", undefined, undefined, undefined)).toBe(false);
		expect(signalEnabled("trace", "http://localhost:4318/v1/traces", undefined, undefined)).toBe(true);
	});

	it("disables when the signal exporter selection is none", () => {
		expect(signalEnabled("trace", "http://localhost:4318", "none", undefined)).toBe(false);
		expect(signalEnabled("trace", "http://localhost:4318", "otlp,none", undefined)).toBe(false);
	});

	it("disables non-http/protobuf protocols with a warning", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(signalEnabled("trace", "http://localhost:4318", undefined, "grpc")).toBe(false);
			expect(signalEnabled("trace", "http://localhost:4318", undefined, "http/json")).toBe(false);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("accepts http/protobuf and falls back to the shared protocol var", () => {
		expect(signalEnabled("trace", "http://localhost:4318", undefined, "http/protobuf")).toBe(true);
		expect(signalEnabled("log", "http://localhost:4318", undefined, "http/protobuf")).toBe(true);
	});

	it("resolveSignalConfig reads per-signal endpoint fallback from the shared endpoint", () => {
		withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, () => {
			const config: SignalConfig = resolveSignalConfig();
			expect(config.trace).toBe(true);
			expect(config.log).toBe(true);
			expect(config.metric).toBe(true);
		});
	});

	it("per-signal protocol overrides the shared protocol", () => {
		withEnv(
			{
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
				OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
				OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
			},
			() => {
				const config: SignalConfig = resolveSignalConfig();
				expect(config.trace).toBe(true);
				expect(config.log).toBe(false);
				expect(config.metric).toBe(false);
			},
		);
	});
});

describe("initTelemetryExport", () => {
	it("is a no-op without any endpoint", async () => {
		await withEnv({}, async () => {
			await initTelemetryExport();
			expect(isTelemetryExportEnabled()).toBe(false);
		});
	});

	it("is a no-op when OTEL_SDK_DISABLED=true even with an endpoint", async () => {
		await withEnv(
			{
				OTEL_SDK_DISABLED: "true",
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
			},
			async () => {
				await initTelemetryExport();
				expect(isTelemetryExportEnabled()).toBe(false);
			},
		);
	});

	it("registers providers and enables the export config merge when an endpoint is set", async () => {
		await withEnv(
			{
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
				OTEL_TRACES_EXPORTER: "otlp",
			},
			async () => {
				await initTelemetryExport();
				expect(isTelemetryExportEnabled()).toBe(true);
				const merged = createTelemetryExportConfig({ captureMessageContent: "none" });
				expect(merged?.captureMessageContent).toBe("none");
				expect(typeof merged?.onChatUsage).toBe("function");
				expect(typeof merged?.onRunEnd).toBe("function");
				expect(typeof merged?.onTelemetryWarning).toBe("function");
			},
		);
	});

	it("createTelemetryExportConfig passes the config through unchanged when disabled", async () => {
		await withEnv({}, async () => {
			const config = { captureMessageContent: "summary" as const };
			expect(createTelemetryExportConfig(config)).toBe(config);
			expect(createTelemetryExportConfig(undefined)).toBeUndefined();
		});
	});
});

describe("parseOtelLogLevel", () => {
	it("defaults to info and maps aliases", () => {
		expect(parseOtelLogLevel(undefined)).toBe("info");
		expect(parseOtelLogLevel("none")).toBe("none");
		expect(parseOtelLogLevel("error")).toBe("error");
		expect(parseOtelLogLevel("warn")).toBe("warn");
		expect(parseOtelLogLevel("WARNING")).toBe("warn");
		expect(parseOtelLogLevel("debug")).toBe("debug");
		expect(parseOtelLogLevel("garbage")).toBe("info");
	});
});

describe("AgentMetricRecorder", () => {
	it("records token usage histograms, chat cost, run counters, and tool counters", async () => {
		const exporter = new InMemoryMetricExporter();
		const reader = new PeriodicExportingMetricReader({ exporter });
		const provider = new MeterProvider({ readers: [reader] });
		metrics.setGlobalMeterProvider(provider);
		const recorder = new AgentMetricRecorder(metrics.getMeter("test"));

		const usageEvent: ChatUsageEvent = {
			span: undefined as never,
			agent: { id: "a1", name: "agent" },
			conversationId: "conv",
			stepNumber: 0,
			model: "mock-1",
			provider: "mock",
			serviceTier: undefined,
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cachedInputTokens: 10,
				cacheWriteTokens: 5,
				reasoningOutputTokens: 3,
			},
			cost: { usd: 0.002 },
			attributes: undefined,
			headers: undefined,
		};
		recorder.recordChatUsage(usageEvent);

		const summary: AgentRunSummary = {
			...emptyAgentRunSummary(),
			stepCount: 3,
			chats: { total: 2, byStopReason: { stop: 2 }, totalLatencyMs: 120 },
			tools: {
				total: 1,
				ok: 1,
				error: 0,
				skipped: 0,
				blocked: 0,
				timeout: 0,
				aborted: 0,
				totalLatencyMs: 30,
				byName: { read: { total: 1, ok: 1, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 30 } },
			},
		};
		const coverage: AgentRunCoverage = {
			...emptyAgentRunCoverage(),
			modelsUsed: ["mock-1"],
			providersUsed: ["mock"],
			toolsAvailable: ["read"],
			toolsInvoked: ["read"],
		};
		summary.errors = { total: 1, byType: { ToolError: 1 } };
		recorder.recordRun(summary, coverage);

		await reader.forceFlush();
		const [resourceMetrics] = exporter.getMetrics();
		const scope = resourceMetrics!.scopeMetrics[0]!;
		const names = scope.metrics.map(m => m.descriptor.name).sort();
		expect(names).toContain("gen_ai.client.token.usage");
		expect(names).toContain("pi.omp.agent.chat.cost.estimated_usd");
		expect(names).toContain("pi.omp.agent.runs");
		expect(names).toContain("pi.omp.agent.steps");
		expect(names).toContain("pi.omp.agent.chat.calls");
		expect(names).toContain("pi.omp.agent.chat.duration");
		expect(names).toContain("pi.omp.agent.tool.calls");
		expect(names).toContain("pi.omp.agent.tool.duration");
		expect(names).toContain("pi.omp.agent.errors");
		expect(names).not.toContain("pi.omp.agent.errors.typo");

		// token histogram: input 100 / output 50 / total 150 / cache 10 / cache_write 5 / reasoning 3
		const tokenMetric = scope.metrics.find(m => m.descriptor.name === "gen_ai.client.token.usage")!;
		const dataPoints = (tokenMetric as { dataPoints?: unknown[] }).dataPoints!;
		expect(dataPoints).toHaveLength(6);

		// run counters
		const runsMetric = scope.metrics.find(m => m.descriptor.name === "pi.omp.agent.runs")!;
		const runPoint = (runsMetric as { dataPoints: { value: number }[] }).dataPoints[0]!;
		expect(runPoint.value).toBe(1);

		const stepsMetric = scope.metrics.find(m => m.descriptor.name === "pi.omp.agent.steps")!;
		const stepPoint = (stepsMetric as { dataPoints: { value: number }[] }).dataPoints[0]!;
		expect(stepPoint.value).toBe(3);

		await provider.shutdown();
	});
});
