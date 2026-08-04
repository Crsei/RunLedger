import { describe, expect, it } from "vitest";
import { analyzeShellCommand, hardlineShellDenialReason } from "../../src/security/permission/shell-analyzer.ts";

describe("conservative shell analyzer", () => {
	it("normalizes chained commands and finite wrappers", () => {
		expect(analyzeShellCommand("FOO=bar env X=1 timeout -k 1 2 rg needle . && git status")).toEqual({
			analysis: "known",
			segments: [
				{ raw: "FOO=bar env X=1 timeout -k 1 2 rg needle .", executable: "rg", arguments: ["needle", "."] },
				{ raw: "git status", executable: "git", arguments: ["status"] },
			],
			reasonCodes: [],
		});
	});

	it("recognizes uniq as a known executable", () => {
		expect(analyzeShellCommand("uniq input.txt")).toMatchObject({
			analysis: "known",
			segments: [{ executable: "uniq", arguments: ["input.txt"] }],
			reasonCodes: [],
		});
	});

	it.each([
		["echo $(rm -rf x)", "unsupported_shell_syntax"],
		["rg --pre evil needle .", "rg_preprocessor"],
		["cat x > out", "unsupported_shell_syntax"],
		["cmd & other", "unsupported_shell_syntax"],
		["sudo ls", "unsafe_wrapper:sudo"],
	] as const)("classifies unsafe syntax: %s", (command, reason) => {
		const result = analyzeShellCommand(command);
		expect(result.analysis).toBe("unknown");
		expect(result.reasonCodes).toContain(reason);
	});

	it("hard-denies catastrophic nested commands", () => {
		expect(hardlineShellDenialReason("bash -c 'rm -rf /'")).toBe("system_root_delete");
		expect(hardlineShellDenialReason("echo 'rm -rf /'")).toBeUndefined();
	});
});
