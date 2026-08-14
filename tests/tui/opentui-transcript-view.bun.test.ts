import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
	createOpenTuiComponentRuntimeFromRenderer,
	type OpenTuiComponentFrame,
} from "../../src/tui/opentui/component-runtime.ts";

type TranscriptFrame = OpenTuiComponentFrame & { readonly overlayVariant?: "transcript" };

describe("OpenTUI transcript overlay", () => {
	test("uses a full-screen read-only surface without changing the main transcript scroll position", async () => {
		const setup = await createTestRenderer({ width: 60, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update({
				body: Array.from({ length: 80 }, (_, index) => ({
					id: `history-${index}`,
					kind: "text" as const,
					content: `history ${index}`,
				})),
				editorText: "draft",
				footer: [],
			} satisfies OpenTuiComponentFrame);
			await setup.renderOnce();
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			expect(transcript).toBeDefined();
			if (!transcript) return;
			transcript.scrollTop = 7;
			await setup.renderOnce();

			runtime.update({
				body: Array.from({ length: 80 }, (_, index) => ({
					id: `history-${index}`,
					kind: "text" as const,
					content: `history ${index}`,
				})),
				editorText: "draft",
				footer: [],
				overlay: ["full transcript"],
				overlayVariant: "transcript",
			} as TranscriptFrame as OpenTuiComponentFrame);
			await setup.renderOnce();

			const overlay = setup.renderer.root.findDescendantById("runledger-overlay") as {
				readonly left?: number;
				readonly top?: number;
				readonly bottom?: number;
				readonly width?: number;
				readonly border?: boolean;
			} | undefined;
			expect(overlay?.left).toBe(0);
			expect(overlay?.top).toBe(0);
			expect(overlay?.bottom).toBe(0);
			expect(overlay?.width).toBe(60);
			expect(overlay?.border).toBe(false);
			expect(transcript.scrollTop).toBe(7);
			expect(setup.captureCharFrame()).toContain("full transcript");
		} finally {
			runtime.destroy();
		}
	});
});
