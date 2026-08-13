import { describe, expect, it } from "vitest";
import { TimelineEventProjector } from "../../../src/tui/timeline/event-projector.ts";
import { rowToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../../src/tui/timeline/types.ts";

const startedAt = "2026-08-09T00:00:00.000Z";

function textOf(row: TimelineRow): string {
	return rowToBlocks(row).map((block) => block.kind === "separator" ? block.label : block.content).join("\n");
}

function projectedTool(events: ReturnType<TimelineEventProjector["project"]>): TimelineRow {
	const start = events.find((event) => event.type === "tool_start");
	if (start?.type !== "tool_start") throw new Error("missing tool_start");
	return start.row;
}

describe("S7 canonical Timeline information equivalence", () => {
	it("preserves multiline user/assistant text and thinking without width truncation", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const userText = "first user line\nsecond user line with a long suffix that OpenTUI must wrap";
		const assistantText = "first assistant paragraph\n\nsecond assistant paragraph remains complete";
		const thinking = "inspect the durable state\nthen answer";

		const user = projector.project({
			kind: "tui-event",
			event: { type: "message_start", timestamp: 0, role: "user", message: { role: "user", content: [{ type: "text", text: userText }], timestamp: 0 } },
		})[0];
		const assistant = projector.project({
			kind: "tui-event",
			event: {
				type: "message_start",
				timestamp: 1,
				role: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking }, { type: "text", text: assistantText }],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 1,
				},
			},
		})[0];

		if (user?.type !== "message_start" || assistant?.type !== "message_start") throw new Error("missing message rows");
		expect(textOf(user.row)).toBe(userText);
		expect(rowToBlocks(assistant.row).map((block) => block.kind === "separator" ? block.label : block.content)).toEqual([thinking, assistantText]);
	});

	it("renders lifecycle icons, safe input metadata, bounded success text and errors", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const startEvents = projector.project({
			kind: "tui-event",
			event: { type: "tool_execution_start", timestamp: 0, toolCallId: "edit-1", toolName: "edit", args: { path: "src/example.ts", edits: [{ oldText: "secret-old", newText: "secret-new" }], apiKey: "sk-secret" } },
		});
		const running = projectedTool(startEvents);
		const runningText = textOf(running);
		expect(runningText).toContain("… edit");
		expect(runningText).toContain("src/example.ts");
		expect(runningText).toContain("1 edit");
		expect(runningText).not.toContain("sk-secret");
		expect(runningText).not.toContain("secret-old");

		const endEvents = projector.project({
			kind: "tui-event",
			event: { type: "tool_execution_end", timestamp: 5, toolCallId: "edit-1", toolName: "edit", result: { content: [{ type: "text", text: "Successfully edited src/example.ts" }], details: {}, isError: false }, isError: false },
		});
		const update = endEvents.find((event) => event.type === "tool_update");
		if (update?.type !== "tool_update" || update.presentation.state !== "known") throw new Error("missing tool update");
		const succeeded: TimelineRow = { ...running, status: "succeeded", presentation: update.presentation };
		expect(textOf(succeeded)).toContain("✓ edit");
		expect(textOf(succeeded)).toContain("Successfully edited src/example.ts");

		const failedProjector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const failedStart = projectedTool(failedProjector.project({ kind: "tui-event", event: { type: "tool_execution_start", timestamp: 0, toolCallId: "read-1", toolName: "read", args: { path: "missing.ts" } } }));
		const failedEvents = failedProjector.project({ kind: "tui-event", event: { type: "tool_execution_end", timestamp: 6, toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "not found" }], details: {}, isError: true }, isError: true } });
		const failedUpdate = failedEvents.find((event) => event.type === "tool_update");
		if (failedUpdate?.type !== "tool_update" || failedUpdate.presentation.state !== "known") throw new Error("missing failed update");
		const failed: TimelineRow = { ...failedStart, status: "failed", presentation: failedUpdate.presentation };
		expect(textOf(failed)).toContain("✗ read");
		expect(textOf(failed)).toContain("error: not found");
	});

	it("keeps bounded shell stdout/stderr tails, background, exit code and duration distinct", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const running = projectedTool(projector.project({ kind: "tui-event", event: { type: "tool_execution_start", timestamp: 0, toolCallId: "bash-1", toolName: "bash", args: { command: "npm test", run_in_background: true } } }));
		for (let index = 0; index < 240; index += 1) {
			projector.project({ kind: "tui-event", event: { type: "tool_execution_update", timestamp: index + 1, toolCallId: "bash-1", toolName: "bash", partialResult: { type: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [], details: index % 2 === 0 ? { stdoutChunk: `out-${index}\n` } : { stderrChunk: `err-${index}\n` } } } });
		}
		const endEvents = projector.project({ kind: "tui-event", event: { type: "tool_execution_end", timestamp: 250, toolCallId: "bash-1", toolName: "bash", result: { content: [], details: { exitCode: 0, durationMs: 1250, background: { summary: { state: "completed" } } }, isError: false }, isError: false } });
		const update = endEvents.find((event) => event.type === "tool_update");
		if (update?.type !== "tool_update" || update.presentation.state !== "known") throw new Error("missing shell update");
		const blocks = rowToBlocks({ ...running, status: "succeeded", presentation: update.presentation });
		expect(blocks).toHaveLength(1);
		const exec = blocks[0];
		if (exec?.kind !== "exec") throw new Error("missing structured exec block");
		expect(exec).toMatchObject({ command: "npm test", status: "succeeded", background: true, exitCode: 0, durationMs: 1250 });
		expect(exec.output.some((chunk) => chunk.channel === "stdout" && chunk.text === "out-238")).toBe(true);
		expect(exec.output.some((chunk) => chunk.channel === "stderr" && chunk.text === "err-239")).toBe(true);
		expect(exec.output.some((chunk) => chunk.text === "out-0" || chunk.text === "err-1")).toBe(false);
	});

	it("projects unified diff additions/deletions and an error without full before/after bodies", () => {
		const projector = new TimelineEventProjector({ messageIndex: 0, displayOrder: 0, startedAt });
		const running = projectedTool(projector.project({ kind: "tui-event", event: { type: "tool_execution_start", timestamp: 0, toolCallId: "edit-2", toolName: "edit", args: { path: "src/a.ts", edits: [{ oldText: "old secret body", newText: "new secret body" }] } } }));
		const endEvents = projector.project({ kind: "tui-event", event: { type: "tool_execution_end", timestamp: 2, toolCallId: "edit-2", toolName: "edit", result: { content: [], details: { diff: "@@ -1,2 +1,2 @@\n const a = 1;\n-old line\n+new line" }, isError: false }, isError: false } });
		const update = endEvents.find((event) => event.type === "tool_update");
		if (update?.type !== "tool_update" || update.presentation.state !== "known") throw new Error("missing diff update");
		const blocks = rowToBlocks({ ...running, status: "succeeded", presentation: update.presentation });
		const diff = blocks.find((block) => block.kind === "diff");
		if (diff?.kind !== "diff") throw new Error("missing structured diff block");
		expect(diff.document.path.text).toBe("src/a.ts");
		expect(diff.document.addedLines).toEqual({ state: "known", value: 1 });
		expect(diff.document.removedLines).toEqual({ state: "known", value: 1 });
		expect(diff.document.hunks[0]?.lines).toEqual([
			expect.objectContaining({ kind: "context", text: expect.objectContaining({ text: "const a = 1;" }) }),
			expect.objectContaining({ kind: "delete", text: expect.objectContaining({ text: "old line" }) }),
			expect.objectContaining({ kind: "add", text: expect.objectContaining({ text: "new line" }) }),
		]);
		expect(JSON.stringify(blocks)).not.toContain("old secret body");
		expect(JSON.stringify(blocks)).not.toContain("new secret body");
	});
});
