import { describe, expect, it } from "vitest";
import { relative, resolve } from "node:path";
import { createRuntimeId } from "../../src/runtime/contracts/public.ts";
import {
	buildManagedWorktreePath,
	pathWithin,
	resolveSubdirOffset,
	validateBranchName,
	validateWorktreeLabel,
} from "../../src/worktree/paths.ts";

describe("worktree path boundary", () => {
	it.each(["task", "task-123", "a"])("accepts a strict label: %s", (label) => {
		expect(validateWorktreeLabel(label)).toEqual({ ok: true, value: label });
	});

	it.each(["../task", "Task", "task/path", "task--x", "task-", ".", ""])("rejects unsafe labels: %s", (label) => {
		expect(validateWorktreeLabel(label)).toMatchObject({ ok: false });
	});

	it("derives a deterministic managed path under the supplied root", () => {
		expect(buildManagedWorktreePath(
			"/managed",
			createRuntimeId("repository", "repo-one"),
			createRuntimeId("workspace", "workspace-one"),
			"task",
		)).toEqual({ ok: true, value: resolve("/managed", "repo-one", "task-workspace-one") });
	});

	it("preserves a source subdirectory offset without prefix confusion", () => {
		expect(resolveSubdirOffset("/repo", "/repo/packages/app")).toEqual({ ok: true, value: relative(resolve("/repo"), resolve("/repo/packages/app")) });
		expect(resolveSubdirOffset("/repo", "/repo-other/app")).toMatchObject({ ok: false });
		expect(pathWithin("/repo", "/repo-other")).toBe(false);
	});

	it.each(["runledger/task", "feature/x", "main"])("accepts a safe branch: %s", (branch) => {
		expect(validateBranchName(branch)).toEqual({ ok: true, value: branch });
	});

	it.each(["../main", "bad branch", "refs//x", "-bad", "bad.lock?", ""])("rejects an unsafe branch: %s", (branch) => {
		expect(validateBranchName(branch)).toMatchObject({ ok: false });
	});
});
