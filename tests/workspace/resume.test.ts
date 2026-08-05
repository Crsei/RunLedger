/** P5 cold resume 测试：platform/root/Git/lease/effective cwd 重验 + mismatch negative。 */

import { describe, expect, it } from "vitest";
import { createNativeWorkspaceAdapters } from "../../src/workspace/native/adapters.ts";
import { encodePrivateLocator } from "../../src/workspace/path-adapter.ts";
import { resumeWorktreeLocator } from "../../src/workspace/resume.ts";
import type { GitCommandRequest, GitCommandResult } from "../../src/worktree/ports.ts";
import type { PathSyscallPort } from "../../src/workspace/native/types.ts";

const COMMIT = "4c8df777fd1c801bb3e21dc40ecded2aa117e197";

function syscall(resolved: Record<string, string | undefined>): PathSyscallPort {
	return { realpath: async (path) => resolved[path] };
}

function broker(responder?: (request: GitCommandRequest) => GitCommandResult) {
	const requests: GitCommandRequest[] = [];
	return {
		requests,
		port: {
			run: async (request: GitCommandRequest) => {
				requests.push(request);
				return responder?.(request) ?? { stdout: "", stderr: "", exitCode: 0, signaled: false };
			},
		},
	};
}

function linuxDeps(resolved: Record<string, string | undefined>, responder?: (request: GitCommandRequest) => GitCommandResult) {
	return createNativeWorkspaceAdapters("linux", { git: broker(responder).port, fs: syscall(resolved), managedRoot: "/managed" });
}

const REGISTERED = [
	"worktree /repo",
	`HEAD ${COMMIT}`,
	"branch refs/heads/master",
	"",
	"worktree /managed/repo-slug/task",
	`HEAD ${COMMIT}`,
	"detached",
	"",
].join("\n");

function resumeRequest(record: Parameters<typeof encodePrivateLocator>[0]) {
	return { record, repo: "/repo", expectedBaseCommit: COMMIT, effectiveSubdir: "packages/app" };
}

describe("resumeWorktreeLocator: cold resume re-verification", () => {
	it("restores identity, effective cwd and head when every check passes", async () => {
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: REGISTERED, stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const request = resumeRequest(encodePrivateLocator(parsed.value, "linux"));
		const resumed = await resumeWorktreeLocator(adapters, request);
		expect(resumed).toEqual({ ok: true, identity: { root: { kind: "posix", display: "/", key: "/" }, displayPath: "/managed/repo-slug/task", compareKey: "/managed/repo-slug/task", absolute: true }, effectiveCwd: "/managed/repo-slug/task/packages/app", headCommit: COMMIT });
	});

	it("fails closed on platform mismatch without conversion", async () => {
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: REGISTERED, stderr: "", exitCode: 0, signaled: false }));
		const foreign = { version: 1 as const, platform: "windows" as const, kind: "drive" as const, path: "C:\\managed\\task" };
		expect(await resumeWorktreeLocator(adapters, resumeRequest(foreign))).toMatchObject({ ok: false, error: { code: "platform_mismatch" } });
	});

	it("fails closed when the persisted path no longer exists", async () => {
		const adapters = linuxDeps({ "/managed": "/managed" }, () => ({ stdout: REGISTERED, stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(await resumeWorktreeLocator(adapters, resumeRequest(encodePrivateLocator(parsed.value, "linux")))).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});

	it("fails closed with stale_registration when git no longer registers the worktree (no source fallback)", async () => {
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: "worktree /repo\n" + `HEAD ${COMMIT}\n` + "branch refs/heads/master\n", stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(await resumeWorktreeLocator(adapters, resumeRequest(encodePrivateLocator(parsed.value, "linux")))).toMatchObject({ ok: false, error: { code: "stale_registration" } });
	});

	it("fails closed on base drift instead of silently re-pointing", async () => {
		const drift = REGISTERED.replaceAll(`HEAD ${COMMIT}`, "HEAD " + "a".repeat(40));
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: drift, stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(await resumeWorktreeLocator(adapters, resumeRequest(encodePrivateLocator(parsed.value, "linux")))).toMatchObject({ ok: false, error: { code: "base_drift" } });
	});

	it("fails closed when the effective subdir escapes the worktree root", async () => {
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: REGISTERED, stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const request = { ...resumeRequest(encodePrivateLocator(parsed.value, "linux")), effectiveSubdir: "../../escape" };
		expect(await resumeWorktreeLocator(adapters, request)).toMatchObject({ ok: false, error: { code: "cross_root_containment" } });
	});

	it("fails closed when the lease is stale or fenced", async () => {
		const adapters = linuxDeps({ "/managed/repo-slug/task": "/managed/repo-slug/task", "/managed": "/managed" }, () => ({ stdout: REGISTERED, stderr: "", exitCode: 0, signaled: false }));
		const parsed = adapters.path.parse("/managed/repo-slug/task");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const request = resumeRequest(encodePrivateLocator(parsed.value, "linux"));
		expect(await resumeWorktreeLocator({ ...adapters, checkLease: async () => "workspace lease is stale or fenced" }, request)).toMatchObject({ ok: false, error: { code: "invalid_state", message: "workspace lease is stale or fenced" } });
	});
});
