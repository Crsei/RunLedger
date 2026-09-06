import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";

describe("CLI agent mode", () => {
	it.each(["default", "minimal", "plan"])("parses explicit mode %s", (mode) => {
		const parsed = parseArgs(["--mode", mode]);
		expect(parsed.error).toBeUndefined();
		expect(parsed.args.mode).toBe(mode);
	});
	it.each([["--mode"], ["--mode", "review"], ["--mode", "minimal", "--harness-profile", "standard"]])("rejects invalid or conflicting mode arguments %j", (...argv) => {
		expect(parseArgs(argv).error).toBeDefined();
	});
	it("accepts matching legacy and canonical arguments in either order", () => {
		expect(parseArgs(["--mode", "minimal", "--harness-profile", "minimal"]).error).toBeUndefined();
		expect(parseArgs(["--harness-profile", "standard", "--mode", "default"]).error).toBeUndefined();
	});
});
