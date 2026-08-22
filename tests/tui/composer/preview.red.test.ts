import { describe, expect, it } from "vitest";
import { displayWidth } from "../../../src/tui/mermaid/display-width.ts";
import { composerFrameSignature, projectComposerFrame } from "../../../src/tui/composer/frame.ts";
import { getComposerStyle } from "../../../src/tui/composer/registry.ts";
import { renderComposerShapePreview } from "../../../src/tui/composer/preview.ts";

describe("composer shape preview", () => {
	it("uses the production projector for its preview frame", () => {
		const style = getComposerStyle("claude");
		const preview = renderComposerShapePreview(style, 32);
		const production = projectComposerFrame(style, preview.input);

		expect(composerFrameSignature(preview.frame)).toBe(composerFrameSignature(production));
		for (const line of preview.lines) expect(displayWidth(line)).toBeLessThanOrEqual(32);
	});
});
