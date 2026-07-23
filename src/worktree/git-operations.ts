/** typed argv Git broker；不经 shell 拼接。 */

import { resolve } from "node:path";
import type { GitCommandPort, GitCommandResult } from "./ports.ts";
import type { WorktreeResult } from "./types.ts";

function failure(message: string, retryable = false): WorktreeResult<never> {
	return { ok: false, error: { code: "git_failed", message, retryable } };
}

function output(result: GitCommandResult): WorktreeResult<string> {
	return result.exitCode === 0 && !result.signaled
		? { ok: true, value: result.stdout.trimEnd() }
		: failure("git command failed");
}

export interface GitRepositoryInfo {
	root: string;
	prefix: string;
	headCommit: string;
	branch: string;
}

export interface GitWorktreeStatus {
	status: string;
	dirty: boolean;
	headCommit: string;
	unpublished: boolean;
}

export interface GitWorkspaceSnapshot {
	rawIndex: string;
	headEntries: string;
	stagedDiff: string;
	unstagedDiff: string;
	changedEntries: string;
	untrackedPaths: readonly string[];
	ignoredPaths: readonly string[];
	conflictedEntries: string;
	submoduleStatus: string;
}

export class GitOperations {
	readonly #commands: GitCommandPort;
	readonly #timeoutMs: number;

	public constructor(commands: GitCommandPort, timeoutMs = 30_000) {
		this.#commands = commands;
		this.#timeoutMs = timeoutMs;
	}

	async #run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<WorktreeResult<string>> {
		try {
			return output(await this.#commands.run({ cwd, arguments: args, timeoutMs: this.#timeoutMs }, signal));
		} catch {
			return failure("git command broker is unavailable", true);
		}
	}

