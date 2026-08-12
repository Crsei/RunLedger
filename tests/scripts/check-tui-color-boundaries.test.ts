import { describe, expect, it } from "vitest";
import { findTuiColorBoundaryFailures } from "../../scripts/check-tui-boundaries.ts";

describe("TUI semantic color boundary", () => {
	it("rejects custom RGB foreground and forbidden ANSI names in ordinary UI files", () => {
		expect(findTuiColorBoundaryFailures("src/tui/components/example.ts", `
			const fg = RGBA.fromInts(1, 2, 3);
			const title = blue("title");
		`)).toEqual(expect.arrayContaining([
			expect.stringContaining("RGB foreground"),
			expect.stringContaining("forbidden ANSI foreground"),
		]));
	});

	it("allows only the exact syntax, diff, editor, Mermaid, and safe-SGR projection files", () => {
		for (const path of [
			"src/tui/highlight/contracts.ts",
			"src/tui/highlight/status-style.ts",
			"src/tui/opentui/diff-renderable.ts",
			"src/tui/opentui/ansi-styled-text.ts",
			"src/tui/opentui/mermaid-block-renderable.ts",
			"src/tui/theme/editor-background.ts",
		]) {
			expect(findTuiColorBoundaryFailures(path, "RGBA.fromInts(1, 2, 3)"), path).toEqual([]);
		}
	});

	it("does not whitelist an entire directory or a similarly named file", () => {
		expect(findTuiColorBoundaryFailures("src/tui/opentui/diff-renderable-copy.ts", "RGBA.fromInts(1, 2, 3)"))
			.toEqual([expect.stringContaining("RGB foreground")]);
		expect(findTuiColorBoundaryFailures("src/tui/components/ansi-styled-text.ts", "RGBA.fromInts(1, 2, 3)"))
			.toEqual([expect.stringContaining("RGB foreground")]);
	});
});
