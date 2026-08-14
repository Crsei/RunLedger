import { describe, expect, it } from "vitest";
import { diffDisplayLines } from "../../../src/tui/opentui/diff-renderable.ts";
import type { PresentationBlock } from "../../../src/tui/presentation.ts";

const bounded = (text: string) => ({
	text,
	truncated: false,
	byteLength: new TextEncoder().encode(text).byteLength,
});

function documentWith(lines: readonly {
	kind: "context" | "delete" | "add";
	oldLine?: number;
	newLine?: number;
	text: string;
}[]) {
	return {
		kind: "document" as const,
		path: bounded("src/example.ts"),
		hunks: [{
			oldStart: 9,
			newStart: 9,
			lines: lines.map((line) => line.kind === "context"
				? { kind: line.kind, oldLine: line.oldLine ?? 1, newLine: line.newLine ?? 1, text: bounded(line.text) }
				: line.kind === "delete"
					? { kind: line.kind, oldLine: line.oldLine ?? 1, text: bounded(line.text) }
					: { kind: line.kind, newLine: line.newLine ?? 1, text: bounded(line.text) }),
		}],
		addedLines: { state: "known" as const, value: lines.filter((line) => line.kind === "add").length },
		removedLines: { state: "known" as const, value: lines.filter((line) => line.kind === "delete").length },
		truncated: false,
	};
}

function diffBlock(document: ReturnType<typeof documentWith>, options: Partial<Extract<PresentationBlock, { kind: "diff" }>> = {}): Extract<PresentationBlock, { kind: "diff" }> {
	return { kind: "diff", document, ...options };
}

describe("Codex-style diff gutter projection", () => {
	it("right-aligns old/new line numbers using the widest line number", () => {
		const block = diffBlock(documentWith([
			{ kind: "context", oldLine: 9, newLine: 90, text: "context" },
			{ kind: "delete", oldLine: 100, text: "removed" },
			{ kind: "add", newLine: 101, text: "added" },
		]));

		expect(diffDisplayLines(block)).toEqual([
			"diff src/example.ts (+1 -1)",
			" 90  context",
			"100 -removed",
			"101 +added",
		]);
	});

	it("keeps the pre-gutter text when line numbers are disabled", () => {
		const block = diffBlock(documentWith([
			{ kind: "context", text: "context" },
			{ kind: "delete", text: "removed" },
			{ kind: "add", text: "added" },
		]), { showLineNumbers: false });

		expect(diffDisplayLines(block)).toEqual([
			"diff src/example.ts (+1 -1)",
			"  context",
			"- removed",
			"+ added",
		]);
	});

	it("honors an explicit gutter width without changing line selection", () => {
		const block = diffBlock(documentWith([
			{ kind: "delete", oldLine: 7, text: "removed" },
			{ kind: "add", newLine: 8, text: "added" },
		]), { lineNumberWidth: 4 });

		expect(diffDisplayLines(block).slice(1)).toEqual([
			"   7 -removed",
			"   8 +added",
		]);
	});
});