	async #runPreserved(
		cwd: string,
		args: readonly string[],
		signal?: AbortSignal,
		stdin?: string,
	): Promise<WorktreeResult<string>> {
		try {
			const result = await this.#commands.run({
				cwd,
				arguments: args,
				...(stdin === undefined ? {} : { stdin }),
				timeoutMs: this.#timeoutMs,
			}, signal);
			return result.exitCode === 0 && !result.signaled
				? { ok: true, value: result.stdout }
				: failure("git command failed");
		} catch {
			return failure("git command broker is unavailable", true);
		}
	}

	async #runBinary(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<WorktreeResult<Uint8Array>> {
		try {
			const result = await this.#commands.run({ cwd, arguments: args, timeoutMs: this.#timeoutMs }, signal);
			if (result.exitCode !== 0 || result.signaled) return failure("git command failed");
			return result.stdoutBytes
				? { ok: true, value: Uint8Array.from(result.stdoutBytes) }
				: failure("git command broker did not preserve binary stdout");
		} catch {
			return failure("git command broker is unavailable", true);
		}
	}

	public async inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorktreeResult<GitRepositoryInfo>> {
		const root = await this.#run(cwd, ["rev-parse", "--show-toplevel"], signal);
		if (!root.ok) return { ok: false, error: { code: "not_repository", message: "cwd is not inside a Git repository", retryable: false } };
		const prefix = await this.#run(cwd, ["rev-parse", "--show-prefix"], signal);
		if (!prefix.ok) return prefix;
		const head = await this.#run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		const branch = await this.#run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
		return { ok: true, value: { root: resolve(root.value), prefix: prefix.value.replace(/\/$/u, ""), headCommit: head.value, branch: branch.ok ? branch.value : "HEAD" } };
	}

	public resolveCommit(repo: string, ref: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(repo, ["rev-parse", "--verify", `${ref}^{commit}`], signal);
	}

	public async branchExists(repo: string, branch: string, signal?: AbortSignal): Promise<WorktreeResult<boolean>> {
		try {
			const result = await this.#commands.run({ cwd: repo, arguments: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs: this.#timeoutMs }, signal);
			if (result.signaled) return failure("git branch probe was interrupted", true);
			if (result.exitCode === 0) return { ok: true, value: true };
			if (result.exitCode === 1) return { ok: true, value: false };
			return failure("git branch probe failed");
		} catch {
			return failure("git command broker is unavailable", true);
		}
	}

	public createWorktree(repo: string, path: string, branch: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(repo, ["worktree", "add", "--no-track", "-b", branch, path, baseCommit], signal);
	}

	public createDetachedWorktree(repo: string, path: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(repo, ["worktree", "add", "--detach", path, baseCommit], signal);
	}

	public removeWorktree(repo: string, path: string, force: boolean, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path], signal);
	}

	public prune(repo: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(repo, ["worktree", "prune", "--expire", "now"], signal);
	}

	public async isRegistered(repo: string, path: string, signal?: AbortSignal): Promise<WorktreeResult<boolean>> {
		const listed = await this.#run(repo, ["worktree", "list", "--porcelain"], signal);
		if (!listed.ok) return listed;
		const target = resolve(path);
		const registered = listed.value.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.some((line) => resolve(line.slice("worktree ".length)) === target);
		return { ok: true, value: registered };
	}

	public async status(path: string, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<GitWorktreeStatus>> {
		const status = await this.#run(path, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
		if (!status.ok) return status;
		const head = await this.#run(path, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		return { ok: true, value: { status: status.value, dirty: status.value.length > 0, headCommit: head.value, unpublished: head.value !== baseCommit } };
	}

	public async diff(path: string, baseCommit: string, maxBytes: number, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		const changed = await this.#run(path, ["diff", "--binary", `${baseCommit}...HEAD`], signal);
		if (!changed.ok) return changed;
		const working = await this.#run(path, ["diff", "--binary", "HEAD"], signal);
		if (!working.ok) return working;
		const combined = `${changed.value}${changed.value && working.value ? "\n" : ""}${working.value}`;
		return combined.length <= maxBytes
			? { ok: true, value: combined }
			: { ok: false, error: { code: "invalid_request", message: "worktree diff exceeds preview bound", retryable: false } };
	}

	public async captureWorkspaceSnapshot(path: string, signal?: AbortSignal): Promise<WorktreeResult<GitWorkspaceSnapshot>> {
		const commands = await Promise.all([
			this.#runPreserved(path, ["ls-files", "--stage", "-z"], signal),
			this.#runPreserved(path, ["ls-tree", "-r", "-z", "HEAD"], signal),
			this.#runPreserved(path, ["diff", "--binary", "--cached", "HEAD"], signal),
			this.#runPreserved(path, ["diff", "--binary"], signal),
			this.#runPreserved(path, ["diff", "--name-status", "-z", "HEAD"], signal),
			this.#runPreserved(path, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
			this.#runPreserved(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], signal),
			this.#runPreserved(path, ["ls-files", "--unmerged", "--stage", "-z"], signal),
			this.#runPreserved(path, ["submodule", "status", "--recursive"], signal),
		]);
		const failed = commands.find((result) => !result.ok);
		if (failed && !failed.ok) return failed;
		const values = commands.map((result) => result.ok ? result.value : "");
		const nulList = (value: string): readonly string[] => value.split("\0").filter((entry) => entry.length > 0);
		return {
			ok: true,
			value: {
				rawIndex: values[0] ?? "",
				headEntries: values[1] ?? "",
				stagedDiff: values[2] ?? "",
				unstagedDiff: values[3] ?? "",
				changedEntries: values[4] ?? "",
				untrackedPaths: nulList(values[5] ?? ""),
				ignoredPaths: nulList(values[6] ?? ""),
				conflictedEntries: values[7] ?? "",
				submoduleStatus: values[8] ?? "",
			},
		};
	}

	public readBlob(path: string, objectId: string, signal?: AbortSignal): Promise<WorktreeResult<Uint8Array>> {
		if (!/^[a-f0-9]{40,64}$/u.test(objectId)) return Promise.resolve(failure("git object id is invalid"));
		return this.#runBinary(path, ["cat-file", "blob", objectId], signal);
	}

	public async lfsTrackedPaths(
		path: string,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<WorktreeResult<readonly string[]>> {
		if (paths.length === 0) return { ok: true, value: [] };
		if (paths.some((entry) => entry.includes("\0"))) return failure("Git path contains NUL");
		const result = await this.#runPreserved(path, ["check-attr", "-z", "--stdin", "filter"], signal, `${paths.join("\0")}\0`);
		if (!result.ok) return result;
		const fields = result.value.split("\0");
		const lfs: string[] = [];
		for (let index = 0; index + 2 < fields.length; index += 3) {
			if (fields[index + 1] === "filter" && fields[index + 2] === "lfs") lfs.push(fields[index]!);
		}
		return { ok: true, value: lfs };
	}

	public resetHard(path: string, commit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(path, ["reset", "--hard", commit], signal);
	}

	public cleanUntracked(path: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(path, ["clean", "-fd"], signal);
	}

	public cleanAllUntracked(path: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		return this.#run(path, ["clean", "-fdx"], signal);
	}

	public applyPatch(path: string, patch: string, staged: boolean, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		if (patch.length === 0) return Promise.resolve({ ok: true, value: "" });
		return this.#runPreserved(
			path,
			["apply", "--binary", "--whitespace=nowarn", ...(staged ? ["--index"] : [])],
			signal,
			patch,
		);
	}
}
