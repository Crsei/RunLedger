import { describe, expect, it } from "vitest";
import { stripShellLoginWrapper } from "../../src/tui/opentui/exec-renderable.ts";

describe("exec command display normalization", () => {
	it("strips conservative bash/zsh -lc wrappers", () => {
		expect(stripShellLoginWrapper("bash -lc 'echo hello'")).toBe("echo hello");
		expect(stripShellLoginWrapper('/bin/bash -lc "printf \\\"hi\\\""')).toBe('printf "hi"');
		expect(stripShellLoginWrapper("/usr/bin/zsh -lc 'python3 -c \\\'print(1)\\\''")).toBe("python3 -c 'print(1)'");
	});

	it("leaves raw scripts and Windows command strings unchanged", () => {
		expect(stripShellLoginWrapper("echo hello && pwd")).toBe("echo hello && pwd");
		const windows = 'C:\\Program Files\\Git\\bin\\bash.exe -lc "echo hi"';
		expect(stripShellLoginWrapper(windows)).toBe(windows);
	});
});
