/** Worktree label、source subdir 与 managed-root 边界纯函数。 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryId, WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { WorktreeResult } from "./types.ts";

function failure(message: string): WorktreeResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

export function pathWithin(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

export function validateWorktreeLabel(label: string): WorktreeResult<string> {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(label) || label.endsWith("-") || label.includes("--")) {
		return failure("worktree label must be a lowercase slug without path syntax");
	}
	return { ok: true, value: label };
}

function idTail(value: string): string {
	const tail = value.split("_").at(-1) ?? value;
	return tail.replace(/[^A-Za-z0-9._~-]/gu, "-").slice(0, 32);
}

export function buildManagedWorktreePath(
	managedRoot: string,
	repositoryId: RepositoryId,
	workspaceId: WorkspaceId,
	label: string,
): WorktreeResult<string> {
	const valid = validateWorktreeLabel(label);
	if (!valid.ok) return valid;
	const target = resolve(managedRoot, idTail(repositoryId), `${label}-${idTail(workspaceId)}`);
	return pathWithin(managedRoot, target)
		? { ok: true, value: target }
		: { ok: false, error: { code: "outside_managed_root", message: "derived worktree path escapes managed root", retryable: false } };
}

export function resolveSubdirOffset(sourceRepo: string, sourceCwd: string): WorktreeResult<string> {
	if (!pathWithin(sourceRepo, sourceCwd)) return failure("source cwd is outside repository root");
	const offset = relative(resolve(sourceRepo), resolve(sourceCwd));
	return { ok: true, value: offset === "" ? "." : offset };
}

export function validateBranchName(branch: string): WorktreeResult<string> {
	if (
		branch.length === 0 || branch.length > 240 || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
		branch.includes("..") || branch.includes("//") || branch.includes("@{") || /[\s~^:?*[\\]/u.test(branch)
	) return failure("worktree branch name is unsafe");
	return { ok: true, value: branch };
}
