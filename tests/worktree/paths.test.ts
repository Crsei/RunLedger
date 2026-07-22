import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { buildManagedWorktreePath, pathWithin, resolveSubdirOffset, validateBranchName, validateWorktreeLabel } from "../../src/worktree/paths.ts";

describe("worktree paths", () => {
	it.each(["task", "task-123", "a"])("accepts a strict label: %s", (label) => {
		expect(validateWorktreeLabel(label)).toEqual({ ok: true, value: label });
	});

	it.each(["../task", "Task", "task/path", "task--x", "task-", ".", ""])("rejects an unsafe label: %s", (label) => {
		expect(validateWorktreeLabel(label)).toMatchObject({ ok: false });
	});

	it("builds a deterministic path under the managed root", () => {
		const result = buildManagedWorktreePath(
			"/managed",
			createRuntimeId("repository", "repo-one"),
			createRuntimeId("workspace", "workspace-one"),
			"task",
		);
		expect(result).toEqual({ ok: true, value: "/managed/repo-one/task-workspace-one" });
	});

	it("preserves source subdirectory offset without prefix confusion", () => {
		expect(resolveSubdirOffset("/repo", "/repo/packages/app")).toEqual({ ok: true, value: "packages/app" });
		expect(resolveSubdirOffset("/repo", "/repo-other/app")).toMatchObject({ ok: false });
		expect(pathWithin("/repo", "/repo-other")).toBe(false);
	});

	it.each(["runledger/task", "feature/x", "main"])("accepts a safe branch: %s", (branch) => {
		expect(validateBranchName(branch)).toEqual({ ok: true, value: branch });
	});

	it.each(["../main", "bad branch", "refs//x", "-bad", "bad.lock?"])("rejects an unsafe branch: %s", (branch) => {
		expect(validateBranchName(branch)).toMatchObject({ ok: false });
	});
});
