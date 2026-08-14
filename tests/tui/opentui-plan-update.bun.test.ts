import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import stringWidth from "string-width";
import { PlanUpdateRenderable } from "../../src/tui/opentui/plan-update-renderable.ts";
import type { PlanUpdateBlock } from "../../src/tui/presentation.ts";

const block: PlanUpdateBlock = {
	id: "plan-1",
	kind: "plan-update",
	explanation: { text: "A compact explanation that must wrap safely", truncated: false, byteLength: 43 },
	steps: [
		{ text: { text: "completed step", truncated: false, byteLength: 14 }, status: "completed" },
		{ text: { text: "active step", truncated: false, byteLength: 11 }, status: "in-progress" },
		{ text: { text: "pending step", truncated: false, byteLength: 12 }, status: "pending" },
	],
};

describe("OpenTUI plan-update renderable", () => {
	test("renders Codex glyphs, status attributes, prefix indentation, and width-safe wrapping", async () => {
		const setup = await createTestRenderer({ width: 32, height: 14 });
		const renderable = new PlanUpdateRenderable(setup.renderer, {
			id: "plan-update-renderable",
			width: "100%",
			block,
		});
		setup.renderer.root.add(renderable);
		try {
			await setup.renderOnce();
			await setup.renderOnce();
			expect(renderable.plainText).toContain("pending step");
			expect(renderable.height).toBeGreaterThanOrEqual(6);
			const frame = setup.captureCharFrame();
			const lines = frame.split("\n").filter((line) => line.trim().length > 0);
			expect(frame).toContain("• Updated Plan");
			expect(frame).toContain("✔ completed step");
			expect(frame).toContain("□ active step");
			expect(frame).toContain("□ pending step");
			expect(lines.find((line) => stringWidth(line.trimEnd()) > 32)).toBeUndefined();
			expect(lines.some((line) => line.startsWith("    "))).toBe(true);

			const completed = renderable.content.chunks.find((chunk) => chunk.text.includes("✔"));
			const active = renderable.content.chunks.find((chunk) => chunk.text.includes("□"));
			const pending = renderable.content.chunks.find((chunk) => chunk.text.includes("pending"));
			expect((completed?.attributes ?? 0) & TextAttributes.STRIKETHROUGH).toBe(TextAttributes.STRIKETHROUGH);
			expect((active?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
			expect((pending?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
		} finally {
			renderable.destroyRecursively();
		}
	});

	test("keeps the same renderable identity while the plan content updates", async () => {
		const setup = await createTestRenderer({ width: 60, height: 10 });
		const renderable = new PlanUpdateRenderable(setup.renderer, { id: "plan-update-stable", width: "100%", block });
		setup.renderer.root.add(renderable);
		try {
			await setup.renderOnce();
			const id = renderable.num;
			renderable.updateBlock({ ...block, steps: [{ ...block.steps[0]!, text: { ...block.steps[0]!.text, text: "changed" } }] });
			await setup.renderOnce();
			expect(renderable.num).toBe(id);
			expect(renderable.plainText).toContain("changed");
		} finally {
			renderable.destroyRecursively();
		}
	});
});
