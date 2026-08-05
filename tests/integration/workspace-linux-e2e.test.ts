/** P4 Linux 真实 runner E2E：真实 Git worktree create/list/resume/remove + 真实 path/process 语义。 */

/**
 * 只在本机（Linux）真实执行 Git；macOS/Windows 的对应 E2E 在真实 runner 接入前
 * 不写测试、不模拟（evidence-verification-gaps.md）。本测试验证 P1 证据对应的
 * adapter 契约：porcelain 解析、identity 同一性、managed-root containment、
 * shell 解析与 launch args 可用、locator 同平台恢复。
 */

import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitCommandPort } from "../../src/worktree/ports.ts";
import { createWorkspaceAdapters, createWorkspaceAdaptersForCurrentPlatform } from "../../src/workspace/factory.ts";
import { encodePrivateLocator } from "../../src/workspace/path-adapter.ts";

const execFileAsync = promisify(execFile);

function gitPort(): GitCommandPort {
	return {
		run: async (request, signal) => {
			try {
				const result = await execFileAsync("git", [...request.arguments], { cwd: request.cwd, timeout: request.timeoutMs, signal });
				return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signaled: false };
			} catch (error) {
				const err = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
				return {
					stdout: err.stdout ?? "",
					stderr: err.stderr ?? "",
					exitCode: typeof err.code === "number" ? err.code : 1,
					signaled: err.signal !== undefined,
				};
			}
		},
	};
}

describe("workspace adapters Linux E2E (real git)", { timeout: 60_000 }, () => {
	const root = join(tmpdir(), `runledger-workspace-e2e-${process.pid}`);
	const repo = join(root, "repo");
	const managed = join(root, "managed");
	const subdir = join(repo, "packages", "app");

	beforeEach(() => {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(subdir, { recursive: true });
		mkdirSync(managed, { recursive: true });
		writeFileSync(join(repo, "base.txt"), "base\n");
		writeFileSync(join(subdir, "app.txt"), "app\n");
		gitSync("git", ["init", "-q"]);
		gitSync("git", ["config", "user.email", "e2e@runledger.local"]);
		gitSync("git", ["config", "user.name", "RunLedger E2E"]);
		gitSync("git", ["add", "."]);
		gitSync("git", ["commit", "-qm", "initial"]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function gitSync(cmd: string, args: readonly string[]): void {
		const result = spawnSync(cmd, [...args], { cwd: repo, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}

	it("create → list → resume → remove with verified identity through the native adapter", async () => {
		const pathAvailability = createWorkspaceAdapters("linux", { git: gitPort(), managedRoot: root });
		const availability = createWorkspaceAdapters("linux", { git: gitPort(), managedRoot: managed });
		expect(pathAvailability.ok && availability.ok).toBe(true);
		if (!pathAvailability.ok || !availability.ok) return;
		const pathAdapters = pathAvailability.value;
		const adapters = availability.value;
		const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

		// path adapter：existing identity + candidate identity + containment
		const repoIdentity = await pathAdapters.path.realIdentity(repo);
		expect(repoIdentity.ok).toBe(true);
		if (!repoIdentity.ok) return;
		expect(repoIdentity.value.displayPath).toBe(repo);
		const target = join(managed, "repo-slug", "task");
		const candidate = await pathAdapters.path.candidateIdentity(target);
		expect(candidate.ok).toBe(true);
		if (!candidate.ok) return;
		expect(candidate.value.displayPath).toBe(target);
		expect(pathAdapters.path.isWithin(repoIdentity.value, candidate.value)).toEqual({ ok: true, value: "outside" });
		const outside = await pathAdapters.path.candidateIdentity(join(root, "..", "runledger-workspace-e2e-outside", "task"));
		expect(outside).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });

		// git adapter：create → porcelain list → registered identity 同一性
		const created = await adapters.git.createDetached(repo, target, baseCommit);
		expect(created).toEqual({ ok: true, value: target });
		const listed = await adapters.git.list(repo);
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value.some((entry) => entry.path === target && entry.detached)).toBe(true);
		const registered = await adapters.git.registeredTarget(repo, target);
		expect(registered.ok).toBe(true);
		if (!registered.ok) return;
		expect(registered.value.match).toBe(true);
		expect(registered.value.identity.displayPath).toBe(target);

		// inspectRepository：source subdir 的 root/prefix
		const info = await adapters.git.inspectRepository(subdir);
		expect(info.ok).toBe(true);
		if (!info.ok) return;
		expect(info.value.root).toBe(repo);
		expect(info.value.prefix).toBe("packages/app");
		expect(info.value.headCommit).toBe(baseCommit);

		// process adapter：shell 解析 + launch args 真实可用
		const shell = await adapters.process.resolveShell("bash");
		expect(shell.ok).toBe(true);
		if (!shell.ok) return;
		const echo = await execFileAsync(shell.value.executable, [...shell.value.launchArgs, "printf ok"], { cwd: repo });
		expect(echo.stdout.trim()).toBe("ok");

		// resume：locator 同平台恢复并重验证
		const locator = encodePrivateLocator(candidate.value, "linux");
		const reopened = await adapters.path.openLocator(locator);
		expect(reopened.ok).toBe(true);

		// remove：先验证注册同一性，再真实删除，porcelain 不再包含该路径
		const removed = await adapters.git.remove(repo, target, false);
		expect(removed).toEqual({ ok: true, value: target });
		const after = await adapters.git.list(repo);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.value.some((entry) => entry.path === target)).toBe(false);
		expect(existsSync(target)).toBe(false);
	});

	it("fails closed: removing an unregistered target or locked worktree is refused", async () => {
		const availability = createWorkspaceAdapters("linux", { git: gitPort(), managedRoot: managed });
		expect(availability.ok).toBe(true);
		if (!availability.ok) return;
		const adapters = availability.value;
		const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

		const ghost = join(managed, "ghost");
		expect(await adapters.git.remove(repo, ghost, false)).toMatchObject({ ok: false, error: { code: "stale_registration" } });

		const locked = join(managed, "locked-task");
		expect(await adapters.git.createDetached(repo, locked, baseCommit)).toEqual({ ok: true, value: locked });
		await execFileAsync("git", ["worktree", "lock", locked], { cwd: repo });
		expect(await adapters.git.remove(repo, locked, false)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
		await execFileAsync("git", ["worktree", "unlock", locked], { cwd: repo });
		expect(await adapters.git.remove(repo, locked, false)).toEqual({ ok: true, value: locked });
	});

	it("keeps dirty worktrees removable only via explicit force (P1 evidence semantics)", async () => {
		const availability = createWorkspaceAdapters("linux", { git: gitPort(), managedRoot: managed });
		expect(availability.ok).toBe(true);
		if (!availability.ok) return;
		const adapters = availability.value;
		const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
		const dirty = join(managed, "dirty-task");
		expect(await adapters.git.createDetached(repo, dirty, baseCommit)).toEqual({ ok: true, value: dirty });
		writeFileSync(join(dirty, "untracked.txt"), "dirty\n");
		expect(await adapters.git.remove(repo, dirty, false)).toMatchObject({ ok: false, error: { code: "git_failed" } });
		expect(await adapters.git.remove(repo, dirty, true)).toEqual({ ok: true, value: dirty });
		expect(existsSync(dirty)).toBe(false);
	});

	it("factory maps the current Linux runner to verified adapters", () => {
		const availability = createWorkspaceAdaptersForCurrentPlatform({ git: gitPort(), managedRoot: managed });
		expect(availability.ok).toBe(true);
	});
});
