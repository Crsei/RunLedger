import { describe, expect, it } from "vitest";
import { explorationDisplayLines } from "../../../src/tui/opentui/exploration-renderable.ts";
import type { ExplorationBlock } from "../../../src/tui/presentation.ts";
import { explorationKindForTool } from "../../../src/tui/presentation/tools/exploration.ts";
import { projectToolEnd, projectToolResultMetadata, projectToolStart } from "../../../src/tui/presentation/tools/projector.ts";
import { timelineToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow, TimelineState } from "../../../src/tui/timeline/types.ts";
import { projectTranscriptOverlay, transcriptBlockLines } from "../../../src/tui/transcript-view.ts";

const startedAt = "2026-09-02T00:00:00.000Z";

function readRow(body: string, id = "read-1"): TimelineRow {
	const start = projectToolStart("read", { path: "src/secret.ts" }, startedAt);
	const presentation = projectToolEnd(start, {
		content: [{ type: "text", text: body }],
		details: { truncation: { truncated: false } },
		isError: false,
	}, startedAt);
	return {
		kind: "tool",
		id: `tool:${id}`,
		timestamp: startedAt,
		displayOrder: 0,
		status: "succeeded",
		toolCallId: id,
		toolName: { text: "read", truncated: false, byteLength: 4 },
		presentation: { state: "known", value: presentation },
	};
}

function state(row: TimelineRow): TimelineState {
	return {
		generation: 1,
		committedRows: [row],
		activeRowsByCorrelationId: {},
		activeOrder: [],
		cursor: { messageIndex: 1 },
	};
}

function failedReadRow(error: string): TimelineRow {
	const start = projectToolStart("read", { path: "missing.ts" }, startedAt);
	const presentation = projectToolEnd(start, {
		content: [{ type: "text", text: error }],
		details: {},
		isError: true,
	}, startedAt);
	return {
		kind: "tool",
		id: "tool:read-error",
		timestamp: startedAt,
		displayOrder: 0,
		status: "failed",
		toolCallId: "read-error",
		toolName: { text: "read", truncated: false, byteLength: 4 },
		presentation: { state: "known", value: presentation },
	};
}

function runningReadRow(path = "src/pending.ts", id = "read-running"): TimelineRow {
	return {
		kind: "tool",
		id: `tool:${id}`,
		timestamp: startedAt,
		displayOrder: 0,
		status: "running",
		toolCallId: id,
		toolName: { text: "read", truncated: false, byteLength: 4 },
		presentation: { state: "known", value: projectToolStart("read", { path }, startedAt) },
	};
}

