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

	it("projects notices with severity prefix", () => {
		const blocks = rowToBlocks(row({ kind: "notice", severity: "error", message: { text: "boom", truncated: false, byteLength: 4 } }));
		expect(blocks[0]!.content).toBe("error: boom");
	});

	it("is a pure conversion (no state mutation across calls)", () => {
		const user = row({ kind: "user", id: "user:0" });
		const state: TimelineState = { generation: 1, committedRows: [user], activeRowsByCorrelationId: {}, activeOrder: [], cursor: { messageIndex: 1 } };
		const first = JSON.stringify(timelineToBlocks(state));
		const second = JSON.stringify(timelineToBlocks(state));
		expect(second).toBe(first);
	});
});
