/** `runledger workspace` 子命令测试：只读能力矩阵，不连接 Host、不伪造 sandbox。 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env },
	});
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describe("runledger workspace capability", () => {
	it("prints the evidence-backed capability matrix without sandbox claims", () => {
		const r = runCli(["workspace", "capability"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("workspace capability");
		expect(r.stdout).toContain("linux     path=verified");
		expect(r.stdout).toContain("macos     path=unverified");
		expect(r.stdout).toContain("windows   path=unverified");
		expect(r.stdout).not.toContain("sandbox enforced");
		expect(r.stdout).toContain("evidence-verification-gaps.md");
	});

	it("reports the current runner as verified only on Linux", () => {
		const r = runCli(["workspace", "capability"]);
		expect(r.status).toBe(0);
		if (process.platform === "linux") expect(r.stdout).toContain("current runner: linux (verified)");
		else expect(r.stdout).toContain("(unverified)");
	});

	it("rejects unknown subcommands and shows usage", () => {
		const r = runCli(["workspace", "bogus"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown workspace command");
		expect(r.stderr).toContain("usage: runledger workspace");
	});

	it("prints usage for --help without connecting to a Host", () => {
		const r = runCli(["workspace", "--help"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("usage: runledger workspace");
	});
});
