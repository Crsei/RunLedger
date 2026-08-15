import { describe, expect, it } from "vitest";
import type { HighlightColor } from "../../src/tui/highlight/contracts.ts";
import { execPrefixColor } from "../../src/tui/opentui/exec-renderable.ts";
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
