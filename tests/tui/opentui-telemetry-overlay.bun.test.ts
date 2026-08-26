import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { emptySessionTelemetryReport } from "../../src/runtime/telemetry/local/report.ts";
import { TelemetryOverlayComponent } from "../../src/tui/components/telemetry-overlay.ts";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";

describe("OpenTUI telemetry overlay", () => {
	test("projects the read-only report into a native overlay frame", async () => {
		const setup = await createTestRenderer({ width: 100, height: 20 });
		const sessionId = createRuntimeId("session", "native-telemetry");
		const report = emptySessionTelemetryReport(sessionId, {
			state: "recording_off",
			reason: "recording_disabled",
			recordingMode: "off",
		});
		const component = new TelemetryOverlayComponent({
			query: {
				report: async () => ({ ok: true, report }),
				status: async () => { throw new Error("not used"); },
			},
			sessionId,
			scheduleRefresh: () => ({ cancel: () => undefined }),
		});
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			await component.open();
			runtime.update({
				body: [],
				editorText: "draft",
				footer: [],
				overlay: component.present(88),
				overlayAnchor: "center",
				overlayNonCapturing: false,
			} as Parameters<typeof runtime.update>[0]);
			await setup.renderOnce();
			expect(setup.captureCharFrame()).toContain("Recording: disabled");
			expect(setup.captureCharFrame()).toContain("Traffic");
		} finally {
			runtime.destroy();
		}
	});
});
