/**
 * B2：timeline pure reducer 验收。
 *
 *   - message/tool start-update-end 从 active row 单调进入 committed row；
 *   - stale generation、orphan end、重复 end、abort/error 有确定结果；
 *   - cleanup 按 correlationId 落 cancelled/aborted；
 *   - 非法输入不 throw（返回 unchanged 或确定状态）。
 */

import { describe, expect, it } from "vitest";
import { createInitialTimelineState, timelineReducer } from "../../../src/tui/timeline/reducer.ts";
import type { TimelineEvent, TimelineRow } from "../../../src/tui/timeline/types.ts";

const bounded = { text: "hello", truncated: false, byteLength: 5 };

function assistantStart(correlationId = "assistant:0"): TimelineEvent {
	const row: TimelineRow = {
		kind: "assistant",
		id: correlationId,
		timestamp: "2026-08-06T00:00:00.000Z",
		displayOrder: 0,
		status: "running",
		text: bounded,
		streaming: true,
	};
	return { type: "message_start", generation: 1, correlationId, row };
}

function toolStart(correlationId = "call-1"): TimelineEvent {
	const row: TimelineRow = {
		kind: "tool",
		id: `tool:${correlationId}`,
		timestamp: "2026-08-06T00:00:00.000Z",
		displayOrder: 1,
		status: "running",
		toolCallId: correlationId,
		toolName: bounded,
		presentation: { state: "known", value: { renderer: "generic", title: bounded, chips: [], body: [], timestamps: { startedAt: "2026-08-06T00:00:00.000Z" } } },
	};
	return { type: "tool_start", generation: 1, correlationId, row };
}

