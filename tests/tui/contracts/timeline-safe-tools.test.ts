import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	SafeBoundedText,
	SafeDiffDocument,
	SafeMediaView,
	SafeToolInputMetadata,
	SafeToolPresentation,
	SafeToolResultMetadata,
	SafeToolUsageView,
} from "../../../src/tui/presentation/tools/types.ts";
import type {
	TimelineEvent,
	TimelineProjectionCursor,
	TimelineRow,
	TimelineState,
	TimelineStatus,
} from "../../../src/tui/timeline/types.ts";

function expectCloneable(value: unknown): void {
	expect(structuredClone(value)).toEqual(value);
}

describe("passive Timeline and safe tool contracts", () => {
	it("has the P2 type-only modules before exercising safe fixtures", () => {
		for (const relativePath of [
			"src/tui/timeline/types.ts",
			"src/tui/presentation/tools/types.ts",
		]) {
			const path = join(process.cwd(), relativePath);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("export");
		}
	});

	it("represents every timeline row and lifecycle event without renderer data", () => {
		const status: TimelineStatus[] = [
			"pending",
			"running",
			"succeeded",
			"failed",
			"cancelled",
			"aborted",
		];
		const bounded: SafeBoundedText = {
			text: "bounded",
			truncated: false,
			byteLength: 7,
		};
		const rows: TimelineRow[] = [
			{ kind: "user", id: "user-1", timestamp: "2026-08-05T00:00:00.000Z", displayOrder: 1, status: "succeeded", text: bounded },
			{ kind: "assistant", id: "assistant-1", timestamp: "2026-08-05T00:00:01.000Z", displayOrder: 2, status: "running", text: bounded, streaming: true, thinking: bounded, usage: { input: { state: "unavailable", reason: "not reported" }, output: { state: "unavailable", reason: "not reported" } } },
			{ kind: "tool", id: "tool-1", timestamp: "2026-08-05T00:00:02.000Z", displayOrder: 3, status: "succeeded", toolCallId: "call-1", toolName: bounded, presentation: { state: "ready", value: { renderer: "generic", title: bounded, chips: [], body: [], timestamps: { startedAt: "2026-08-05T00:00:02.000Z" } } } },
			{ kind: "notice", id: "notice-1", timestamp: "2026-08-05T00:00:03.000Z", displayOrder: 4, status: "succeeded", severity: "info", message: bounded },
			{ kind: "goal", id: "goal-1", timestamp: "2026-08-05T00:00:04.000Z", displayOrder: 5, status: "running", goalId: "goal-1", label: bounded, phase: bounded },
			{ kind: "queue", id: "queue-1", timestamp: "2026-08-05T00:00:05.000Z", displayOrder: 6, status: "pending", queueId: "queue-1", state: "pending", label: bounded },
			{ kind: "agent", id: "agent-1", timestamp: "2026-08-05T00:00:06.000Z", displayOrder: 7, status: "running", agentId: "agent-1", label: bounded, phase: bounded },
		];
		const cursor: TimelineProjectionCursor = {
			messageIndex: 2,
			activeMessageId: "assistant-1",
			toolStepCorrelationId: "call-1",
		};
		const timeline: TimelineState = {
			generation: 1,
			committedRows: rows.slice(0, 1),
			activeRowsByCorrelationId: { "call-1": rows[2]! },
			activeOrder: ["call-1"],
			cursor,
		};
		const events: TimelineEvent[] = [
			{ type: "message_start", generation: 1, correlationId: "message-1", row: rows[0]! },
			{ type: "message_update", generation: 1, correlationId: "message-1", text: bounded, thinking: bounded },
			{ type: "message_end", generation: 1, correlationId: "message-1", status: "succeeded" },
			{ type: "tool_start", generation: 1, correlationId: "call-1", row: rows[2]! },
			{ type: "tool_update", generation: 1, correlationId: "call-1", presentation: { state: "unavailable", reason: "not yet safe" } },
			{ type: "tool_end", generation: 1, correlationId: "call-1", status: "succeeded" },
			{ type: "usage", generation: 1, correlationId: "message-1", usage: { input: { state: "unavailable", reason: "provider did not report" }, output: { state: "unavailable", reason: "provider did not report" } } },
			{ type: "notice", generation: 1, correlationId: "notice-1", severity: "warning", message: bounded },
			{ type: "goal_lifecycle", generation: 1, correlationId: "goal-1", goalId: "goal-1", status: "running" },
			{ type: "agent_lifecycle", generation: 1, correlationId: "agent-1", agentId: "agent-1", status: "running" },
			{ type: "cleanup", generation: 1, correlationId: "message-1", reason: "session-switch" },
		];
		expect(status).toHaveLength(6);
		expectCloneable({ timeline, events });
	});

	it("keeps tool metadata bounded and separates lifecycle from safe result details", () => {
		const path: SafeBoundedText = { text: "src/example.ts", truncated: false, byteLength: 14 };
		const input: SafeToolInputMetadata[] = [
			{ kind: "generic" },
			{ kind: "edit", path, editCount: { state: "known", value: 1 } },
			{ kind: "write", path, lineCount: { state: "known", value: 2 }, byteCount: { state: "known", value: 12 } },
			{ kind: "read", path, offset: { state: "known", value: 0 }, limit: { state: "known", value: 2 } },
			{ kind: "grep", path },
			{ kind: "shell", commandLabel: path },
		];
		const diff: SafeDiffDocument = {
			kind: "document",
			path,
			hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "context", oldLine: 1, newLine: 1, text: path }] }],
			addedLines: { state: "known", value: 0 },
			removedLines: { state: "known", value: 0 },
			truncated: false,
		};
		const media: SafeMediaView = {
			mimeType: "image/png",
			byteCount: { state: "known", value: 12 },
			artifact: { state: "unavailable", reason: "not recorded" },
			truncated: false,
		};
		const result: SafeToolResultMetadata[] = [
			{ kind: "generic" },
			{ kind: "edit", document: diff, addedLines: { state: "known", value: 0 }, removedLines: { state: "known", value: 0 } },
			{ kind: "read", lineCount: { state: "known", value: 2 }, truncated: false },
			{ kind: "grep", matchCount: { state: "known", value: 1 }, fileCount: { state: "known", value: 1 }, samples: [path], truncated: false },
			{ kind: "media", items: [media] },
			{ kind: "shell", chunks: [{ channel: "stdout", text: path }], truncated: false, exitCode: { state: "known", value: 0 }, durationMs: { state: "known", value: 1 }, background: false },
			{ kind: "goal", goalId: "goal-1", phase: path, revision: 1, evidenceCount: { state: "known", value: 1 } },
		];
		const usage: SafeToolUsageView = {
			input: { state: "unavailable", reason: "not reported" },
			output: { state: "estimated", value: 2 },
			accounting: "non-billable",
		};
		const presentation: SafeToolPresentation = {
			renderer: "generic",
			title: path,
			chips: [{ label: path, tone: "neutral" }],
			body: [{ kind: "text", content: path }],
			usage,
			timestamps: { startedAt: "2026-08-05T00:00:00.000Z", endedAt: "2026-08-05T00:00:01.000Z" },
		};
		expectCloneable({ input, result, media, diff, usage, presentation });
	});

	it("does not expose sensitive or unbounded field declarations", () => {
		const paths = [
			join(process.cwd(), "src/tui/timeline/types.ts"),
			join(process.cwd(), "src/tui/presentation/tools/types.ts"),
		];
		const missing = paths.filter((path) => !existsSync(path));
		expect(missing).toEqual([]);
		if (missing.length > 0) return;
		const source = paths.map((path) => readFileSync(path, "utf8")).join("\n");
		expect(source).not.toMatch(/\b(?:args|base64|credential|environment|before|after)\??\s*:/iu);
		expect(source).not.toMatch(/\b(?:Renderable|Component|Theme|AbortController|Promise|Map)\b/u);
	});
});
