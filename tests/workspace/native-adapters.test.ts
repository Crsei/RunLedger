/** P4 native adapter 单测：fake syscall/git ports 驱动三平台 adapter 逻辑（真实 runner E2E 在 tests/integration）。 */

import { describe, expect, it } from "vitest";
import { createNativeWorkspaceAdapters } from "../../src/workspace/native/adapters.ts";
import { createWindowsWorkspaceAdapters } from "../../src/workspace/native/windows.ts";
import { createMacosWorkspaceAdapters } from "../../src/workspace/native/macos.ts";
import { createWorkspaceAdapters, createWorkspaceAdaptersForCurrentPlatform } from "../../src/workspace/factory.ts";
import { encodePrivateLocator } from "../../src/workspace/path-adapter.ts";
import type { GitCommandRequest, GitCommandResult } from "../../src/worktree/ports.ts";
import type { PathSyscallPort } from "../../src/workspace/native/types.ts";

function syscall(resolved: Record<string, string | undefined>): PathSyscallPort {
	return { realpath: async (path) => resolved[path] };
}

function broker(responder?: (request: GitCommandRequest) => GitCommandResult): { port: import("../../src/worktree/ports.ts").GitCommandPort; requests: GitCommandRequest[] } {
	const requests: GitCommandRequest[] = [];
	return {
		requests,
		port: {
			run: async (request) => {
				requests.push(request);
				return responder?.(request) ?? { stdout: "", stderr: "", exitCode: 0, signaled: false };
			},
		},
	};
}

const COMMIT = "4c8df777fd1c801bb3e21dc40ecded2aa117e197";

const LINUX_PORCELAIN = [
	"worktree /repo",
	"HEAD 4c8df777fd1c801bb3e21dc40ecded2aa117e197",
	"branch refs/heads/master",
	"",
	"worktree /managed/task-locked",
	"HEAD 4c8df777fd1c801bb3e21dc40ecded2aa117e197",
	"detached",
	"locked",
	"",
].join("\n");

function linuxAdapters(resolved: Record<string, string | undefined>, responder?: (request: GitCommandRequest) => GitCommandResult) {
	return createNativeWorkspaceAdapters("linux", { git: broker(responder).port, fs: syscall(resolved), managedRoot: "/managed" });
}

describe("native path adapter (Linux, fake syscall)", () => {
	it("resolves existing paths to their real identity inside the managed root", async () => {
		const adapters = linuxAdapters({ "/managed/repo": "/managed/repo", "/managed": "/managed" });
		const identity = await adapters.path.realIdentity("/managed/repo");
		expect(identity).toEqual({ ok: true, value: { root: { kind: "posix", display: "/", key: "/" }, displayPath: "/managed/repo", compareKey: "/managed/repo", absolute: true } });
	});

	it("resolves symlinks through realpath and fails closed outside the managed root", async () => {
		const adapters = linuxAdapters({ "/managed/link": "/outside/real", "/managed": "/managed" });
		const inside = await adapters.path.realIdentity("/managed/link");
		expect(inside).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });
	});

	it("resolves candidate paths via the nearest existing ancestor", async () => {
		const adapters = linuxAdapters({ "/managed/repo": "/managed/repo", "/managed": "/managed" });
		const candidate = await adapters.path.candidateIdentity("/managed/repo/task/new/untracked.txt");
		expect(candidate).toEqual({ ok: true, value: { root: { kind: "posix", display: "/", key: "/" }, displayPath: "/managed/repo/task/new/untracked.txt", compareKey: "/managed/repo/task/new/untracked.txt", absolute: true } });
	});

	it("reports missing existing paths and missing ancestors as invalid_path", async () => {
		const adapters = linuxAdapters({ "/managed": "/managed" });
		expect(await adapters.path.realIdentity("/managed/missing")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});

	it("opens a locator only on platform match and existing path (ADR D4)", async () => {
		const adapters = linuxAdapters({ "/managed/repo": "/managed/repo", "/managed": "/managed" });
		const real = await adapters.path.realIdentity("/managed/repo");
		expect(real.ok).toBe(true);
		if (!real.ok) return;
		const locator = encodePrivateLocator(real.value, "linux");
		expect((await adapters.path.openLocator(locator)).ok).toBe(true);
		const foreign = { ...locator, platform: "windows" as const };
		expect(await adapters.path.openLocator(foreign)).toMatchObject({ ok: false, error: { code: "platform_mismatch" } });
	});
});

