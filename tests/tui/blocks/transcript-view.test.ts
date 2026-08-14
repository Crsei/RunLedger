import { describe, expect, it, vi } from "vitest";
import type { PresentationBlock } from "../../../src/tui/presentation.ts";
import type { TimelineState } from "../../../src/tui/timeline/types.ts";
import {
	TranscriptOverlayComponent,
	projectTranscriptOverlay,
	transcriptBlockLines,
} from "../../../src/tui/transcript-view.ts";

const bounded = (text: string) => ({
	text,
	truncated: false,
	byteLength: new TextEncoder().encode(text).byteLength,
});

function timelineWithActiveText(text: string): TimelineState {
	return {
		generation: 7,
		committedRows: [{
			kind: "user",
			id: "user:1",
			timestamp: "2026-08-14T00:00:00.000Z",
			displayOrder: 0,
			status: "succeeded",
			text: bounded("committed question"),
		}],
		activeRowsByCorrelationId: {
			"assistant:1": {
				kind: "assistant",
				id: "assistant:1",
				timestamp: "2026-08-14T00:00:01.000Z",
				displayOrder: 1,
				status: "running",
				streaming: true,
				text: bounded(text),
			},
		},
		activeOrder: ["assistant:1"],
		cursor: { messageIndex: 1, activeMessageId: "assistant:1" },
		activeRun: {
			runId: "run:1",
			state: "working",
			startedAtMs: 0,
			activeDurationMs: 1000,
		},
	};
}

describe("transcript view projection", () => {
	it("keeps committed rows and an active tail while changing the active revision", () => {
		const first = projectTranscriptOverlay(timelineWithActiveText("first tail"));
		const second = projectTranscriptOverlay(timelineWithActiveText("second tail"));

		expect(first.rows).toEqual([{ id: "timeline-user:1", kind: "text", content: "committed question" }]);
		expect(first.liveTail?.[0]).toMatchObject({ id: "timeline-assistant:1/text", kind: "markdown", content: "first tail" });
		expect(first.timelineGeneration).toBe(7);
		expect(first.activeRevision).not.toBe(second.activeRevision);
	});

	it("projects plan and exec blocks into selectable transcript forms", () => {
		const plan: PresentationBlock = {
			kind: "plan-update",
			explanation: bounded("keep the source bounded"),
			steps: [
				{ status: "completed", text: bounded("completed step") },
				{ status: "in-progress", text: bounded("active step") },
				{ status: "pending", text: bounded("pending step") },
			],
		};
		const exec: PresentationBlock = {
			kind: "exec",
			command: "printf 'hello'",
			status: "succeeded",
			output: [
				{ channel: "stdout", text: "first output" },
				{ channel: "stdout", text: "second output" },
			],
			durationMs: 1200,
			outputMaxLines: 5,
			transcriptForm: "dollar",
		};

		expect(transcriptBlockLines(plan, 80)).toEqual([
			"Updated Plan",
			"Explanation: keep the source bounded",
			"Completed: completed step",
			"InProgress: active step",
			"Pending: pending step",
		]);
		const execLines = transcriptBlockLines(exec, 80);
		expect(execLines[0]).toBe("$ printf 'hello'  ✓ • 1.2s");
		expect(execLines).toContain("  └ first output");
		expect(execLines).toContain("    second output");
	});
});

describe("TranscriptOverlayComponent", () => {
	it("pages read-only content and closes on escape or Ctrl+C", () => {
		const onClose = vi.fn();
		const component = new TranscriptOverlayComponent({
			rows: Array.from({ length: 12 }, (_, index) => ({
				id: `entry-${index}`,
				kind: "text" as const,
				content: `entry ${index}`,
			})),
			timelineGeneration: 1,
			committedRevision: "committed-1",
			activeRevision: "active-1",
		}, {
			getViewportHeight: () => 5,
			onClose,
		});

		expect(component.render(30).join("\n")).toContain("entry 0");
		component.handleInput("pageDown");
		expect(component.render(30).join("\n")).toContain("entry 3");
		component.handleInput("G");
		expect(component.render(30).join("\n")).toContain("entry 11");
		component.handleInput("k");
		expect(component.render(30).join("\n")).toContain("entry 10");
		component.handleInput("escape");
		component.handleInput("ctrl+c");

		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("refreshes the cached page when the active revision changes", () => {
		const component = new TranscriptOverlayComponent({
			rows: [{ id: "history", kind: "text", content: "history" }],
			liveTail: [{ id: "active", kind: "text", content: "old tail" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
		});

		expect(component.render(40).join("\n")).toContain("old tail");
		component.update({
			rows: [{ id: "history", kind: "text", content: "history" }],
			liveTail: [{ id: "active", kind: "text", content: "new tail" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-2",
		});
		expect(component.render(40).join("\n")).toContain("new tail");
		expect(component.render(40).join("\n")).not.toContain("old tail");
	});

	it("marks a bounded view without changing the source rows", () => {
		const component = new TranscriptOverlayComponent({
			rows: Array.from({ length: 5 }, (_, index) => ({
				id: `entry-${index}`,
				kind: "text" as const,
				content: `entry ${index}`,
			})),
			timelineGeneration: 1,
			committedRevision: "committed-1",
			activeRevision: "active-1",
		}, { maxBlocks: 3 });

		const rendered = component.render(40).join("\n");
		expect(rendered).toContain("entry 0");
		expect(rendered).toContain("entry 4");
		expect(rendered).toContain("(truncated)");
	});
});
