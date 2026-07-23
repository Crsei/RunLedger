import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/storage/session-manager.ts";
import { saveProjectSettings } from "../../src/storage/settings-manager.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const TSX_LOADER = resolve(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-cli-v3-"));
	roots.push(root);
	return root;
}

function runCli(cwd: string, args: readonly string[]) {
	const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI v3 version fence and migration", () => {
	it("migrates a legacy session only when sessionV3 is explicitly enabled", async () => {
		const root = temporaryRoot();
		await saveProjectSettings(root, { runtimeFeatures: { sessionV3: true } });
		const legacy = await SessionManager.create({ cwd: root, sessionDir: join(root, "legacy") });
		await legacy.ledger().append({
			id: "message",
			sessionId: legacy.sessionId(),
			parentId: legacy.ledger().header().id,
			timestamp: Date.now(),
			type: "message",
			payload: {
				schema: "agent-message/v1",
				role: "user",
				message: { role: "user", content: [{ type: "text", text: "cli migrate" }] },
			},
		});
		const source = legacy.filePath();
		await legacy.closeAll();

		const result = runCli(root, ["--migrate", source, "--session-dir", join(root, "v3")]);
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(output).toMatchObject({ status: "migrated", mode: "migrate", importedMessageCount: 1 });
		expect(output.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
		const migration = JSON.parse(readFileSync(String(output.filePath), "utf8").trim().split("\n").at(-1) ?? "null") as {
			type?: string;
			currentEventHash?: string;
		};
		expect(migration).toMatchObject({
			type: "session.migration_committed",
			currentEventHash: output.headDigest,
		});
		expect(
			readFileSync(String(output.filePath), "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type),
		).toEqual([
			"session.migration_started",
			"session.legacy_message_imported",
			"session.migration_committed",
		]);
	});

	it("returns one consistent read-only fence for legacy continue/session/fork paths", async () => {
		const root = temporaryRoot();
		await saveProjectSettings(root, { runtimeFeatures: { sessionV3: true } });
		const legacy = await SessionManager.create({ cwd: root, sessionDir: join(root, "legacy") });
		const source = legacy.filePath();
		await legacy.closeAll();

		for (const args of [
			["--session", source],
			["--fork", source],
			["--continue", "--session-dir", join(root, "legacy")],
		]) {
			const result = runCli(root, args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Legacy session v1/v2 is read-only");
		}
	});

	it("rejects downgrade before opening a session", async () => {
		const root = temporaryRoot();
		const result = runCli(root, ["--downgrade", join(root, "missing-v3.jsonl")]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("downgrade is forbidden");
	});
});