describe("native git adapter (Linux, fake git broker)", () => {
	it("creates a detached worktree with a typed argv array", async () => {
		const value = broker();
		const adapters = createNativeWorkspaceAdapters("linux", { git: value.port, fs: syscall({ "/managed": "/managed" }), managedRoot: "/managed" });
		const created = await adapters.git.createDetached("/repo", "/managed/task", COMMIT);
		expect(created).toEqual({ ok: true, value: "/managed/task" });
		expect(value.requests[0]?.arguments).toEqual(["worktree", "add", "--detach", "/managed/task", COMMIT]);
	});

	it("rejects targets outside the managed root before invoking git", async () => {
		const value = broker();
		const adapters = createNativeWorkspaceAdapters("linux", { git: value.port, fs: syscall({}), managedRoot: "/managed" });
		expect(await adapters.git.createDetached("/repo", "/managed-other/task", COMMIT)).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });
		expect(value.requests).toHaveLength(0);
	});

	it("compares the requested target with git-registered target by compare key", async () => {
		const adapters = linuxAdapters({ "/managed": "/managed" }, () => ({ stdout: LINUX_PORCELAIN, stderr: "", exitCode: 0, signaled: false }));
		const match = await adapters.git.registeredTarget("/repo", "/managed/task-locked");
		expect(match.ok).toBe(true);
		if (!match.ok) return;
		expect(match.value.match).toBe(true);
		expect(match.value.registered.locked).toBe(true);
		expect(match.value.identity.displayPath).toBe("/managed/task-locked");
	});

	it("fails closed with stale_registration when git has no matching entry", async () => {
		const adapters = linuxAdapters({ "/managed": "/managed" }, () => ({ stdout: LINUX_PORCELAIN, stderr: "", exitCode: 0, signaled: false }));
		expect(await adapters.git.registeredTarget("/repo", "/managed/never-registered")).toMatchObject({ ok: false, error: { code: "stale_registration" } });
	});

	it("refuses to remove a git-locked worktree", async () => {
		const adapters = linuxAdapters({ "/managed": "/managed" }, () => ({ stdout: LINUX_PORCELAIN, stderr: "", exitCode: 0, signaled: false }));
		expect(await adapters.git.remove("/repo", "/managed/task-locked", false)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
	});
});