describe("B2 timeline reducer", () => {
	it("tracks one active run and commits exactly one matching run boundary", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, { type: "run_start", generation: 1, runId: "run-1", timestamp: 1_000, activeDurationMs: 0 });
		expect(state.activeRun).toMatchObject({ runId: "run-1", state: "working", activeDurationMs: 0 });
		state = timelineReducer(state, { type: "run_pause", generation: 2, runId: "other", waitId: "wait-x", reason: "approval", timestamp: 1_050, activeDurationMs: 50 });
		expect(state.activeRun).toMatchObject({ runId: "run-1", state: "working" });
		state = timelineReducer(state, { type: "run_pause", generation: 3, runId: "run-1", waitId: "wait-1", reason: "approval", timestamp: 1_100, activeDurationMs: 100 });
		expect(state.activeRun).toMatchObject({ state: "waiting", activeDurationMs: 100 });
		state = timelineReducer(state, { type: "run_resume", generation: 4, runId: "run-1", waitId: "wait-1", timestamp: 1_300, activeDurationMs: 100 });
		expect(state.activeRun).toMatchObject({ state: "working", activeDurationMs: 100, lastResumedAtMs: 1_300 });
		state = timelineReducer(state, { type: "run_end", generation: 5, runId: "run-1", timestamp: 1_500, stopReason: "stop", elapsedMs: 500, activeDurationMs: 300, messageCountAtEnd: 2 });
		expect(state.activeRun).toBeUndefined();
		expect(state.committedRows.filter((row) => row.kind === "run-boundary")).toHaveLength(1);
		const completed = state;
		state = timelineReducer(state, { type: "run_end", generation: 6, runId: "run-1", timestamp: 1_500, stopReason: "error", elapsedMs: 500, activeDurationMs: 300, messageCountAtEnd: 2 });
		expect(state).toBe(completed);
	});
	it("moves an active message row into committed rows monotonically", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, assistantStart());
		expect(state.activeOrder).toEqual(["assistant:0"]);
		expect(state.committedRows).toHaveLength(0);
		expect(state.cursor.activeMessageId).toBe("assistant:0");
		state = timelineReducer(state, { type: "message_update", generation: 1, correlationId: "assistant:0", text: { text: "hello world", truncated: false, byteLength: 11 } });
		expect(state.activeRowsByCorrelationId["assistant:0"]!.text.text).toBe("hello world");
		state = timelineReducer(state, { type: "message_end", generation: 1, correlationId: "assistant:0", status: "succeeded" });
		expect(state.activeOrder).toEqual([]);
		expect(state.committedRows).toHaveLength(1);
		expect(state.committedRows[0]!.status).toBe("succeeded");
		expect(state.committedRows[0]!.text.text).toBe("hello world");
		expect(state.committedRows[0]!).toMatchObject({ kind: "assistant", streaming: false });
	});

	it("tracks user and assistant message indexes in the cursor", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, { ...assistantStart("user:0"), ...({ row: { ...(assistantStart("user:0").row as TimelineRow), kind: "user" as const } }) });
		expect(state.cursor.messageIndex).toBe(1);
		state = timelineReducer(state, assistantStart("assistant:1"));
		expect(state.cursor.messageIndex).toBe(2);
	});

	it("ignores stale generations without landing", () => {
		let state = timelineReducer(createInitialTimelineState(), { ...assistantStart(), generation: 5 });
		expect(state.generation).toBe(5);
		const before = state;
		state = timelineReducer(state, { type: "message_update", generation: 3, correlationId: "assistant:0", text: { text: "stale", truncated: false, byteLength: 5 } });
		expect(state).toBe(before);
		state = timelineReducer(state, { type: "message_end", generation: 4, correlationId: "assistant:0", status: "succeeded" });
		expect(state.activeOrder).toEqual(["assistant:0"]);
	});

	it("orphan end / duplicate end / orphan update are deterministic no-ops", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, { type: "message_end", generation: 1, correlationId: "ghost", status: "succeeded" });
		expect(state).toEqual(createInitialTimelineState());
		state = timelineReducer(state, { type: "message_update", generation: 1, correlationId: "ghost", text: bounded });
		expect(state.committedRows).toHaveLength(0);
		state = timelineReducer(state, assistantStart());
		state = timelineReducer(state, { type: "message_end", generation: 1, correlationId: "assistant:0", status: "succeeded" });
		const committed = state;
		state = timelineReducer(state, { type: "message_end", generation: 1, correlationId: "assistant:0", status: "failed" });
		expect(state.committedRows).toHaveLength(1);
		expect(state.committedRows[0]!.status).toBe("succeeded");
		expect(state).toEqual(committed);
	});

	it("aborts active rows deterministically on cleanup", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, assistantStart());
		state = timelineReducer(state, toolStart());
		state = timelineReducer(state, { type: "cleanup", generation: 1, correlationId: "assistant:0", reason: "abort" });
		state = timelineReducer(state, { type: "cleanup", generation: 1, correlationId: "call-1", reason: "abort" });
		expect(state.activeOrder).toEqual([]);
		expect(state.committedRows.map((row) => row.status)).toEqual(["aborted", "aborted"]);
		state = timelineReducer(state, { type: "cleanup", generation: 1, correlationId: "ghost", reason: "session-switch" });
		expect(state.committedRows).toHaveLength(2);
	});

	it("P2-2: cleanup without correlationId clears ALL active rows (destroy/session-switch)", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, assistantStart());
		state = timelineReducer(state, toolStart());
		const withCleanup = timelineReducer(state, { type: "cleanup", generation: 1, correlationId: undefined, reason: "destroy" });
		expect(withCleanup.activeOrder).toEqual([]);
		expect(Object.keys(withCleanup.activeRowsByCorrelationId)).toEqual([]);
		expect(withCleanup.committedRows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
	});

	it("tool start/update/end keeps presentation and commits final status", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, toolStart());
		state = timelineReducer(state, {
			type: "tool_update",
			generation: 1,
			correlationId: "call-1",
			presentation: { state: "known", value: { renderer: "shell", title: bounded, chips: [], body: [{ kind: "text", content: { text: "chunk", truncated: false, byteLength: 5 } }], timestamps: { startedAt: "2026-08-06T00:00:00.000Z" } } },
		});
		expect(state.activeRowsByCorrelationId["call-1"]!.kind).toBe("tool");
		state = timelineReducer(state, { type: "tool_end", generation: 1, correlationId: "call-1", status: "failed" });
		const row = state.committedRows[0];
		expect(row?.kind).toBe("tool");
		expect(row?.status).toBe("failed");
		expect((row as { presentation: { state: string } }).presentation.state).toBe("known");
	});

	it("notice rows append committed rows and are bounded", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, { type: "notice", generation: 1, correlationId: "n-1", severity: "error", message: bounded });
		expect(state.committedRows).toHaveLength(1);
		expect(state.committedRows[0]).toMatchObject({ kind: "notice", severity: "error", status: "succeeded" });
	});

	it("duplicate message_start for the same correlationId is ignored", () => {
		let state = createInitialTimelineState();
		state = timelineReducer(state, assistantStart());
		const before = state;
		state = timelineReducer(state, assistantStart());
		expect(state).toBe(before);
	});
});
