import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { rowToBlocks } from "../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../src/tui/timeline/types.ts";

function bounded(text: string) {
	return { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength };
}

describe("OpenTUI Codex notice block", () => {
	test("uses the warning prefix, two-space continuation, and severity styling", async () => {
		const setup = await createTestRenderer({ width: 30, height: 10 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const row: TimelineRow = {
			kind: "notice",
			id: "notice:warning",
			timestamp: "2026-08-14T00:00:00.000Z",
			displayOrder: 0,
			status: "succeeded",
			severity: "warning",
			message: bounded("a warning message that wraps across the notice width"),
		};

		try {
			runtime.update({ body: rowToBlocks(row), editorText: "", footer: [] });
			await setup.renderOnce();
			const notice = setup.renderer.root.findDescendantById("runledger-block-timeline-notice-warning");
			expect(notice).toBeDefined();
			expect(notice?.plainText).toContain("⚠ warning: ");
			expect(notice?.plainText.split("\n").some((line) => line.startsWith("  "))).toBe(true);
			expect(notice?.content.chunks.find((chunk) => chunk.text.includes("⚠"))?.fg?.slot).toBe(3);
		} finally {
			runtime.destroy();
		}
	});
});
