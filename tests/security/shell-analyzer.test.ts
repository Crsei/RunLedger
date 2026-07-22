import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../../src/security/permission/shell-analyzer.ts";

describe("shell analyzer", () => {
	it("normalizes every chained segment including env and wrappers", () => {
		expect(analyzeShellCommand("FOO=bar env X=1 timeout -k 1 2 rg needle . && git status")).toEqual({
			analysis: "known",
			segments: [
				{ raw: "FOO=bar env X=1 timeout -k 1 2 rg needle .", executable: "rg", arguments: ["needle", "."] },
				{ raw: "git status", executable: "git", arguments: ["status"] },
			],
			reasonCodes: [],
		});
	});

	it.each([
		["echo $(rm -rf x)", "unsupported_shell_syntax"],
		["rg --pre evil needle .", "rg_preprocessor"],
		["cat x > out", "unsupported_shell_syntax"],
		["cmd & other", "unsupported_shell_syntax"],
		["sudo ls", "unsafe_wrapper:sudo"],
	])("classifies unsupported or unsafe syntax: %s", (command, reason) => {
		const result = analyzeShellCommand(command);
		expect(result.analysis).toBe("unknown");
		expect(result.reasonCodes).toContain(reason);
	});
});
