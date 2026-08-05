/** P1 证据 fixture 的不可变性与语义断言；不在本测试中模拟 macOS/Windows runner。 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Evidence {
	runner: {
		platform: string;
		arch: string;
		node: string;
		git: string;
		bash: string | null;
		sh: string | null;
		zsh: string | null;
		uname: string;
		filesystemType: string | null;
	};
	path: Record<string, unknown>;
	git: {
		worktreeCreate: { exitCode: number };
		worktreeListPorcelain: string;
		busyRemove: { exitCode: number; stderr: string };
		lockedRemove: { exitCode: number; stderr: string };
		lockedListPorcelain: string;
		cleanRemove: { exitCode: number };
		dirtyRemove: { exitCode: number; stderr: string };
		forceRemove: { exitCode: number };
		bareWorktreeListPorcelain: string;
	};
	process: { treeKill: { ok: boolean; stdout: string; stderr: string } };
	cleanup: { occupiedFile: { ok: boolean; stdout: string; stderr: string } };
	locator: { coldResume: { stdout: string } };
}

const fixtureRoot = resolve("tests/fixtures/platform-evidence");

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixtureFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.map((name) => String(name))
		.filter((name) => statSync(join(dir, name)).isFile())
		.sort();
}

describe("platform evidence fixtures are immutable", () => {
	it("recomputes the committed manifest digests without drift", () => {
		for (const platformDir of readdirSync(fixtureRoot)) {
			if (!statSync(join(fixtureRoot, platformDir)).isDirectory()) continue;
			const dir = join(fixtureRoot, platformDir);
			const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, string>;
			const actual: Record<string, string> = {};
			for (const file of fixtureFiles(dir)) {
				if (file === "manifest.json" || file === "README.md") continue;
				actual[file] = sha256(readFileSync(join(dir, file), "utf8"));
			}
			expect(actual).toEqual(manifest);
		}
	});
});

describe("linux runner evidence semantics (real runner, 2026-08-06)", () => {
	const evidence = JSON.parse(readFileSync(join(fixtureRoot, "linux", "evidence.json"), "utf8")) as Evidence;

	it("pins runner and tool versions", () => {
		expect(evidence.runner.platform).toBe("linux");
		expect(evidence.runner.arch.length).toBeGreaterThan(0);
		expect(evidence.runner.node).toMatch(/^v\d+\./u);
		expect(evidence.runner.git).toMatch(/^git version \d/u);
		expect(evidence.runner.bash).toMatch(/bash/u);
		expect(evidence.runner.filesystemType).toBeTruthy();
	});

	it("records git worktree create/list porcelain without losing paths", () => {
		expect(evidence.git.worktreeCreate.exitCode).toBe(0);
		const porcelain = evidence.git.worktreeListPorcelain;
		expect(porcelain).toContain("worktree /");
		expect(porcelain).toContain("HEAD ");
		expect(porcelain).toContain("detached");
		expect(porcelain).toContain("branch refs/heads/");
	});

	it("records that POSIX allows removing a worktree while another process holds cwd inside it", () => {
		expect(evidence.git.busyRemove.exitCode).toBe(0);
	});

	it("records git native locked marker and locked-remove denial in porcelain", () => {
		expect(evidence.git.lockedRemove.exitCode).toBe(128);
		expect(evidence.git.lockedRemove.stderr).toContain("locked");
		expect(evidence.git.lockedListPorcelain).toContain("locked");
	});

	it("records dirty-remove denial and clean force-remove success", () => {
		expect(evidence.git.dirtyRemove.exitCode).toBe(128);
		expect(evidence.git.dirtyRemove.stderr).toContain("untracked");
		expect(evidence.git.forceRemove.exitCode).toBe(0);
	});

	it("records bare repo porcelain form", () => {
		expect(evidence.git.bareWorktreeListPorcelain).toContain("bare");
	});

	it("records process-group termination semantics", () => {
		expect(evidence.process.treeKill.ok).toBe(true);
		expect(evidence.process.treeKill.stdout).toContain("child_alive=no");
		expect(evidence.process.treeKill.stdout).toContain("group_alive=no");
	});

	it("records POSIX occupied-file unlink semantics", () => {
		expect(evidence.cleanup.occupiedFile.ok).toBe(true);
		expect(evidence.cleanup.occupiedFile.stdout).toContain("rmdir_while_locked=ok");
	});

	it("records same-platform cold resume and keeps cross-platform open as a typed decision", () => {
		expect(evidence.locator.coldResume.stdout).toContain("restore=true");
	});
});
