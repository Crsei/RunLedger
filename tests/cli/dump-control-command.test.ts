import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { controlCommandHelp, controlCommandQueryOperation, controlCommandRequest, parseControlCommand } from "../../src/cli/control-commands.ts";
import { rmSyncRetry } from "../helpers/cleanup.ts";

const CLI_PATH = resolve("src/cli/cli.ts");
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSyncRetry(root);
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "runledger-dump-cli-"));
	roots.push(root);
	const home = join(root, "state");
	const userHome = join(root, "user");
	const workspace = join(root, "workspace");
	for (const directory of [home, userHome, workspace]) mkdirSync(directory, { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: userHome,
		USERPROFILE: userHome,
		RUNLEDGER_DIR: home,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_RUNTIME_DIR: root,
	};
	return {
		run: (args: string[]) => {
			const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
				cwd: workspace, env, encoding: "utf8", timeout: 20_000, input: "",
			});
			expect(result.error, result.stderr).toBeUndefined();
			return { status: result.status, stdout: result.stdout, stderr: result.stderr };
		},
	};
}

describe("runledger dump control command", () => {
	it("maps the dump group to the read-only prompt inspection", () => {
		const parsed = parseControlCommand(["dump"]);
		expect(parsed).toMatchObject({ ok: true, command: { group: "dump", action: "inspect", args: [], mutation: false } });
		if (parsed?.ok !== true) throw new Error("dump command did not parse");
		expect(controlCommandRequest(parsed.command)).toEqual({ operation: "session.request.inspect", body: { view: "request" }, mutation: false });
		expect(controlCommandQueryOperation(parsed.command)).toBeUndefined();
		expect(controlCommandHelp()).toContain("runledger dump");
		expect(parseControlCommand(["dump", "reset"])).toEqual({ ok: false, error: "unsupported dump action: reset" });
	});

	it("does not invent a request when a new owner has not dispatched one", () => {
		const result = fixture().run(["dump"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("No provider request captured");
	}, 40_000);

	it("exports base text only when explicitly requested, with metadata on stderr", () => {
		const result = fixture().run(["dump", "base"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.length).toBeGreaterThan(0);
		expect(result.stdout).not.toContain("## Configuration");
		expect(result.stderr).toContain('"layer":"base-prompt"');
		expect(result.stderr).toContain('"view":"base"');
	}, 40_000);
});
