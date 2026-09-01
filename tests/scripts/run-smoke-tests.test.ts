import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const CLI_SMOKE_SCHEMA_ID = ["runledger", "cli-smoke", "v" + "1"].join(".");

describe("built CLI smoke runner", () => {
	it("runs the packaged bin help and version against an isolated RunLedger home", () => {
		const inheritedHome = "/tmp/runledger-smoke-must-not-inherit";
		const result = spawnSync(process.execPath, [
			"--import",
			"tsx",
			"scripts/run-smoke-tests.ts",
			"--repo-root", repoRoot, "--with-pty",
		], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, RUNLEDGER_DIR: inheritedHome },
		});

		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain(inheritedHome);
		const evidence = JSON.parse(result.stdout) as {
			schemaId: string;
			candidate: { bin: string; cli: string; manifest: string; digests: Record<string, string> };
			commands: Array<{ argv: string[]; exitCode: number | null }>;
			isolation: { runledgerDir: "temporary"; cleanup: "removed" };
			tty: { runner: "tmux"; startup: "observed"; cleanExit: "observed" };
		};
		expect(evidence.schemaId).toBe(CLI_SMOKE_SCHEMA_ID);
		expect(evidence.candidate).toMatchObject({
			bin: "bin/runledger.js",
			cli: "dist/cli/cli.js",
			manifest: "dist/host-build-manifest.json",
		});
		expect(evidence.candidate.digests).toEqual({
			bin: expect.stringMatching(/^[a-f0-9]{64}$/),
			cli: expect.stringMatching(/^[a-f0-9]{64}$/),
			manifest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(evidence.commands).toEqual([
			{ argv: ["--version"], exitCode: 0 },
			{ argv: ["--help"], exitCode: 0 },
		]);
		expect(evidence.isolation).toEqual({ runledgerDir: "temporary", cleanup: "removed" });
		expect(evidence.tty).toEqual({ runner: "tmux", startup: "observed", cleanExit: "observed" });
	});
});
