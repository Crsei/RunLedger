import { describe, expect, it } from "vitest";
import { projectPlanUpdate, projectToolStart, rendererForTool } from "../../../src/tui/presentation/tools/projector.ts";
import { rowToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../../src/tui/timeline/types.ts";

const startedAt = "2026-08-14T00:00:00.000Z";

function planRow(presentation: ReturnType<typeof projectToolStart>, status: TimelineRow["status"] = "running"): TimelineRow {
	return {
		kind: "tool",
		id: "tool:todo-1",
		timestamp: startedAt,
		displayOrder: 0,
		status,
		toolCallId: "todo-1",
		toolName: { text: "TodoWrite", truncated: false, byteLength: 9 },
		presentation: { state: "known", value: presentation },
	};
}

describe("S1 plan-update safe projection", () => {
	it("routes TodoWrite to the plan renderer", () => {
		expect(rendererForTool("TodoWrite")).toBe("plan");
		expect(rendererForTool("todo-write")).toBe("plan");
	});

	it("maps todo statuses and strips unsafe input through bounded text", () => {
		const projected = projectPlanUpdate({
			explanation: "  update the task list  ",
			todos: [
				{ content: "done \u001b[31mstep\u001b[0m", status: "completed" },
				{ content: "active", status: "in_progress" },
				{ content: "later", status: "pending" },
			],
		});
		expect(projected).toEqual({
			explanation: { text: "  update the task list  ", truncated: false, byteLength: 24 },
			steps: [
				{ text: { text: "done step", truncated: false, byteLength: 9 }, status: "completed" },
				{ text: { text: "active", truncated: false, byteLength: 6 }, status: "in-progress" },
				{ text: { text: "later", truncated: false, byteLength: 5 }, status: "pending" },
			],
		});
	});

	it("projects one TodoWrite row as one plan-update block", () => {
		const presentation = projectToolStart("TodoWrite", {
			explanation: "Replicate the plan cell",
			todos: [
				{ content: "completed step", status: "completed" },
				{ content: "active step", status: "in_progress" },
				{ content: "pending step", status: "pending" },
			],
		}, startedAt);
		const blocks = rowToBlocks(planRow(presentation));
		expect(blocks).toEqual([{
			id: "timeline-tool:todo-1",
			kind: "plan-update",
			explanation: { text: "Replicate the plan cell", truncated: false, byteLength: 23 },
			steps: [
				{ text: { text: "completed step", truncated: false, byteLength: 14 }, status: "completed" },
				{ text: { text: "active step", truncated: false, byteLength: 11 }, status: "in-progress" },
				{ text: { text: "pending step", truncated: false, byteLength: 12 }, status: "pending" },
			],
		}]);
	});

	it("does not create an empty plan-update block", () => {
		const presentation = projectToolStart("TodoWrite", { todos: [] }, startedAt);
		expect(presentation.plan).toEqual({ steps: [] });
		expect(rowToBlocks(planRow(presentation))).toEqual([]);
	});

	it("retains the safe plan projection across tool completion", () => {
		const presentation = projectToolStart("TodoWrite", { todos: [{ content: "keep me", status: "pending" }] }, startedAt);
		expect(presentation.renderer).toBe("plan");
		expect(presentation.plan?.steps[0]?.text.text).toBe("keep me");
	});
});
