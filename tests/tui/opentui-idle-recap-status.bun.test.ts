import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { StatusComponent } from "../../src/tui/components/status.ts";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";

describe("OpenTUI idle recap status projection", () => {
	test("keeps the transient recap in the footer at standard and wide Unicode widths", async () => {
		for (const width of [80, 143]) {
			const setup = await createTestRenderer({ width, height: 16 });
			const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
				onInput: () => {},
				onResize: () => {},
			});
			try {
				const status = new StatusComponent({});
				status.setIdleRecap("目标 🚀 next action");
				runtime.update({
					body: [{ id: "history", kind: "text", content: "stable transcript" }],
					editorText: "",
					footer: [`\x1b[2m${status.render(width)[0] ?? ""}\x1b[22m`],
				});
				await setup.renderOnce();

				const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
				const editor = setup.renderer.root.findDescendantById("runledger-editor-row");
				const footer = setup.renderer.root.findDescendantById("runledger-footer");
				const frame = setup.captureCharFrame();
				expect(frame).toContain("※ recap: 目标 🚀 next action");
				expect(frame.split("\n").every((line) => stringWidth(stripAnsi(line)) <= width)).toBe(true);
				expect((footer?.y ?? 0)).toBeGreaterThan(editor?.y ?? 0);
				expect(footer?.plainText).toContain("※ recap: 目标 🚀 next action");
				expect(transcript?.getChildren().map((child) => child.plainText).join("\n")).not.toContain("recap:");
			} finally {
				runtime.destroy();
			}
		}
	});
});
