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
		toolName: { text: "todo", truncated: false, byteLength: 4 },
		presentation: { state: "known", value: presentation },
	};
}

describe("S1 plan-update safe projection", () => {
	it("routes the todo tool to the plan renderer", () => {
		expect(rendererForTool("todo")).toBe("plan");
		expect(rendererForTool("plan")).toBe("plan");
	});

	it("projects init items as steps and strips unsafe input through bounded text", () => {
		const projected = projectPlanUpdate({
			op: "init",
			list: [
				{ phase: "Foundation", items: ["done \u001b[31mstep\u001b[0m", "active"] },
				{ phase: "Later", items: ["pending step"] },
			],
		});
		expect(projected).toEqual({
			steps: [
				{ text: { text: "done step", truncated: false, byteLength: 9 }, status: "pending" },
				{ text: { text: "active", truncated: false, byteLength: 6 }, status: "pending" },
				{ text: { text: "pending step", truncated: false, byteLength: 12 }, status: "pending" },
			],
		});
	});

	it("maps single-task ops to their resulting display status", () => {
		expect(projectPlanUpdate({ op: "start", task: "active" }).steps).toEqual([
			{ text: { text: "active", truncated: false, byteLength: 6 }, status: "in-progress" },
		]);
		expect(projectPlanUpdate({ op: "done", task: "finished" }).steps).toEqual([
			{ text: { text: "finished", truncated: false, byteLength: 8 }, status: "completed" },
		]);
		// block/drop 不改变计划进度条上的"待办"外观,仍按 pending 展示。
		expect(projectPlanUpdate({ op: "block", task: "stuck", reason: "waiting" }).steps).toEqual([
			{ text: { text: "stuck", truncated: false, byteLength: 5 }, status: "pending" },
		]);
		// view 只读:不产生步骤。
		expect(projectPlanUpdate({ op: "view" }).steps).toEqual([]);
	});

	it("projects one todo row as one plan-update block", () => {
		const presentation = projectToolStart("todo", {
			explanation: "Replicate the plan cell",
			op: "init",
			list: [{ phase: "Demo", items: ["pending step"] }],
		}, startedAt);
		const blocks = rowToBlocks(planRow(presentation));
		expect(blocks).toEqual([{
			id: "timeline-tool:todo-1",
			entryId: "tool:todo-1",
			partId: "tool:todo-1/plan",
			contentGeneration: 0,
			finalized: false,
			kind: "plan-update",
			explanation: { text: "Replicate the plan cell", truncated: false, byteLength: 23 },
			steps: [
				{ text: { text: "pending step", truncated: false, byteLength: 12 }, status: "pending" },
			],
		}]);
	});

	it("does not create an empty plan-update block", () => {
		const presentation = projectToolStart("todo", { op: "view" }, startedAt);
		expect(presentation.plan).toEqual({ steps: [] });
		expect(rowToBlocks(planRow(presentation))).toEqual([]);
	});

	it("retains the safe plan projection across tool completion", () => {
		const presentation = projectToolStart("todo", { op: "start", task: "keep me" }, startedAt);
		expect(presentation.renderer).toBe("plan");
		expect(presentation.plan?.steps[0]?.text.text).toBe("keep me");
	});

	it("caps untrusted plan input at the presentation step budget", () => {
		const projected = projectPlanUpdate({
			op: "init",
			list: [{ phase: "Bulk", items: Array.from({ length: 300 }, (_, index) => `step ${index}`) }],
		});

		expect(projected.steps).toHaveLength(256);
		expect(projected.steps.at(-1)?.text.text).toBe("step 255");
	});
});