describe("Codex exploration output summary", () => {
	it("classifies only exact first-party discovery tool names", () => {
		expect(explorationKindForTool("read")).toBe("read");
		expect(explorationKindForTool("grep")).toBe("search");
		// find 已是 glob 的历史调用名,与规范工具同组。
		expect(explorationKindForTool("find")).toBe("list");
		expect(explorationKindForTool("glob")).toBe("list");
		expect(explorationKindForTool("ls")).toBe("list");
		expect(explorationKindForTool("Read")).toBeUndefined();
		expect(explorationKindForTool("mcp.read")).toBeUndefined();
		expect(explorationKindForTool("bash")).toBeUndefined();
	});

	it("keeps successful read body out of main while retaining it in Ctrl+T transcript", () => {
		const body = "const privateFileBody = 'only transcript may show this';";
		const timeline = state(readRow(body));

		const main = timelineToBlocks(timeline);
		const transcript = projectTranscriptOverlay(timeline).rows;
		expect(main).toMatchObject([{ kind: "exploration", actions: [{ id: "read-1", kind: "read" }] }]);
		expect(JSON.stringify(main)).not.toContain(body);
		expect(transcript).toMatchObject([{ kind: "tool-detail", action: { id: "read-1", kind: "read" } }]);
		expect(JSON.stringify(transcript)).toContain(body);
	});

	it("normalizes nested runtime truncation instead of reporting read as untruncated", () => {
		const metadata = projectToolResultMetadata({
			toolName: "read",
			details: {
				truncation: {
					truncated: true,
					outputLines: 2000,
					totalLines: 2300,
					maxLines: 2000,
				},
			},
			content: [],
		});

		expect(metadata).toMatchObject({ kind: "read", truncated: true });
	});

	it("groups adjacent exploration rows without changing their action ids", () => {
		const first = readRow("first safe body", "read-1");
		const second = readRow("second safe body", "read-2");
		const timeline: TimelineState = { ...state(first), committedRows: [first, second] };

		expect(timelineToBlocks(timeline)).toMatchObject([{
			id: "exploration-tool:read-1",
			kind: "exploration",
			state: "completed",
			finalized: false,
			actions: [{ id: "read-1" }, { id: "read-2" }],
		}]);
	});

	it("does not group across a shell tool and finalizes the preceding exploration block", () => {
		const first = readRow("first safe body", "read-1");
		const second = readRow("second safe body", "read-2");
		const shell: TimelineRow = {
			kind: "tool",
			id: "tool:bash-1",
			timestamp: startedAt,
			displayOrder: 1,
			status: "succeeded",
			toolCallId: "bash-1",
			toolName: { text: "bash", truncated: false, byteLength: 4 },
			presentation: { state: "known", value: {
				renderer: "shell",
				title: { text: "bash", truncated: false, byteLength: 4 },
				input: { kind: "shell", commandLabel: { text: "pwd", truncated: false, byteLength: 3 } },
				chips: [],
				body: [],
				timestamps: { startedAt },
			} },
		};
		const timeline: TimelineState = { ...state(first), committedRows: [first, shell, second] };

		expect(timelineToBlocks(timeline)).toMatchObject([
			{ kind: "exploration", finalized: true, actions: [{ id: "read-1" }] },
			{ kind: "exec", command: "pwd" },
			{ kind: "exploration", finalized: false, actions: [{ id: "read-2" }] },
		]);
	});

	it("keeps the full bounded failed-read detail in transcript without duplicating it", () => {
		const error = "Path not found: missing.ts\nCheck the workspace path and retry.";
		const transcript = projectTranscriptOverlay(state(failedReadRow(error))).rows;
		const lines = transcript.flatMap((block) => transcriptBlockLines(block, 80));

		expect(lines.join("\n")).toContain("Check the workspace path and retry.");
		expect(lines.filter((line) => line.includes("Path not found: missing.ts"))).toHaveLength(1);
	});

	it("does not label a running read as failed", () => {
		const block = timelineToBlocks(state(runningReadRow()))[0];
		expect(block).toMatchObject({ kind: "exploration", state: "active" });
		if (block?.kind !== "exploration") throw new Error("expected exploration block");
		const rendered = explorationDisplayLines(block, 80).join("\n");
		expect(rendered).toContain("• Exploring");
		expect(rendered).toContain("Read src/pending.ts");
		expect(rendered).not.toContain("failed");
	});

	it("shows the bounded failure reason on the main exploration surface", () => {
		const block = timelineToBlocks(state(failedReadRow("Path not found: missing.ts\nCheck the workspace path.")))[0];
		if (block?.kind !== "exploration") throw new Error("expected exploration block");
		expect(explorationDisplayLines(block, 80)).toEqual([
			"• Explored with errors",
			"  └ Read missing.ts · failed",
			"    Path not found: missing.ts",
		]);
	});

	it("keeps a mixed failed and running exploration group active", () => {
		const failed = failedReadRow("Path not found: missing.ts");
		const running = runningReadRow("src/still-reading.ts");
		const timeline: TimelineState = {
			...state(failed),
			committedRows: [failed],
			activeRowsByCorrelationId: { "read-running": running },
			activeOrder: ["read-running"],
		};
		const block = timelineToBlocks(timeline)[0];
		expect(block).toMatchObject({ kind: "exploration", state: "active" });
		if (block?.kind !== "exploration") throw new Error("expected exploration block");
		expect(explorationDisplayLines(block, 80)[0]).toBe("• Exploring");
	});

	it("bounds a long adjacent read history to groups of at most 32 actions", () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => readRow(`safe body ${index}`, `read-${index}`));
		const timeline: TimelineState = { ...state(rows[0]!), committedRows: rows };
		const blocks = timelineToBlocks(timeline);
		const groups = blocks.filter((block): block is Extract<typeof block, { readonly kind: "exploration" }> => block.kind === "exploration");

		expect(groups).toHaveLength(32);
		expect(groups.every((group) => group.actions.length <= 32)).toBe(true);
		expect(groups.at(-1)?.finalized).toBe(false);
	});

	it("does not count a wrapped single action as an omitted action", () => {
		const block: ExplorationBlock = {
			id: "exploration-tool:read-1",
			kind: "exploration",
			state: "completed",
			actions: [{
				id: "read-1",
				kind: "read",
				label: { text: "Read", truncated: false, byteLength: 4 },
				target: { text: "src/a-very-long-path-that-wraps-beyond-the-main-summary-budget.ts", truncated: false, byteLength: 64 },
				status: "succeeded",
			}],
		};

		expect(explorationDisplayLines(block, 12)).not.toContain("  └ … +1 actions (Ctrl+T for transcript)");
	});
});
