import { test, expect, describe } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
	createOpenTuiComponentRuntimeFromRenderer,
	type OpenTuiComponentFrame,
} from "../../src/tui/opentui/component-runtime.ts";

function frame(statusIndicator: NonNullable<OpenTuiComponentFrame["statusIndicator"]>): OpenTuiComponentFrame {
	return {
		body: [{ id: "history", kind: "text", content: "stable transcript" }],
		editorText: "",
		statusIndicator,
		footer: [],
	};
}

describe("OpenTUI S5 status indicator frame", () => {
	test("renders working status above the editor and keeps details bounded", async () => {
		const setup = await createTestRenderer({ width: 72, height: 14 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update(frame({
				indicator: "⠋",
				header: "Working",
				elapsed: "12s",
				interruptKey: "^C",
				details: [
					{ text: "first detail", truncated: false, byteLength: 12 },
					{ text: "second detail", truncated: false, byteLength: 13 },
					{ text: "third detail", truncated: false, byteLength: 12 },
				],
			}));
			await setup.renderOnce();

			const status = setup.renderer.root.findDescendantById("runledger-status-indicator");
			const editor = setup.renderer.root.findDescendantById("runledger-editor-row");
			const captured = setup.captureCharFrame();
			expect(status?.height).toBe(4);
			expect((status?.y ?? 0)).toBeLessThan(editor?.y ?? 0);
			expect(captured).toContain("⠋ Working (12s • ^C to interrupt)");
			expect(captured).toContain("  └ first detail");
			expect(captured).toContain("  └ third detail");
		} finally {
			runtime.destroy();
		}
	});

	test("removes the row after the run ends without rebuilding keyed transcript nodes", async () => {
		const setup = await createTestRenderer({ width: 72, height: 14 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update(frame({ indicator: "⠋", header: "Working", elapsed: "12s", interruptKey: "^C" }));
			await setup.renderOnce();
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			const body = setup.renderer.root.findDescendantById("runledger-block-history");
			const transcriptId = transcript?.num;
			const bodyId = body?.num;

			runtime.update(frame({ indicator: "⠙", header: "Working", elapsed: "13s", interruptKey: "^C" }));
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-transcript")?.num).toBe(transcriptId);
			expect(setup.renderer.root.findDescendantById("runledger-block-history")?.num).toBe(bodyId);

			runtime.update({ body: [{ id: "history", kind: "text", content: "stable transcript" }], editorText: "", footer: [] });
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-status-indicator")?.visible).toBe(false);
			expect(setup.captureCharFrame()).not.toContain("Working");
		} finally {
			runtime.destroy();
		}
	});
});
