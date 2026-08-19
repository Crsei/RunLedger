import { describe, expect, it, vi } from "vitest";
import type { PresentationBlock } from "../../../src/tui/presentation.ts";
import type { TimelineState } from "../../../src/tui/timeline/types.ts";
import { timelineToBlocks } from "../../../src/tui/timeline/selectors.ts";
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
	it("keeps committed and live thinking data reversible across display-only projections", () => {
		const base = timelineWithActiveText("active answer");
		const committedAssistant = {
			kind: "assistant" as const,
			id: "assistant:committed",
			timestamp: "2026-08-14T00:00:00.500Z",
			displayOrder: 1,
			status: "succeeded" as const,
			streaming: false,
			thinking: bounded("committed reasoning"),
			text: bounded("committed answer"),
		};
		const active = base.activeRowsByCorrelationId["assistant:1"];
		if (active?.kind !== "assistant") throw new Error("assistant fixture missing");
		const state: TimelineState = {
			...base,
			committedRows: [...base.committedRows, committedAssistant],
			activeRowsByCorrelationId: {
				"assistant:1": { ...active, thinking: bounded("active reasoning") },
			},
		};

		const visible = projectTranscriptOverlay(state, 0, { hideThinking: false });
		const hidden = projectTranscriptOverlay(state, 0, { hideThinking: true });
		const restored = projectTranscriptOverlay(state, 0, { hideThinking: false });

		expect(visible.rows.some((block) => block.id === "timeline-assistant:committed/thinking")).toBe(true);
		expect(visible.liveTail?.some((block) => block.id === "timeline-assistant:1/thinking")).toBe(true);
		expect(hidden.rows.some((block) => block.id?.endsWith("/thinking"))).toBe(false);
		expect(hidden.liveTail?.some((block) => block.id?.endsWith("/thinking"))).toBe(false);
		expect(restored.rows).toBe(visible.rows);
		expect(restored.liveTail?.some((block) => block.id === "timeline-assistant:1/thinking")).toBe(true);
	});

	it("keeps committed rows and an active tail while changing the active revision", () => {
		const firstState = timelineWithActiveText("first tail");
		const secondState = {
			...firstState,
			activeRowsByCorrelationId: timelineWithActiveText("second tail").activeRowsByCorrelationId,
		};
		const first = projectTranscriptOverlay(firstState);
		const second = projectTranscriptOverlay(secondState);

		expect(first.rows).toEqual([{
			id: "timeline-user:1",
			entryId: "user:1",
			partId: "user:1/text",
			contentGeneration: 0,
			finalized: true,
			kind: "text",
			content: "committed question",
		}]);
		expect(second.rows).toBe(first.rows);
		expect(first.liveTail?.[0]).toMatchObject({ id: "timeline-assistant:1/text", kind: "markdown", content: "first tail" });
		expect(first.timelineGeneration).toBe(7);
		expect(first.activeRevision).not.toBe(second.activeRevision);
	});

	it("uses the canonical committed selector for separator filtering and metrics", () => {
		const state: TimelineState = {
			...timelineWithActiveText("tail"),
			committedRows: [
				...timelineWithActiveText("tail").committedRows,
				{
					kind: "run-boundary",
					id: "run:empty",
					timestamp: "2026-08-14T00:00:02.000Z",
					displayOrder: 1,
					status: "succeeded",
					runId: "run:empty",
					stopReason: "stop",
					activeDurationMs: 1000,
				},
			],
		};

		expect(projectTranscriptOverlay(state).rows).toEqual(timelineToBlocks(state, { includeActive: false }));
		expect(projectTranscriptOverlay(state).rows.some((block) => block.kind === "separator")).toBe(false);
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
		expect(execLines[0]).toBe("$ printf 'hello'");
		expect(execLines).toContain("first output");
		expect(execLines).toContain("second output");
		expect(execLines.at(-1)).toBe("✓ • 1.2s");
	});

	it("keeps the complete command in transcript form instead of the main-cell continuation budget", () => {
		const exec: PresentationBlock = {
			kind: "exec",
			command: "first\nsecond\nthird\nfourth",
			status: "succeeded",
			output: [],
			exitCode: 0,
			durationMs: 10,
			continuationMaxLines: 2,
			transcriptForm: "dollar",
		};

		expect(transcriptBlockLines(exec, 80)).toEqual([
			"$ first",
			"    second",
			"    third",
			"    fourth",
			"✓ • 10ms",
		]);
	});
});

describe("TranscriptOverlayComponent", () => {
	it("pages read-only content and closes on escape, Ctrl+C or Ctrl+T", () => {
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
		component.handleInput("ctrl+t");

		expect(onClose).toHaveBeenCalledTimes(3);
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

	it("does not re-project committed block lines when only the active tail changes", () => {
		let committedReads = 0;
		const committed = {
			id: "history",
			kind: "text" as const,
			get content() {
				committedReads += 1;
				return "history";
			},
		};
		const component = new TranscriptOverlayComponent({
			rows: [committed],
			liveTail: [{ id: "active", kind: "text", content: "old tail" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
		});

		component.render(40);
		const readsAfterFirstRender = committedReads;
		component.update({
			rows: [committed],
			liveTail: [{ id: "active", kind: "text", content: "new tail" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-2",
		});
		component.render(40);

		expect(committedReads).toBe(readsAfterFirstRender);
	});

	it("reuses bounded settled projection rows on a repeated readback", () => {
		const component = new TranscriptOverlayComponent({
			rows: [{ id: "history", kind: "text", content: "history" }],
			liveTail: [{ id: "active", kind: "text", content: "active" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
		});

		component.render(40);
		component.render(40);

		expect(component.getSettledPartCacheSnapshot()).toMatchObject({ entries: 1, hits: 1 });
	});

	it("invalidates settled rows when the presentation theme generation changes", () => {
		const component = new TranscriptOverlayComponent({
			rows: [{ id: "history", kind: "text", content: "history" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
			themeGeneration: 1,
		});
		component.render(40);
		component.update({
			rows: [{ id: "history", kind: "text", content: "history" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
			themeGeneration: 2,
		});
		component.render(40);

		expect(component.getSettledPartCacheSnapshot()).toMatchObject({ entries: 1, hits: 0, misses: 2 });
	});

	it("resets the theme fence when a session reuses an older theme generation", () => {
		const component = new TranscriptOverlayComponent({
			rows: [{ id: "history", kind: "text", content: "history" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
			themeGeneration: 1,
		});
		component.render(40);
		component.update({
			rows: [{ id: "history", kind: "text", content: "history" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
			themeGeneration: 2,
		});
		component.render(40);
		component.update({
			rows: [{ id: "history", kind: "text", content: "history" }],
			timelineGeneration: 4,
			committedRevision: "committed-1",
			activeRevision: "active-1",
			themeGeneration: 1,
		});
		component.render(40);

		expect(component.getSettledPartCacheSnapshot()).toMatchObject({
			entries: 1,
			staleReads: 0,
			staleWrites: 0,
		});
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