describe("native process adapter (Linux)", () => {
	it("resolves bash through PATH via the syscall port", async () => {
		const adapters = createNativeWorkspaceAdapters("linux", {
			git: broker().port,
			fs: syscall({ "/usr/bin/bash": "/usr/bin/bash", "/usr/bin": "/usr/bin" }),
			env: { path: "/usr/bin:/bin" },
			managedRoot: "/managed",
		});
		const resolved = await adapters.process.resolveShell("bash");
		expect(resolved).toEqual({ ok: true, value: { id: "bash", executable: "/usr/bin/bash", launchArgs: ["-lc"], pathTranslation: "native" } });
	});

	it("reports unknown shell ids and missing executables", async () => {
		const adapters = createNativeWorkspaceAdapters("linux", { git: broker().port, fs: syscall({}), env: { path: "/nonexistent" }, managedRoot: "/managed" });
		expect(await adapters.process.resolveShell("nope")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
		expect(await adapters.process.resolveShell("bash")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});
});

describe("windows/macos adapters: fixture-driven logic, runner evidence pending", () => {
	const WIN_PORCELAIN = [
		"worktree C:\\runledger-state\\managed\\repo-one\\task-workspace-one",
		"HEAD 4c8df777fd1c801bb3e21dc40ecded2aa117e197",
		"branch refs/heads/feature/x",
		"",
		"worktree \\\\server\\share\\managed root\\repo\\task",
		"HEAD 4c8df777fd1c801bb3e21dc40ecded2aa117e197",
		"detached",
		"",
	].join("\n");

	it("matches windows registered targets with case-folded compare keys", async () => {
		const value = broker(() => ({ stdout: WIN_PORCELAIN, stderr: "", exitCode: 0, signaled: false }));
		const adapters = createWindowsWorkspaceAdapters({ git: value.port, fs: syscall({}), managedRoot: "C:\\runledger-state\\managed" });
		const match = await adapters.git.registeredTarget("C:\\repo", "c:\\RUNLEDGER-STATE\\managed\\repo-one\\TASK-WORKSPACE-ONE");
		expect(match.ok).toBe(true);
		if (!match.ok) return;
		expect(match.value.match).toBe(true);
		expect(match.value.registered.path).toBe("C:\\runledger-state\\managed\\repo-one\\task-workspace-one");
	});

	it("treats different UNC shares as cross_root", async () => {
		const adapters = createWindowsWorkspaceAdapters({ git: broker().port, fs: syscall({}), managedRoot: "\\\\server\\share\\managed" });
		const a = adapters.path.parse("\\\\server\\share\\managed\\repo");
		const b = adapters.path.parse("\\\\server\\other\\repo");
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(adapters.path.isWithin(a.value, b.value)).toEqual({ ok: true, value: "cross_root" });
	});

	it("resolves windows shells with PATHEXT extension rules", async () => {
		const adapters = createWindowsWorkspaceAdapters({
			git: broker().port,
			fs: syscall({ "C:\\tools\\powershell\\powershell.EXE": "C:\\tools\\powershell\\powershell.EXE" }),
			env: { path: "C:\\tools\\powershell", pathext: ".EXE;.CMD" },
			managedRoot: "C:\\managed",
		});
		const resolved = await adapters.process.resolveShell("pwsh");
		expect(resolved).toEqual({ ok: true, value: { id: "pwsh", executable: "C:\\tools\\powershell\\powershell.EXE", launchArgs: ["-NoProfile", "-NonInteractive", "-Command"], pathTranslation: "native" } });
	});

	it("keeps macOS adapter logic fixture-testable with unverified capability", () => {
		const adapters = createMacosWorkspaceAdapters({ git: broker().port, fs: syscall({ "/bin/zsh": "/bin/zsh" }), env: { path: "/bin" }, managedRoot: "/managed" });
		expect(adapters.platform).toBe("macos");
		expect(adapters.process.capability().termination.evidence).toBe("unverified");
	});
});

describe("factory availability (P4 exit condition)", () => {
	it("returns verified Linux adapters", () => {
		const result = createWorkspaceAdapters("linux", { git: broker().port, fs: syscall({ "/managed": "/managed" }), managedRoot: "/managed" });
		expect(result.ok).toBe(true);
	});

	it("keeps macos/windows typed unsupported until real-runner E2E", () => {
		expect(createWorkspaceAdapters("windows", { git: broker().port, fs: syscall({}), managedRoot: "C:\\managed" })).toMatchObject({ ok: false, error: { code: "unverified_platform" } });
		expect(createWorkspaceAdapters("macos", { git: broker().port, fs: syscall({}), managedRoot: "/managed" })).toMatchObject({ ok: false, error: { code: "unverified_platform" } });
	});

	it("maps the current runtime platform only in the factory", () => {
		const result = createWorkspaceAdaptersForCurrentPlatform({ git: broker().port, fs: syscall({}), managedRoot: "/managed" });
		if (process.platform === "linux") expect(result.ok).toBe(true);
		else expect(result.ok).toBe(false);
	});
});
