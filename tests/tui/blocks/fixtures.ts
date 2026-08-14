import type { PresentationBlock } from "../../../src/tui/presentation.ts";
import type { SafeDiffDocument } from "../../../src/tui/presentation/tools/types.ts";

export interface PlanDisplayFixture {
	readonly explanation?: string;
	readonly steps: readonly { readonly status: "pending" | "in-progress" | "completed"; readonly text: string }[];
}

const bounded = (text: string) => ({
	text,
	truncated: false,
	byteLength: new TextEncoder().encode(text).byteLength,
});

const baselineDiff: SafeDiffDocument = {
	kind: "document",
	path: bounded("src/example.ts"),
	hunks: [
		{
			oldStart: 10,
			newStart: 10,
			lines: [
				{ kind: "context", oldLine: 10, newLine: 10, text: bounded("const before = true;") },
				{ kind: "delete", oldLine: 11, text: bounded("const value = 1;") },
				{ kind: "add", newLine: 11, text: bounded("const value = 2;") },
			],
		},
	],
	addedLines: { state: "known", value: 1 },
	removedLines: { state: "known", value: 1 },
	truncated: false,
};

export const sessionDisplayFixtures = {
	plan: {
		complete: {
			explanation: "Replicate the session display",
			steps: [
				{ status: "completed", text: "Inspect the Codex cell layout" },
				{ status: "in-progress", text: "Implement the OpenTUI projection" },
				{ status: "pending", text: "Run the visual acceptance gates" },
			],
		} satisfies PlanDisplayFixture,
		empty: { steps: [] } satisfies PlanDisplayFixture,
	},
	exec: {
		short: {
			kind: "exec",
			command: "printf 'hello'",
			status: "succeeded",
			output: [{ channel: "stdout", text: "hello" }],
			exitCode: 0,
			durationMs: 42,
		} satisfies PresentationBlock,
		longOutput: {
			kind: "exec",
			command: "npm test",
			status: "running",
			output: Array.from({ length: 8 }, (_, index) => ({ channel: "stdout" as const, text: `line-${index}` })),
		} satisfies PresentationBlock,
		multilineCommand: {
			kind: "exec",
			command: "printf 'first\\nsecond' && printf 'third'",
			status: "running",
			output: [],
			background: true,
		} satisfies PresentationBlock,
		failed: {
			kind: "exec",
			command: "false",
			status: "failed",
			output: [{ channel: "stderr", text: "command failed" }],
			exitCode: 7,
			durationMs: 1250,
		} satisfies PresentationBlock,
		baseline: {
			kind: "exec",
			command: "echo baseline",
			status: "succeeded",
			output: [{ channel: "stdout", text: "baseline" }],
			exitCode: 0,
			durationMs: 12,
		} satisfies PresentationBlock,
	},
	diff: {
		contextAddDeleteCrossHunk: {
			kind: "document",
			path: bounded("src/example.ts"),
			hunks: [
				...baselineDiff.hunks,
				{
					oldStart: 30,
					newStart: 31,
					lines: [
						{ kind: "context", oldLine: 30, newLine: 31, text: bounded("return value;") },
						{ kind: "delete", oldLine: 31, text: bounded("unused();") },
						{ kind: "add", newLine: 32, text: bounded("await used();") },
					],
				},
			],
			addedLines: { state: "known", value: 2 },
			removedLines: { state: "known", value: 2 },
			truncated: false,
		} satisfies SafeDiffDocument,
		baseline: {
			kind: "diff",
			document: baselineDiff,
		} satisfies PresentationBlock,
	},
	separator: {
		worked: { kind: "separator", label: "stop · Worked for 12s" } satisfies PresentationBlock,
		workedWithMetrics: { label: "Worked for 12s", metrics: ["2 tools", "1.2k tokens"] },
		baseline: { kind: "separator", label: "stop · Worked for 12s" } satisfies PresentationBlock,
	},
} as const;
