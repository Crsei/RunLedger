import { describe, expect, test } from "vitest";
import { emptySessionTelemetryReport } from "../../src/runtime/telemetry/local/report.ts";
import type { TelemetryStatusReport } from "../../src/runtime/telemetry/local/query.ts";
import {
	parseTelemetryArgs,
	renderTelemetryReport,
	renderTelemetryStatus,
} from "../../src/cli/telemetry.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

describe("telemetry CLI contract", () => {
	test("parses latest JSON and rejects ambiguous selectors", () => {
		expect(parseTelemetryArgs(["report", "--latest", "--format", "json"])).toEqual({
			ok: true,
			command: { kind: "report", selector: { latest: true }, format: "json" },
		});
		expect(parseTelemetryArgs(["report", "--latest", "--session", "session_x"])).toMatchObject({ ok: false, code: "selector_conflict" });
		expect(parseTelemetryArgs(["report", "--format", "xml"])).toMatchObject({ ok: false, code: "invalid_format" });
	});

	test("table and JSON renderers consume identical totals and availability", () => {
		const report = emptySessionTelemetryReport(createRuntimeId("session", "cli"), {
			state: "recording_off",
			reason: "recording_disabled",
			recordingMode: "off",
			generatedAt: "2026-08-25T00:00:00.000Z",
		});
		const json = renderTelemetryReport(report, "json");
		const parsed = JSON.parse(json) as typeof report;
		const table = renderTelemetryReport(report, "table");
		expect(parsed.traffic.llmHttp.tx.sum).toEqual(report.traffic.llmHttp.tx.sum);
		expect(table).toContain("recording_off");
		expect(table).toContain("unavailable");
		expect(table).not.toContain("/data2-HDD");
	});

	test("renders observed memory peak instead of adding periodic samples", () => {
		const base = emptySessionTelemetryReport(createRuntimeId("session", "cli-peak"), {
			state: "available",
			reason: "sample_failed",
		});
		const report = {
			...base,
			memory: {
				...base.memory,
				runtimeRssBytes: {
					sum: { availability: "available" as const, unit: "bytes" as const, value: 220, accuracy: "sampled" as const, source: "runtime_meter" as const },
					peak: { availability: "available" as const, unit: "bytes" as const, value: 120, accuracy: "sampled" as const, source: "runtime_meter" as const },
					sampleCount: 2,
					firstObservedAt: "2026-08-25T00:00:00.000Z",
					lastObservedAt: "2026-08-25T00:00:02.000Z",
				},
			},
		};
		const table = renderTelemetryReport(report, "table");
		expect(table).toContain("Owner RSS: peak=120B");
		expect(table).not.toContain("Owner RSS: value=220B");
	});

	test("status renderer omits endpoint and local storage path", () => {
		const status: TelemetryStatusReport = {
			format: "runledger.telemetry.status",
			recording: { mode: "events", failurePolicy: "best_effort" },
			localStore: { state: "readable" },
			transportCoverage: [{ transport: "llm_http", state: "declared", owner: "provider-fetch-router", boundary: "fetch" }],
			memory: { runtime: "available", managedProcessTree: "platform_unsupported" },
			otelExporter: { state: "configured" },
		};
		const output = renderTelemetryStatus(status, "table");
		expect(output).toContain("events");
		expect(output).toContain("platform_unsupported");
		expect(output).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
		expect(output).not.toContain("/tmp/");
	});
});
