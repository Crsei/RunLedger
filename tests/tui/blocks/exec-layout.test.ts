import { describe, expect, it } from "vitest";
import { displayWidth } from "../../../src/tui/mermaid/display-width.ts";
import { EXEC_CONTINUATION_MAX_LINES, EXEC_CONTINUATION_PREFIX, EXEC_OUTPUT_MAX_LINES, EXEC_OUTPUT_MAX_LINES_USER_SHELL, EXEC_OUTPUT_PREFIX, EXEC_TRUNCATION_HINT } from "../../../src/tui/opentui/block-layout.ts";
import { execDisplayLines } from "../../../src/tui/opentui/exec-renderable.ts";
import { projectToolStart, rendererForTool } from "../../../src/tui/presentation/tools/projector.ts";
import type { PresentationBlock } from "../../../src/tui/presentation.ts";
import { rowToBlocks } from "../../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../../src/tui/timeline/types.ts";

const startedAt = "2026-08-14T00:00:00.000Z";

function toolRow(toolName: string, presentation: ReturnType<typeof projectToolStart>): TimelineRow {
	return {
		kind: "tool",
		id: `tool:${toolName}`,
		timestamp: startedAt,
		displayOrder: 0,
		status: "running",
		toolCallId: `call:${toolName}`,
		toolName: { text: toolName, truncated: false, byteLength: new TextEncoder().encode(toolName).byteLength },
		presentation: { state: "known", value: presentation },
	};
}

describe("S2 exec layout projection", () => {
	it("assigns Codex layout fields and output budgets by shell kind", () => {
		expect(rendererForTool("!")).toBe("shell");
		const tool = projectToolStart("bash", { command: "printf one\\nprintf two" }, startedAt);
		const userShell = projectToolStart("!", { command: "printf one" }, startedAt);
		expect(tool.exec).toEqual({
			continuationPrefix: EXEC_CONTINUATION_PREFIX,
			continuationMaxLines: EXEC_CONTINUATION_MAX_LINES,
			outputPrefix: EXEC_OUTPUT_PREFIX,
			outputMaxLines: EXEC_OUTPUT_MAX_LINES,
			transcriptForm: "dollar",
		});
		expect(userShell.exec?.outputMaxLines).toBe(EXEC_OUTPUT_MAX_LINES_USER_SHELL);

		const block = rowToBlocks(toolRow("bash", tool))[0];
		expect(block).toMatchObject({
			kind: "exec",
			continuationPrefix: EXEC_CONTINUATION_PREFIX,
			continuationMaxLines: EXEC_CONTINUATION_MAX_LINES,
			outputPrefix: EXEC_OUTPUT_PREFIX,
			outputMaxLines: EXEC_OUTPUT_MAX_LINES,
			transcriptForm: "dollar",
		});
	});

	it("renders command continuation and middle-truncated output with bounded screen lines", () => {
		const block = {
			kind: "exec",
			command: "echo first\necho second\necho third",
			status: "running",
			output: Array.from({ length: 8 }, (_, index) => ({ channel: "stdout" as const, text: `line-${index}` })),
			outputMaxLines: 5,
		} satisfies PresentationBlock;
		const lines = execDisplayLines(block, 60);
		expect(lines).toContain("$ echo first");
		expect(lines).toContain("  │ echo second");
		expect(lines.some((line) => line.startsWith("  │ echo third"))).toBe(true);
		expect(lines.filter((line) => line.startsWith("  │ "))).toHaveLength(2);
		expect(lines).toContain("  └ line-0");
		expect(lines).toContain(`    … +4 lines ${EXEC_TRUNCATION_HINT}`);
		expect(lines).toContain("    line-7");
		expect(lines.every((line) => displayWidth(line) <= 60)).toBe(true);
	});

	it("shows no output, failure exit, duration, and background marker", () => {
		const lines = execDisplayLines({
			kind: "exec",
			command: "false",
			status: "failed",
			output: [],
			exitCode: 7,
			durationMs: 1_250,
			background: true,
		}, 80);
		expect(lines).toContain("  └ (no output)");
		expect(lines.some((line) => line.includes("✗ (7) • 1.3s"))).toBe(true);
		expect(lines.some((line) => line.includes("(bg)"))).toBe(true);
	});

	it("wraps a long single output line before applying the output budget", () => {
		const lines = execDisplayLines({
			kind: "exec",
			command: "printf long",
			status: "succeeded",
			output: [{ channel: "stdout", text: "x".repeat(240) }],
			outputMaxLines: 5,
		}, 24);
		expect(lines.every((line) => displayWidth(line) <= 24)).toBe(true);
		expect(lines.filter((line) => line.startsWith("  └ ") || line.startsWith("    "))).toHaveLength(5);
	});
});
