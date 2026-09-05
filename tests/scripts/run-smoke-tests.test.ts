import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runBuiltCliSmoke } from "../../scripts/run-smoke-tests.ts";

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

		expect(result.status, result.stderr).toBe(0);
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
		expect(evidence.tty).toEqual({
			runner: "tmux", startup: "observed", cleanExit: "observed",
			readyMarkers: ["Message RunLedger"],
			startupFrameDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			launcherPid: expect.any(Number), exitCode: 0, remainingDescendants: 0,
		});
	});
});


type FixtureMode = "fatal" | "exit-one" | "premature-exit" | "leaked-child";

async function createSmokeFixture(mode: FixtureMode | "ready-without-title"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-smoke-negative-"));
	await mkdir(join(root, "bin"));
	await mkdir(join(root, "dist/cli"), { recursive: true });
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await writeFile(join(root, "dist/cli/cli.js"), "// Negative CLI smoke fixture.\n");
	await writeFile(join(root, "dist/host-build-manifest.json"), JSON.stringify({ format: "runledger-host-build-current", contentDigest: {} }));
	await writeFile(join(root, "bin/runledger.js"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv.includes("--help") || process.argv.includes("--version")) { console.log("fixture"); process.exit(0); }
const mode = ${JSON.stringify(mode)};
if (mode === "fatal") console.log("[runledger] fatal: fixture startup failed");
else if (mode === "ready-without-title") console.log("Session\\nmodel: fixture\\n› Message RunLedger…");
else console.log("RunLedger v0.0.1\\nHarness: standard@1\\nWelcome back!\\nCtrl+D to exit\\n› Message RunLedger…");
if (mode === "premature-exit") process.exit(0);
if (mode === "leaked-child") {
  const leaked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  writeFileSync("leaked.pid", String(leaked.pid));
  leaked.unref();
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", () => process.exit(mode === "fatal" || mode === "exit-one" ? 1 : 0));
`);
	return root;
}

it("accepts a ready input frame when the welcome title is above the viewport", async () => {
	const root = await createSmokeFixture("ready-without-title");
	try {
		const evidence = await runBuiltCliSmoke({ repoRoot: root, withPty: true });
		expect(evidence.tty).toMatchObject({ startup: "observed", cleanExit: "observed", exitCode: 0, remainingDescendants: 0 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);

describe("built CLI smoke negative acceptance", () => {
	it.each(["fatal", "exit-one", "premature-exit", "leaked-child"] as const)("rejects %s instead of declaring a clean TUI run", async (mode) => {
		const root = await createSmokeFixture(mode);
		try {
			const errors: Record<FixtureMode, RegExp> = {
				fatal: /startup reported a fatal error/,
				"exit-one": /did not exit cleanly \(exit 1\)/,
				"premature-exit": /exited before ready interaction/,
				"leaked-child": /left descendant processes running/,
			};
			await expect(runBuiltCliSmoke({ repoRoot: root, withPty: true })).rejects.toThrow(errors[mode]);
		} finally {
			try {
				const pid = Number(await readFile(join(root, "leaked.pid"), "utf8"));
				process.kill(pid, "SIGKILL");
			} catch { /* 未创建子进程，或 runner 已经清理。 */ }
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
