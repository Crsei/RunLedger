/** P5 cold resume：locator 恢复时重验 platform/root/Git/lease/effective cwd（ADR D4）。 */

/**
 * 恢复顺序固定：platform 匹配 → path 存在 → Git 注册同一性 → HEAD == base
 * （不静默改指）→ effective subdir containment → lease。任一失败 fail closed，
 * 绝不回退到 source repo checkout。
 */

import { parsePath, validateLocatorForPlatform } from "./path-adapter.ts";
import type { PathIdentity, PrivateLocatorV1, WorkspacePathErrorCode } from "./types.ts";
import type { WorkspacePathAdapter, GitWorktreeAdapter } from "./native/types.ts";

export interface WorkspaceResumeDeps {
	readonly path: WorkspacePathAdapter;
	readonly git: GitWorktreeAdapter;
	/** lease 有效性校验；返回错误消息表示未通过。 */
	readonly checkLease?: () => Promise<string | undefined>;
}

export interface WorktreeResumeRequest {
	/** 已解码的 versioned private locator（不在此处接受未版本化记录）。 */
	readonly record: PrivateLocatorV1;
	/** source repo（`git worktree list --porcelain` 的执行 cwd）。 */
	readonly repo: string;
	/** 记录时的 base commit；worktree HEAD 不再等于它时 fail closed。 */
	readonly expectedBaseCommit: string;
	/** root-relative subdir offset（"." 表示 root 本身）。 */
	readonly effectiveSubdir?: string;
}

export type WorkspaceResumeResult =
	| { readonly ok: true; readonly identity: PathIdentity; readonly effectiveCwd: string; readonly headCommit: string }
	| { readonly ok: false; readonly error: { readonly code: WorkspacePathErrorCode; readonly message: string; readonly retryable: boolean } };

function failure(code: WorkspacePathErrorCode, message: string, retryable = false): { readonly ok: false; readonly error: { readonly code: WorkspacePathErrorCode; readonly message: string; readonly retryable: boolean } } {
	return { ok: false, error: { code, message, retryable } };
}

function isCommit(value: string | undefined): boolean {
	return value !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

export async function resumeWorktreeLocator(deps: WorkspaceResumeDeps, request: WorktreeResumeRequest): Promise<WorkspaceResumeResult> {
	// 1. platform/kind 匹配；跨平台 locator 不猜测转换。
	const validated = validateLocatorForPlatform(request.record, deps.path.platform);
	if (!validated.ok) return validated;

	// 2. path 存在且仍是预期身份（symlink 全部解析）。
	const identity = await deps.path.openLocator(request.record);
	if (!identity.ok) return identity;

	// 3. Git 注册同一性：requested target 与 `git worktree list` 注册 target 比较。
	const registered = await deps.git.registeredTarget(request.repo, identity.value.displayPath);
	if (!registered.ok) return registered;

	// 4. HEAD == base；漂移绝不静默改指 source repo。
	const head = registered.value.registered.head;
	if (!isCommit(head) || head !== request.expectedBaseCommit) {
		return failure("base_drift", `worktree HEAD no longer matches the recorded base commit; refusing to re-point to the source repository`);
	}

	// 5. effective subdir containment。
	let effectiveCwd = identity.value.displayPath;
	if (request.effectiveSubdir !== undefined && request.effectiveSubdir !== "." && request.effectiveSubdir !== "") {
		const composed = deps.path.platform === "windows"
			? `${identity.value.displayPath}\\${request.effectiveSubdir}`
			: `${identity.value.displayPath.replace(/\/+$/u, "")}/${request.effectiveSubdir}`;
		const subdir = parsePath(composed, deps.path.platform);
		if (!subdir.ok) return subdir;
		const within = deps.path.isWithin(identity.value, subdir.value);
		if (!within.ok) return within;
		if (within.value !== "inside") return failure("cross_root_containment", "effective subdir escapes the worktree root");
		effectiveCwd = subdir.value.displayPath;
	}

	// 6. lease。
	const leaseError = await deps.checkLease?.();
	if (leaseError !== undefined) return failure("invalid_state", leaseError);

	return { ok: true, identity: identity.value, effectiveCwd, headCommit: head };
}
