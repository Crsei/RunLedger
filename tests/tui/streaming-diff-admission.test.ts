import { describe, expect, test } from "vitest";
import type { SafeDiffDocument } from "../../src/tui/presentation/tools/types.ts";
import { admitStreamingDiff } from "../../src/tui/opentui/streaming-diff-admission.ts";

const bounded = (text: string) => ({
	text,
	truncated: false,
	byteLength: Buffer.byteLength(text, "utf8"),
});

function documentWithHunks(): SafeDiffDocument {
	return {
		kind: "document",
		path: bounded("src/example.ts"),
		hunks: [
			{
				oldStart: 1,
				newStart: 1,
				lines: [
					{ kind: "context", oldLine: 1, newLine: 1, text: bounded("const one = 1;") },
					{ kind: "add", newLine: 2, text: bounded("const two = 2;") },
				],
			},
			{
				oldStart: 5,
				newStart: 5,
				lines: [{ kind: "delete", oldLine: 5, text: bounded("const oldValue = true;") }],
			},
		],
		addedLines: { state: "known", value: 1 },
		removedLines: { state: "known", value: 1 },
		truncated: false,
	};
}

describe("admitStreamingDiff", () => {
	test("admits complete lines and leaves only the open tail line mutable", () => {
		const result = admitStreamingDiff(documentWithHunks(), {
			streaming: true,
			openLine: { hunkIndex: 0, lineIndex: 1 },
		});

		expect(result.fallback).toBe("none");
		expect(result.admitted.map((line) => [line.hunkIndex, line.lineIndex])).toEqual([[0, 0], [1, 0]]);
		expect(result.tail.map((line) => [line.hunkIndex, line.lineIndex])).toEqual([[0, 1]]);
	});

	test("closes all lines in a hunk once the next hunk header has arrived", () => {
		const result = admitStreamingDiff(documentWithHunks(), {
			streaming: true,
			openLine: { hunkIndex: 1, lineIndex: 0 },
		});

		expect(result.admitted.map((line) => [line.hunkIndex, line.lineIndex])).toEqual([[0, 0], [0, 1]]);
		expect(result.tail.map((line) => [line.hunkIndex, line.lineIndex])).toEqual([[1, 0]]);
	});

	test("admits every line for a final diff frame", () => {
		const result = admitStreamingDiff(documentWithHunks(), { streaming: false });

		expect(result.admitted).toHaveLength(3);
		expect(result.tail).toEqual([]);
	});

	test("falls back to plain text when the streaming highlight budget is exceeded", () => {
		const result = admitStreamingDiff(documentWithHunks(), {
			streaming: true,
			openLine: { hunkIndex: 0, lineIndex: 1 },
			maxLines: 1,
			maxBytes: 8,
		});

		expect(result.fallback).toBe("budget");
		expect(result.admitted).toEqual([]);
		expect(result.tail).toHaveLength(3);
	});
});
