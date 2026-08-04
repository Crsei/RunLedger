/** typed argv Git broker；不经 shell 拼接，目标路径先过 managed containment。 */

import { isAbsolute, resolve } from "node:path";
import { pathWithin, validateBranchName } from "./paths.ts";
import type { GitCommandPort, GitCommandResult } from "./ports.ts";
import type { WorktreeResult } from "./types.ts";

export type { GitCommandPort, GitCommandRequest, GitCommandResult } from "./ports.ts";

function failure(message: string, retryable = false, code: "git_failed" | "outside_managed_root" = "git_failed"): WorktreeResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function boundedError(result: GitCommandResult): string {
	const detail = result.stderr
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, "$1[redacted]@")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 512);
	return detail.length > 0 ? `git command exited with code ${result.exitCode}: ${detail}` : `git command exited with code ${result.exitCode}`;
}

function validCommit(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function validRef(value: string): boolean {
	return value.length > 0 && value.length <= 256 && !value.startsWith("-") && !value.includes("\0") && !/[\s~^:?*[\\]/u.test(value);
}

export interface GitRepositoryInfo {
	readonly root: string;
	readonly prefix: string;
	readonly headCommit: string;
	readonly branch: string;
}

export interface GitWorktreeStatus {
	readonly status: string;
	readonly dirty: boolean;
	readonly headCommit: string;
	readonly unpublished: boolean;
}

export interface GitWorktreeInfo {
	readonly path: string;
	readonly headCommit: string;
	readonly branch?: string;
}

export interface GitOperationsOptions {
	readonly managedRoot: string;
	readonly timeoutMs?: number;
}

export class GitOperations {
	readonly #commands: GitCommandPort;
	readonly #managedRoot: string;
	readonly #timeoutMs: number;

	public constructor(commands: GitCommandPort, options: GitOperationsOptions) {
		this.#commands = commands;
		this.#managedRoot = resolve(options.managedRoot);
		this.#timeoutMs = options.timeoutMs ?? 30_000;
	}

	#target(path: string): WorktreeResult<string> {
		if (!isAbsolute(path) || !pathWithin(this.#managedRoot, path)) return failure("Git worktree target is outside the managed root", false, "outside_managed_root");
		return { ok: true, value: resolve(path) };
	}

	async #run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<WorktreeResult<string>> {
		try {
			const result = await this.#commands.run({ cwd, arguments: args, timeoutMs: this.#timeoutMs }, signal);
			return result.exitCode === 0 && !result.signaled ? { ok: true, value: result.stdout.trimEnd() } : failure(boundedError(result), result.signaled);
		} catch {
			return failure("git command broker is unavailable", true);
		}
	}

	public inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorktreeResult<GitRepositoryInfo>> {
		return this.#inspectRepository(cwd, signal);
	}

	async #inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorktreeResult<GitRepositoryInfo>> {
		const root = await this.#run(cwd, ["rev-parse", "--show-toplevel"], signal);
		if (!root.ok) return { ok: false, error: { code: "git_failed", message: "cwd is not inside a Git repository", retryable: false } };
		const prefix = await this.#run(cwd, ["rev-parse", "--show-prefix"], signal);
		if (!prefix.ok) return prefix;
		const head = await this.#run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		const branch = await this.#run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
		return { ok: true, value: { root: resolve(root.value), prefix: prefix.value.replace(/\/$/u, ""), headCommit: head.value, branch: branch.ok ? branch.value : "HEAD" } };
	}

	public resolveCommit(repo: string, ref: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return validRef(ref)
			? this.#run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)
			: Promise.resolve(failure("Git base ref is unsafe"));
	}

	public createWorktree(repo: string, path: string, branch: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		const target = this.#target(path);
		if (!target.ok) return Promise.resolve(target);
		const validBranch = validateBranchName(branch);
		if (!validBranch.ok) return Promise.resolve(validBranch);
		return validCommit(baseCommit)
			? this.#run(repo, ["worktree", "add", "--no-track", "-b", validBranch.value, target.value, baseCommit], signal)
			: Promise.resolve(failure("Git base commit is not a canonical commit"));
	}

	public createDetachedWorktree(repo: string, path: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		const target = this.#target(path);
		return target.ok && validCommit(baseCommit)
			? this.#run(repo, ["worktree", "add", "--detach", target.value, baseCommit], signal)
			: Promise.resolve(target.ok ? failure("Git base commit is not a canonical commit") : target);
	}

	public removeWorktree(repo: string, path: string, force: boolean, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		const target = this.#target(path);
		return target.ok ? this.#run(repo, ["worktree", "remove", ...(force ? ["--force"] : []), target.value], signal) : Promise.resolve(target);
	}

	public listWorktrees(repo: string, signal?: AbortSignal): Promise<WorktreeResult<readonly GitWorktreeInfo[]>> {
		return this.#listWorktrees(repo, signal);
	}

	async #listWorktrees(repo: string, signal?: AbortSignal): Promise<WorktreeResult<readonly GitWorktreeInfo[]>> {
		const listed = await this.#run(repo, ["worktree", "list", "--porcelain"], signal);
		if (!listed.ok) return listed;
		const entries: GitWorktreeInfo[] = [];
		let current: { path?: string; headCommit?: string; branch?: string } = {};
		const flush = (): void => {
			if (!current.path || !current.headCommit) return;
			entries.push({ path: resolve(current.path), headCommit: current.headCommit, ...(current.branch ? { branch: current.branch } : {}) });
			current = {};
		};
		for (const line of listed.value.split("\n")) {
			if (line.length === 0) {
				flush();
				continue;
			}
			if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
			else if (line.startsWith("HEAD ")) current.headCommit = line.slice("HEAD ".length);
			else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
		}
		flush();
		return { ok: true, value: entries };
	}

	public inspectWorktreeStatus(path: string, signal?: AbortSignal): Promise<WorktreeResult<GitWorktreeStatus>> {
		return this.#inspectWorktreeStatus(path, signal);
	}

	async #inspectWorktreeStatus(path: string, signal?: AbortSignal): Promise<WorktreeResult<GitWorktreeStatus>> {
		const target = this.#target(path);
		if (!target.ok) return target;
		const status = await this.#run(target.value, ["status", "--porcelain", "--untracked-files=all"], signal);
		if (!status.ok) return status;
		const head = await this.#run(target.value, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		return { ok: true, value: { status: status.value, dirty: status.value.length > 0, headCommit: head.value, unpublished: false } };
	}
}
