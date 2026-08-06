/**
 * B2：timeline event-projector 验收。
 *
 *   - replay 与 live event 对同一 canonical message 生成相同稳定 row id；
 *   - message/tool start-update-end 事件序确定；
 *   - thinking 走 message_update.thinking；tool 走 safe presentation；
 *   - 相同 seed + 相同输入 → 相同输出。
 */

import { describe, expect, it } from "vitest";
import { TimelineEventProjector } from "../../../src/tui/timeline/event-projector.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import type { TuiEvent } from "../../../src/tui/types.ts";

const startedAt = "2026-08-06T00:00:00.000Z";

function userMessage(text = "hi"): Parameters<TimelineEventProjector["project"]>[0] {
	return { kind: "replay-message", index: 0, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantMessage(extra: object = {}): Parameters<TimelineEventProjector["project"]>[0] {
	return {
		kind: "replay-message",
		index: 1,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "reply" },
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
			],
			stopReason: "stop",
			api: mockModel.api,
			provider: mockModel.provider,
			model: mockModel.id,
			...extra,
		},
	};
}

describe("B2 timeline event-projector", () => {
	it("produces stable row ids for the same canonical message (replay)", () => {
		const first = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const second = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const eventsA = first.project(userMessage());
		const eventsB = second.project(userMessage());
		expect(eventsA[0]!.type).toBe("message_start");
		expect(eventsA[0]!.row.id).toBe("user:0");
		expect(eventsB[0]!.row.id).toBe(eventsA[0]!.row.id);
		expect(eventsA).toHaveLength(2); // start + end
	});

	it("projects assistant replay with thinking and tool call cycle", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const events = projector.project(assistantMessage());
		const starts = events.filter((event) => event.type === "message_start");
		const ends = events.filter((event) => event.type === "message_end");
		const toolStarts = events.filter((event) => event.type === "tool_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]!.row.id).toBe("assistant:1");
		expect(ends[0]!.status).toBe("succeeded");
		expect(toolStarts).toHaveLength(1);
		expect(toolStarts[0]!.row).toMatchObject({ kind: "tool", toolCallId: "call-1" });
	});

	it("replay tool call cycles release active presentation state", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		projector.project(assistantMessage());
		expect(projector.snapshot().activeToolPresentation["call-1"]).toBeUndefined();
	});

	it("maps live tui-event message flow to the same row id scheme", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const startEvent: TuiEvent = { type: "message_start", timestamp: 0, role: "assistant" };
		const start = projector.project({ kind: "tui-event", event: startEvent });
		expect(start[0]!.row.id).toBe("assistant:0");
		expect(projector.currentAssistantCorrelationId()).toBe("assistant:0");
	});

	it("tool start/update/end live flow uses the safe presentation and commits", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const start: TuiEvent = {
			type: "tool_execution_start",
			timestamp: 0,
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls -la", run_in_background: false },
		};
		const update: TuiEvent = {
			type: "tool_execution_update",
			timestamp: 1,
			toolCallId: "call-1",
			toolName: "bash",
			partialResult: { type: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], details: { stdoutChunk: "file-a\n" } },
		};
		const end: TuiEvent = {
			type: "tool_execution_end",
			timestamp: 2,
			toolCallId: "call-1",
			toolName: "bash",
			isError: false,
			result: { type: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], details: { exitCode: 0, durationMs: 12 } },
		};
		const events = [
			...projector.project({ kind: "tui-event", event: start }),
			...projector.project({ kind: "tui-event", event: update }),
			...projector.project({ kind: "tui-event", event: end }),
		];
		const toolUpdate = events.find((event) => event.type === "tool_update")!;
		const toolEnd = events.find((event) => event.type === "tool_end")!;
		expect(toolEnd.status).toBe("succeeded");
		expect(toolUpdate.presentation.state).toBe("known");
		// 原始命令文本不进入 body（只进 bounded metadata）
		expect(JSON.stringify(events)).not.toContain("ls -la");
	});

	it("stale/orphan/duplicate events are determined by the reducer, not the projector", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const orphanEnd: TuiEvent = { type: "message_end", timestamp: 9, role: "assistant", stopReason: "stop" };
		expect(projector.project({ kind: "tui-event", event: orphanEnd })).toHaveLength(1);
	});

	it("projector snapshots are reproducible (same seed -> same output)", () => {
		const a = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const b = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		a.project(userMessage());
		b.project(userMessage());
		expect(a.snapshot()).toEqual(b.snapshot());
	});

	it("cleanup events project deterministically", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const events = projector.project({ kind: "cleanup", reason: "abort", correlationId: "assistant:0" });
		expect(events).toEqual([{ type: "cleanup", generation: 0, correlationId: "assistant:0", reason: "abort" }]);
	});

	it("P2-2: global cleanup projects without a correlationId (reducer cleans all active rows)", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const events = projector.project({ kind: "cleanup", reason: "destroy" });
		expect(events).toEqual([{ type: "cleanup", generation: 0, reason: "destroy" }]);
		expect(events[0]).not.toHaveProperty("correlationId");
	});

	it("P1-2: shell chunks accumulate across updates and the final body keeps all chunks", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const start: TuiEvent = { type: "tool_execution_start", timestamp: 0, toolCallId: "call-1", toolName: "bash", args: {} };
		const updateA: TuiEvent = { type: "tool_execution_update", timestamp: 1, toolCallId: "call-1", toolName: "bash", partialResult: { type: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], details: { stdoutChunk: "first" } } };
		const updateB: TuiEvent = { type: "tool_execution_update", timestamp: 2, toolCallId: "call-1", toolName: "bash", partialResult: { type: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], details: { stdoutChunk: "second" } } };
		const end: TuiEvent = { type: "tool_execution_end", timestamp: 3, toolCallId: "call-1", toolName: "bash", isError: false, result: { type: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], details: { exitCode: 0 } } };
		const events = [
			...projector.project({ kind: "tui-event", event: start }),
			...projector.project({ kind: "tui-event", event: updateA }),
			...projector.project({ kind: "tui-event", event: updateB }),
			...projector.project({ kind: "tui-event", event: end }),
		];
		const finalUpdate = events.filter((event) => event.type === "tool_update").at(-1)!;
		expect(finalUpdate.presentation.state).toBe("known");
		if (finalUpdate.presentation.state === "known") {
			const bodyText = finalUpdate.presentation.value.body.map((block) => (block.kind === "text" ? block.content.text : "")).join("");
			expect(bodyText).toContain("first");
			expect(bodyText).toContain("second");
		}
		// tool end 后累积状态释放（内存不持续占用）
		const snapshot = projector.snapshot();
		expect(snapshot.shellChunks["call-1"]).toBeUndefined();
		expect(snapshot.activeToolPresentation["call-1"]).toBeUndefined();
	});
});
