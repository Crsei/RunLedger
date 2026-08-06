/**
 * R2 CLI fixtures:`migrate session-store --confirm-archive` 与
 * `storage prune-legacy --manifest --confirm-delete`(隔离 home 真跑 cli.ts)。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env },
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function setupHome(): { root: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "runledger-session-store-cli-"));
	cleanup.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(join(home, "sessions", "2026", "08", "01"), { recursive: true, mode: 0o700 });
	return { root, home };
}

function writeFixtureSession(home: string, sessionId: string): string {
	const filePath = join(home, "sessions", "2026", "08", "01", "s1.jsonl");
	const header = JSON.stringify({
		type: "ledger",
		id: createRuntimeId("event", "h"),
		createdAt: 1_752_000_000_000,
		sessionId,
		metadata: { cwd: "/work/a" },
	});
	const entry = JSON.stringify({
		id: createRuntimeId("event", "e1"),
		sessionId,
		parentId: createRuntimeId("event", "h"),
		timestamp: 1_000,
		type: "message",
		payload: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
	writeFileSync(filePath, `${header}\n${entry}\n`, { mode: 0o600 });
	return filePath;
}

describe("runledger migrate session-store", () => {
	it("requires explicit --confirm-archive and rejects unknown flags", () => {
		const { home } = setupHome();
		const noConfirm = runCli(["migrate", "session-store"], { RUNLEDGER_DIR: home });
		expect(noConfirm.status).toBe(2);
		expect(noConfirm.stderr).toContain("--confirm-archive");

		const unknownFlag = runCli(["migrate", "session-store", "--confirm-archive", "--dry-run"], { RUNLEDGER_DIR: home });
		expect(unknownFlag.status).toBe(2);
		expect(unknownFlag.stderr).toContain("不支持参数");
	});

	it("imports, verifies and archives the canonical JSONL in an isolated home", () => {
		const { root, home } = setupHome();
		const sessionId = createRuntimeId("session", "cli1");
		const sourcePath = writeFixtureSession(home, sessionId);
		const result = runCli(["migrate", "session-store", "--confirm-archive"], { RUNLEDGER_DIR: home });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("committed");
		expect(result.stdout).toContain("sessions=1");
		expect(existsSync(sourcePath)).toBe(false);
		expect(existsSync(join(home, "state.db"))).toBe(true);
		// archive 保留 digest 内容;source 未被物理删除(归档在 migration-backup 下)。
		const archiveRoot = join(home, "migration-backup", "session-store");
		const manifestDigests = readdirSync(archiveRoot);
		expect(manifestDigests).toHaveLength(1);
		expect(existsSync(join(archiveRoot, manifestDigests[0]!, "sessions", "2026", "08", "01", "s1.jsonl"))).toBe(true);
		expect(readFileSync(join(archiveRoot, manifestDigests[0]!, "manifest.json"), "utf8")).toContain(sessionId);
		void root;
	});

	it("fails closed with legacy_host_active while a legacy writer holds the lock", () => {
		const { home } = setupHome();
		writeFixtureSession(home, createRuntimeId("session", "cli2"));
		// 模拟 active legacy writer:预创建 proper-lockfile 锁文件。
		const lockPath = join(home, "sessions", "2026", "08", "01", "s1.jsonl.lock");
		writeFileSync(lockPath, "held\n", { mode: 0o600 });
		const result = runCli(["migrate", "session-store", "--confirm-archive"], { RUNLEDGER_DIR: home });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("legacy_host_active");
		expect(existsSync(join(home, "sessions", "2026", "08", "01", "s1.jsonl"))).toBe(true);
	});
});

describe("runledger storage prune-legacy", () => {
	it("requires manifest digest and explicit confirmation", () => {
		const { home } = setupHome();
		const noManifest = runCli(["storage", "prune-legacy", "--confirm-delete"], { RUNLEDGER_DIR: home });
		expect(noManifest.status).toBe(2);
		expect(noManifest.stderr).toContain("--manifest");

		const noConfirm = runCli(["storage", "prune-legacy", "--manifest", "a".repeat(64)], { RUNLEDGER_DIR: home });
		expect(noConfirm.status).toBe(2);
		expect(noConfirm.stderr).toContain("--confirm-delete");
	});

	it("deletes the verified archive only after migration", () => {
		const { home } = setupHome();
		writeFixtureSession(home, createRuntimeId("session", "cli3"));
		const migrated = runCli(["migrate", "session-store", "--confirm-archive"], { RUNLEDGER_DIR: home });
		expect(migrated.status).toBe(0);
		const digestMatch = /manifest=([a-f0-9]{64})/u.exec(migrated.stdout);
		expect(digestMatch).not.toBeNull();
		const digest = digestMatch![1]!;

		const pruned = runCli(["storage", "prune-legacy", `--manifest=${digest}`, "--confirm-delete"], { RUNLEDGER_DIR: home });
		expect(pruned.status).toBe(0);
		expect(pruned.stdout).toContain("files=1");
		expect(existsSync(join(home, "migration-backup", "session-store", digest))).toBe(false);
	});
});
