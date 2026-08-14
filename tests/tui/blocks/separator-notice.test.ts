import { describe, expect, it } from "vitest";
import { rowToBlocks, timelineToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow, TimelineState } from "../../../src/tui/timeline/types.ts";

const startedAt = "2026-08-14T00:00:00.000Z";

function bounded(text: string) {
	return { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength };
}

function userRow(id: string, displayOrder: number): TimelineRow {
	return {
		kind: "user",
		id,
		timestamp: startedAt,
		displayOrder,
		status: "succeeded",
		text: bounded("prompt"),
	};
}

function assistantRow(id: string, displayOrder: number): TimelineRow {
	return {
		kind: "assistant",
		id,
		timestamp: startedAt,
		displayOrder,
		status: "succeeded",
		streaming: false,
		text: bounded("answer"),
		usage: {
			input: { state: "exact", value: 1_000 },
			output: { state: "exact", value: 200 },
		},
	};
}

function toolRow(id: string, displayOrder: number, renderer: "shell" | "plan" = "shell"): TimelineRow {
	return {
		kind: "tool",
		id,
		timestamp: startedAt,
		displayOrder,
		status: "succeeded",
		toolCallId: id,
		toolName: bounded(renderer),
		presentation: {
			state: "known",
			value: {
				renderer,
				title: bounded(renderer),
				chips: [],
				body: [],
				timestamps: { startedAt },
			},
		},
	};
}

function boundary(displayOrder: number): TimelineRow {
	return {
		kind: "run-boundary",
		id: "run:1",
		timestamp: startedAt,
		displayOrder,
		status: "succeeded",
		runId: "run-1",
		stopReason: "stop",
		activeDurationMs: 12_000,
		messageCountAtEnd: 2,
	};
}

function state(rows: readonly TimelineRow[]): TimelineState {
	return {
		generation: 1,
		committedRows: rows,
		activeRowsByCorrelationId: {},
		activeOrder: [],
		cursor: { messageIndex: 2 },
	};
}

describe("S4 separator and notice projection", () => {
	it("emits a worked separator with tool and token metrics only for a work turn", () => {
		const blocks = timelineToBlocks(state([
			userRow("user:0", 0),
			assistantRow("assistant:1", 1),
			toolRow("tool:1", 2),
			toolRow("tool:2", 3, "plan"),
			boundary(4),
		]));
		const separator = blocks.find((block) => block.kind === "separator");

		expect(separator).toMatchObject({
			kind: "separator",
			label: "stop · Worked for 12s",
			metrics: ["2 tools", "1.2k tokens"],
		});
	});

	it("does not add a separator for a turn without tool or plan activity", () => {
		const blocks = timelineToBlocks(state([
			userRow("user:0", 0),
			assistantRow("assistant:1", 1),
			boundary(2),
		]));

		expect(blocks.some((block) => block.kind === "separator")).toBe(false);
	});

	it("projects notices as a styled-safe block while preserving severity semantics", () => {
		const blocks = rowToBlocks({
			kind: "notice",
			id: "notice:warning",
			timestamp: startedAt,
			displayOrder: 0,
			status: "succeeded",
			severity: "warning",
			message: bounded("host is reconnecting"),
		});

		expect(blocks).toEqual([{
			id: "timeline-notice:warning",
			kind: "notice",
			severity: "warning",
			message: "warning: host is reconnecting",
		}]);
	});
});
