import { describe, expect, test } from "vitest";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";
import { emptySessionTelemetryReport } from "../../src/runtime/telemetry/local/report.ts";
import type { LocalTelemetryQuery } from "../../src/runtime/telemetry/local/query.ts";
import { TelemetryOverlayComponent } from "../../src/tui/components/telemetry-overlay.ts";

function sessionId(value: string): SessionId {
	return createRuntimeId("session", value);
}

describe("telemetry overlay", () => {
	test("renders the same report in wide and narrow layouts without unsafe fields", async () => {
		const session = sessionId("overlay-layout");
		const report = emptySessionTelemetryReport(session, {
			state: "recording_off",
			reason: "recording_disabled",
			recordingMode: "off",
			generatedAt: "2026-08-25T00:00:00.000Z",
		});
		const query: LocalTelemetryQuery = {
			report: async () => ({ ok: true, report }),
			status: async () => {
				throw new Error("not used");
			},
		};
		const component = new TelemetryOverlayComponent({
			query,
			sessionId: session,
			getViewportHeight: () => 40,
			scheduleRefresh: () => ({ cancel: () => undefined }),
		});

		await component.open();
		const wide = component.render(120).join("\n");
		const narrow = component.render(40).join("\n");
		expect(wide).toContain("Recording: disabled");
		expect(wide).toContain("Traffic");
		expect(wide).toContain("Memory");
		expect(narrow).toContain("Recording: disabled");
		expect(narrow).toContain("Coverage");
		expect(wide).not.toContain("/data2-HDD");
		expect(wide).not.toContain("https://");
	});

	test("renders observed memory peak rather than the sum of periodic samples", async () => {
		const session = sessionId("overlay-peak");
		const base = emptySessionTelemetryReport(session, { state: "available", reason: "sample_failed" });
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
		const component = new TelemetryOverlayComponent({
			query: { report: async () => ({ ok: true, report }), status: async () => { throw new Error("not used"); } },
			sessionId: session,
			getViewportHeight: () => 40,
			scheduleRefresh: () => ({ cancel: () => undefined }),
		});
		await component.open();
		const output = component.render(80).join("\n");
		expect(output).toContain("Owner RSS: peak=120B");
		expect(output).not.toContain("Owner RSS: 220B");
	});

	test("refreshes at most once per scheduled tick and closes with scroll cleanup", async () => {
		const session = sessionId("overlay-refresh");
		const report = emptySessionTelemetryReport(session, {
			state: "recording_off",
			reason: "recording_disabled",
			recordingMode: "off",
		});
		let queries = 0;
		let scheduled: (() => void) | undefined;
		let cancelled = 0;
		let closed = 0;
		const component = new TelemetryOverlayComponent({
			query: {
				report: async () => {
					queries += 1;
					return { ok: true, report };
				},
				status: async () => { throw new Error("not used"); },
			},
			sessionId: session,
			getViewportHeight: () => 4,
			scheduleRefresh: (refresh, intervalMs) => {
				expect(intervalMs).toBe(1_000);
				scheduled = refresh;
				return { cancel: () => { cancelled += 1; } };
			},
			onClose: () => { closed += 1; },
		});

		await component.open();
		expect(queries).toBe(1);
		scheduled?.();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(queries).toBe(2);
		component.handleInput("down");
		component.handleInput("pageDown");
		component.handleInput("escape");
		component.handleInput("escape");
		expect(cancelled).toBe(1);
		expect(closed).toBe(1);
	});
});
