/**
 * B2：timeline selectors 验收。
 *
 *   - TimelineRow -> PresentationBlock，block id 稳定（由 row id 派生）；
 *   - assistant 行拆 thinking + text 两个 markdown block；
 *   - active rows 在 committed 之后、按 activeOrder 顺序追加；
 *   - 纯转换：不写 state、不持有 IO/timer。
 */

import { describe, expect, it } from "vitest";
import { rowToBlocks, timelineToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow, TimelineState } from "../../../src/tui/timeline/types.ts";

const bounded = { text: "hello", truncated: false, byteLength: 5 };

function row(overrides: Partial<TimelineRow> & { kind: TimelineRow["kind"] }): TimelineRow {
	return {
		id: "row-1",
		timestamp: "2026-08-06T00:00:00.000Z",
		displayOrder: 0,
		status: "succeeded",
		text: bounded,
		...overrides,
	} as TimelineRow;
}

describe("B2 timeline selectors", () => {
	it("produces stable block ids derived from row ids", () => {
		const user = row({ kind: "user", id: "user:0" });
		const assistant = row({ kind: "assistant", id: "assistant:1", streaming: true });
		const blocks = timelineToBlocks({ generation: 1, committedRows: [user, assistant], activeRowsByCorrelationId: {}, activeOrder: [], cursor: { messageIndex: 2 } });
		expect(blocks[0]!.id).toBe("timeline-user:0");
		expect(blocks[1]!.id).toBe("timeline-assistant:1/text");
	});

	it("splits assistant thinking and text into separate markdown blocks", () => {
		const blocks = rowToBlocks(row({
			kind: "assistant",
			id: "assistant:1",
			streaming: true,
			thinking: { text: "reasoning", truncated: false, byteLength: 9 },
		}));
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ kind: "markdown", content: "reasoning", streaming: true });
		expect(blocks[1]).toMatchObject({ kind: "markdown", content: "hello", streaming: true });
	});

	it("appends active rows after committed rows in activeOrder", () => {
		const active: TimelineRow = row({ kind: "tool", id: "tool:call-1", toolCallId: "call-1", toolName: bounded, presentation: { state: "known", value: { renderer: "shell", title: bounded, chips: [], body: [], timestamps: { startedAt: "2026-08-06T00:00:00.000Z" } } }, status: "running" });
		const state: TimelineState = {
			generation: 1,
			committedRows: [row({ kind: "user", id: "user:0" })],
			activeRowsByCorrelationId: { "call-1": active },
			activeOrder: ["call-1"],
			cursor: { messageIndex: 1 },
		};
		const blocks = timelineToBlocks(state);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.id).toBe("timeline-user:0");
		expect(blocks[1]!.id).toBe("timeline-tool:call-1");
	});

	it("preserves shell command/output/status as a typed exec block", () => {
		const command = { text: "bash -lc 'echo hello'", truncated: false, byteLength: 21 };
		const output = { text: "hello\n", truncated: false, byteLength: 6 };
		const blocks = rowToBlocks(row({
			kind: "tool",
			id: "tool:shell",
			toolCallId: "shell",
			toolName: { text: "bash", truncated: false, byteLength: 4 },
			status: "succeeded",
			presentation: {
				state: "known",
				value: {
					renderer: "shell",
					title: { text: "bash", truncated: false, byteLength: 4 },
					input: { kind: "shell", commandLabel: command },
					chips: [],
					body: [],
					result: {
						kind: "shell",
						chunks: [{ channel: "stdout", text: output }],
						truncated: false,
						exitCode: { state: "known", value: 0 },
						durationMs: { state: "known", value: 42 },
						background: false,
					},
					timestamps: { startedAt: "2026-08-06T00:00:00.000Z" },
				},
			},
		}));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "exec",
			command: "bash -lc 'echo hello'",
			status: "succeeded",
			exitCode: 0,
			durationMs: 42,
			output: [{ channel: "stdout", text: "hello\n" }],
		});
	});

	it("preserves safe edit diffs as a structured presentation block", () => {
		const document = {
			kind: "document" as const,
			path: { text: "src/a.ts", truncated: false, byteLength: 8 },
			hunks: [{ oldStart: 1, newStart: 1, lines: [
				{ kind: "delete" as const, oldLine: 1, text: { text: "before", truncated: false, byteLength: 6 } },
				{ kind: "add" as const, newLine: 1, text: { text: "after", truncated: false, byteLength: 5 } },
			] }],
			addedLines: { state: "known" as const, value: 1 },
			removedLines: { state: "known" as const, value: 1 },
			truncated: false,
		};
		const blocks = rowToBlocks(row({
			kind: "tool",
			id: "tool:edit",
			toolCallId: "edit",
			toolName: { text: "edit", truncated: false, byteLength: 4 },
			status: "succeeded",
			presentation: { state: "known", value: {
				renderer: "edit",
				title: { text: "edit", truncated: false, byteLength: 4 },
				chips: [],
				body: [{ kind: "diff", document }],
				timestamps: { startedAt: "2026-08-06T00:00:00.000Z" },
			} },
		}));
		const diff = blocks.find((block) => block.kind === "diff");
		expect(diff).toEqual({
			id: "timeline-tool:edit/diff-0",
			entryId: "tool:edit",
			partId: "tool:edit/diff-0",
			contentGeneration: 0,
			finalized: true,
			kind: "diff",
			document,
			showLineNumbers: true,
			lineNumberWidth: 1,
			syntaxHighlight: true,
		});
		expect(blocks.filter((block) => block.kind === "text").map((block) => block.content).join("\n")).not.toContain("+ after");
	});

	it("projects notices with severity prefix", () => {
		const blocks = rowToBlocks(row({ kind: "notice", severity: "error", message: { text: "boom", truncated: false, byteLength: 4 } }));
		expect(blocks).toEqual([{
			id: "timeline-row-1",
			entryId: "row-1",
			partId: "row-1/notice",
			contentGeneration: 0,
			finalized: true,
			kind: "notice",
			severity: "error",
			message: "error: boom",
		}]);
	});

	it("is a pure conversion (no state mutation across calls)", () => {
		const user = row({ kind: "user", id: "user:0" });
		const state: TimelineState = { generation: 1, committedRows: [user], activeRowsByCorrelationId: {}, activeOrder: [], cursor: { messageIndex: 1 } };
		const first = JSON.stringify(timelineToBlocks(state));
		const second = JSON.stringify(timelineToBlocks(state));
		expect(second).toBe(first);
	});
});
