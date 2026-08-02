import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, ...env },
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("runledger migrate", () => {
	it("requires explicit confirm-delete and has no dry-run success path", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-migrate-cli-"));
		cleanup.push(root);
		const home = join(root, "home");
		const source = join(root, "settings.json");
		mkdirSync(home, { recursive: true });
		writeFileSync(source, JSON.stringify({ model: "legacy" }), "utf8");

		const missingConfirmation = runCli(["migrate", "--source", source], { RUNLEDGER_DIR: home });
		expect(missingConfirmation.status).toBe(2);
		expect(missingConfirmation.stderr).toContain("--confirm-delete");
		expect(existsSync(source)).toBe(true);

		const dryRun = runCli(["migrate", "--source", source, "--dry-run", "--confirm-delete"], { RUNLEDGER_DIR: home });
		expect(dryRun.status).toBe(2);
		expect(dryRun.stderr).toContain("--dry-run");
		expect(existsSync(source)).toBe(true);
	});

	it("confirmed migration reports receipt and deletes only the source file", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-migrate-cli-"));
		cleanup.push(root);
		const home = join(root, "home");
		const source = join(root, "settings.json");
		mkdirSync(home, { recursive: true });
		writeFileSync(source, JSON.stringify({ model: "legacy" }), "utf8");

		const result = runCli(["migrate", "--source", source, "--confirm-delete"], { RUNLEDGER_DIR: home });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("migration");
		expect(result.stdout).toContain("source_deleted");
		expect(existsSync(source)).toBe(false);
		expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ model: "legacy" });
	});
});
