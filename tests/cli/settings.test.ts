import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const homes: string[] = [];

function runCli(args: readonly string[], home: string): { readonly stdout: string; readonly stderr: string; readonly status: number | null } {
	const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, RUNLEDGER_DIR: home },
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("runledger settings CLI", () => {
	afterEach(() => {
		for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	});

	it("lists and reads schema defaults through the compiled command path", () => {
		const home = mkdtempSync(join(tmpdir(), "runledger-settings-cli-"));
		homes.push(home);
		const list = runCli(["settings", "list", "--json"], home);
		expect(list.status).toBe(0);
		const entries = JSON.parse(list.stdout) as Array<{ path: string; secret: boolean }>;
		expect(entries.some((entry) => entry.path === "retry.maxRetries")).toBe(true);
		expect(entries.some((entry) => entry.secret)).toBe(false);

		const get = runCli(["settings", "get", "retry.maxRetries", "--json"], home);
		expect(get.status).toBe(0);
		expect(JSON.parse(get.stdout)).toMatchObject({ path: "retry.maxRetries", value: 0, source: "default" });
	});

	it("sets and resets a typed setting without opening a Session/TUI", () => {
		const home = mkdtempSync(join(tmpdir(), "runledger-settings-cli-"));
		homes.push(home);
		expect(runCli(["settings", "set", "retry.maxRetries", "3", "--json"], home).status).toBe(0);
		expect(JSON.parse(runCli(["settings", "get", "retry.maxRetries", "--json"], home).stdout)).toMatchObject({ value: 3, source: "user" });
		expect(runCli(["settings", "reset", "retry.maxRetries", "--json"], home).status).toBe(0);
		expect(JSON.parse(runCli(["settings", "get", "retry.maxRetries", "--json"], home).stdout)).toMatchObject({ value: 0, source: "default" });
	});

	it("returns stable errors and never echoes an unsupported secret path", () => {
		const home = mkdtempSync(join(tmpdir(), "runledger-settings-cli-"));
		homes.push(home);
		const result = runCli(["settings", "set", "credentials.apiKey", "super-secret"], home);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown_path");
		expect(result.stderr).not.toContain("super-secret");
	});

	it("keeps workspace settings in their validated scope with precedence and reset", () => {
		const home = mkdtempSync(join(tmpdir(), "runledger-settings-cli-"));
		homes.push(home);

		expect(runCli(["settings", "set", "tools.read.defaultLimit", "7", "--json"], home).status).toBe(0);
		const workspaceSet = runCli([
			"settings", "set", "tools.read.defaultLimit", "9", "--workspace-key", "ws-fixture", "--json",
		], home);
		expect(workspaceSet.status).toBe(0);
		expect(JSON.parse(workspaceSet.stdout)).toMatchObject({ value: 7, source: "user" });
		expect(JSON.parse(runCli(["settings", "get", "tools.read.defaultLimit", "--workspace-key", "ws-fixture", "--json"], home).stdout))
			.toMatchObject({ value: 7, source: "user" });
		expect(JSON.parse(runCli(["settings", "get", "tools.read.defaultLimit", "--json"], home).stdout))
			.toMatchObject({ value: 7, source: "user" });

		const workspaceSettingsPath = join(home, "projects", "ws-fixture", "settings.json");
		expect(JSON.parse(readFileSync(workspaceSettingsPath, "utf8"))).toEqual({ tools: { read: { defaultLimit: 9 } } });
		expect(statSync(workspaceSettingsPath).mode & 0o777).toBe(0o600);
		expect(runCli(["settings", "reset", "tools.read.defaultLimit", "--workspace-key", "ws-fixture", "--json"], home).status).toBe(0);
		expect(JSON.parse(runCli(["settings", "get", "tools.read.defaultLimit", "--workspace-key", "ws-fixture", "--json"], home).stdout))
			.toMatchObject({ value: 7, source: "user" });

		const userOnly = runCli(["settings", "set", "shellPath", "/bin/sh", "--workspace-key", "ws-fixture"], home);
		expect(userOnly.status).toBe(2);
		expect(userOnly.stderr).toContain("scope_not_allowed");

		const invalidKey = runCli(["settings", "get", "retry.maxRetries", "--workspace-key", "../outside"], home);
		expect(invalidKey.status).toBe(2);
		expect(invalidKey.stderr).toContain("invalid_workspace_key");
	});
});
