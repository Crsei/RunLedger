import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { SyntaxHighlightService } from "../../src/tui/highlight/service.ts";
import { SyntaxThemeController } from "../../src/tui/highlight/theme-controller.ts";
import { ExecRenderable } from "../../src/tui/opentui/exec-renderable.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";

describe("OpenTUI exec layout", () => {
	test("renders prefixed command/output blocks and preserves width bounds", async () => {
		const setup = await createTestRenderer({ width: 48, height: 14 });
		const service = new SyntaxHighlightService();
		const themeController = new SyntaxThemeController({ availableThemes: ["ansi"], terminalMode: "dark" });
		const block = {
			kind: "exec",
			command: "echo first\necho second\necho third",
			status: "running",
			output: Array.from({ length: 8 }, (_, index) => ({ channel: "stdout" as const, text: `line-${index}` })),
			outputMaxLines: 5,
		} satisfies PresentationBlock;
		const renderable = new ExecRenderable(setup.renderer, {
			id: "exec-layout",
			width: "100%",
			block,
			highlightService: service,
			themeController,
		});
		setup.renderer.root.add(renderable);
		try {
			await setup.renderOnce();
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			expect(frame).toContain("  │ echo second");
			expect(frame).toContain("  └ line-0");
			expect(frame).toContain("Ctrl+T for transcript");
			for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(48);
		} finally {
			renderable.destroyRecursively();
			service.destroy();
		}
	});

	test("updates a failed block in place with the terminal Ran header", async () => {
		const setup = await createTestRenderer({ width: 80, height: 10 });
		const service = new SyntaxHighlightService();
		const themeController = new SyntaxThemeController({ availableThemes: ["ansi"], terminalMode: "dark" });
		const initial = {
			kind: "exec",
			command: "false",
			status: "running",
			output: [],
		} satisfies PresentationBlock;
		const renderable = new ExecRenderable(setup.renderer, {
			id: "exec-failed-layout",
			width: "100%",
			block: initial,
			highlightService: service,
			themeController,
		});
		setup.renderer.root.add(renderable);
		try {
			await setup.renderOnce();
			renderable.updateBlock({ ...initial, status: "failed", exitCode: 7, durationMs: 1_250, background: true });
			await setup.renderOnce();
			expect(renderable.plainText).toContain("• Ran false");
			expect(renderable.plainText).not.toContain("✗ (7) • 1.3s");
			expect(renderable.plainText).toContain("(bg)");
			expect(renderable.plainText).toContain("(no output)");
		} finally {
			renderable.destroyRecursively();
			service.destroy();
		}
	});
});
