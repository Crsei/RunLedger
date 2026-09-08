import { describe, expect, it, vi } from "vitest";
import type { HighlightColor } from "../../src/tui/highlight/contracts.ts";
import { execPrefixColor, plainExecText } from "../../src/tui/opentui/exec-renderable.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";

type ExecBlock = Extract<PresentationBlock, { readonly kind: "exec" }>;

function block(status: ExecBlock["status"]): ExecBlock {
	return {
		kind: "exec",
		command: "printf ok",
		status,
		output: [],
	};
}

describe("exec semantic prefix color", () => {
	it("uses the theme resolver for the status semantic scopes", () => {
		let scopes: readonly string[] = [];
		const color: HighlightColor = { kind: "rgb", r: 12, g: 34, b: 56 };

		const result = execPrefixColor(block("succeeded"), (resolvedScopes) => {
			scopes = resolvedScopes;
			return color;
		});

		expect(scopes).toEqual(["markup.inserted", "string.other", "success"]);
		expect(result.toInts().slice(0, 3)).toEqual([12, 34, 56]);
	});

	it("keeps status-specific semantic fallback colors when no theme is available", () => {
		expect(execPrefixColor(block("succeeded"), () => undefined).slot).toBe(2);
		expect(execPrefixColor(block("failed"), () => undefined).slot).toBe(1);
		expect(execPrefixColor(block("running"), () => undefined).slot).toBe(3);
	});
});

describe("exec text projection reuse", () => {
	it("does not repeat Unicode wrapping for unchanged historical output", () => {
		const historical = { ...block("succeeded"), output: [{ channel: "stdout" as const, text: "中文 👩‍💻 output\n".repeat(80) }] };
		const expected = plainExecText(historical, 40);
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		try {
			for (let frame = 0; frame < 32; frame++) expect(plainExecText(historical, 40)).toBe(expected);
			expect(segment).not.toHaveBeenCalled();
		} finally { segment.mockRestore(); }
	});

	it("invalidates for width, output, command and status changes even with the same object", () => {
		const output = [{ channel: "stdout" as const, text: "old-output" }];
		const current: ExecBlock = { ...block("running"), output };
		const first = plainExecText(current, 80);
		expect(first).toContain("Running printf ok");
		output[0]!.text = "new-output 中文 👩‍💻";
		current.command = "printf updated";
		current.status = "succeeded";
		current.background = true;
		const updated = plainExecText(current, 80);
		expect(updated).toContain("Ran printf updated");
		expect(updated).toContain("(bg)");
		expect(updated).toContain("new-output 中文 👩‍💻");
		expect(updated).not.toContain("old-output");
		expect(plainExecText(current, 16)).not.toBe(updated);
		expect(plainExecText(current, 80)).toBe(updated);
		current.outputMaxLines = 1;
		output.push({ channel: "stdout", text: "second\nthird" });
		expect(plainExecText(current, 80)).toContain("Ctrl+T for transcript");
	});
});
