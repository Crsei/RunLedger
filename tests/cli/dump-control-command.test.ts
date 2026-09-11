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
			expect(result.stdout, result.stderr).not.toBe("");
			return { status: result.status, body: JSON.parse(result.stdout) as Record<string, unknown> };
		},
	};
}

describe("runledger dump control command", () => {
	it("maps the dump group to the read-only prompt inspection", () => {
		const parsed = parseControlCommand(["dump"]);
		expect(parsed).toMatchObject({ ok: true, command: { group: "dump", action: "inspect", args: [], mutation: false } });
		if (parsed?.ok !== true) throw new Error("dump command did not parse");
		expect(controlCommandRequest(parsed.command)).toEqual({ operation: "session.prompt.inspect", body: {}, mutation: false });
		expect(controlCommandQueryOperation(parsed.command)).toBeUndefined();
		expect(controlCommandHelp()).toContain("runledger dump");
		expect(parseControlCommand(["dump", "reset"])).toEqual({ ok: false, error: "unsupported dump action: reset" });
	});

	it("returns the assembled prompt projection through the published operation", () => {
		const { run } = fixture();
		const result = run(["dump"]);
		expect(result).toMatchObject({
			status: 0,
			body: { ok: true, status: "ok", operation: "session.prompt.inspect" },
		});
		const value = result.body.value as Record<string, unknown> | undefined;
		expect(value).toBeDefined();
		expect(typeof value?.systemPrompt).toBe("string");
		expect((value?.systemPrompt as string).length).toBeGreaterThan(0);
		expect(value?.source === "base" || value?.source === "assembled").toBe(true);
		expect(Array.isArray(value?.tools)).toBe(true);
		expect(value).toMatchObject({ assembledPromptDigest: { algorithm: "sha256" } });
	}, 40_000);
});
