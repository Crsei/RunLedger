/** 平台原生 adapter 共享实现：path/Git/process 三适配器（P4）。 */

/**
 * 本文件按传入 platform 构造，不读取运行时平台分支；三平台各自入口见
 * `native/linux.ts` / `native/macos.ts` / `native/windows.ts`，唯一运行时
 * 分支点是 `factory.ts`。真实 runner 证据未通过的平台由 factory 保持
 * typed unsupported（ADR D5 `unverified_platform`）。
 */

import { realpath as fsRealpath } from "node:fs/promises";
import { parsePath, ancestorCandidates, containmentCheck, identityFromLocator, validateLocatorForPlatform } from "../path-adapter.ts";
import { parseWorktreePorcelain } from "../git-porcelain.ts";
import { processCapabilityFor } from "../process-capability.ts";
import { validateBranchName } from "../../worktree/paths.ts";
import type { PathIdentity, PrivateLocatorV1, WorkspacePathErrorCode, WorkspacePathResult, WorkspacePlatform } from "../types.ts";
import type { GitCommandPort } from "../../worktree/ports.ts";
import type { GitRepositoryInfo, GitWorktreeAdapter, GitWorktreeStatus, NativeAdapterDeps, PathSyscallPort, RegisteredWorktreeMatch, ResolvedShell, WorkspaceAdapters, WorkspacePathAdapter, WorkspaceProcessAdapter } from "./types.ts";
import type { PorcelainWorktreeEntry } from "../git-porcelain.ts";

function failure<T>(code: WorkspacePathErrorCode, message: string, retryable = false): WorkspacePathResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function isCommit(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function boundedDetail(stderr: string): string {
	return stderr
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 512);
}

function defaultSyscall(): PathSyscallPort {
	return {
		realpath: async (path) => {
			try {
				return await fsRealpath(path);
			} catch {
				return undefined;
			}
		},
	};
}

class NativePathAdapter implements WorkspacePathAdapter {
	readonly platform: WorkspacePlatform;
	readonly #syscall: PathSyscallPort;
	readonly #containmentRoot?: PathIdentity;

	public constructor(platform: WorkspacePlatform, syscall: PathSyscallPort, containmentRoot?: PathIdentity) {
		this.platform = platform;
		this.#syscall = syscall;
		this.#containmentRoot = containmentRoot;
	}

	public parse(input: string): WorkspacePathResult<PathIdentity> {
		return parsePath(input, this.platform);
	}

	async #contained(identity: PathIdentity): Promise<WorkspacePathResult<PathIdentity>> {
		if (this.#containmentRoot === undefined) return { ok: true, value: identity };
		const check = containmentCheck(this.#containmentRoot, identity, this.platform);
		if (!check.ok) return check;
		if (check.value !== "inside") return failure("cross_root_containment", `resolved identity is outside the managed root: ${identity.displayPath}`);
		return { ok: true, value: identity };
	}

	public async realIdentity(input: string): Promise<WorkspacePathResult<PathIdentity>> {
		const parsed = parsePath(input, this.platform);
		if (!parsed.ok) return parsed;
		const canonical = await this.#syscall.realpath(input);
		if (canonical === undefined) return failure("invalid_path", `path does not exist or is not resolvable: ${parsed.value.displayPath}`);
		const identity = parsePath(canonical, this.platform);
		if (!identity.ok) return identity;
		return this.#contained(identity.value);
	}

	public async candidateIdentity(input: string): Promise<WorkspacePathResult<PathIdentity>> {
		const parsed = parsePath(input, this.platform);
		if (!parsed.ok) return parsed;
		const ancestors = ancestorCandidates(parsed.value, this.platform);
		let anchor: string | undefined;
		let anchorIndex = 0;
		for (let i = 0; i < ancestors.length; i++) {
			const resolved = await this.#syscall.realpath(ancestors[i]);
			if (resolved !== undefined) {
				anchor = resolved;
				anchorIndex = i;
				break;
			}
		}
		if (anchor === undefined) return failure("invalid_path", "no existing ancestor found for candidate path");
		const allSegments = parsed.value.displayPath.split(this.platform === "windows" ? "\\" : "/").filter((s) => s.length > 0);
		const rootSegmentCount = parsed.value.root.kind === "posix" ? 0 : parsed.value.root.kind === "drive" ? 1 : 2;
		const relative = allSegments.slice(rootSegmentCount);
		// missing = 原 lexical 路径中 ancestors[anchorIndex] 之后的 segments。
		// 不能用解析后 anchor 的 segment 数切分：symlink 可能改变路径深度
		// （如 /managed/link → /real/deeper/root），必须按 lexical 位置切。
		const missing = relative.slice(relative.length - 1 - anchorIndex);
		const composed = missing.length === 0
			? anchor
			: this.platform === "windows"
				? `${anchor}\\${missing.join("\\")}`
				: `${anchor.replace(/\/+$/u, "")}/${missing.join("/")}`;
		const identity = parsePath(composed, this.platform);
		if (!identity.ok) return identity;
		return this.#contained(identity.value);
	}

	public isWithin(parent: PathIdentity, child: PathIdentity): WorkspacePathResult<"inside" | "outside" | "cross_root"> {
		return containmentCheck(parent, child, this.platform);
	}

	public async openLocator(locator: PrivateLocatorV1): Promise<WorkspacePathResult<PathIdentity>> {
		const validated = validateLocatorForPlatform(locator, this.platform);
		if (!validated.ok) return validated;
		const identity = identityFromLocator(validated.value);
		if (!identity.ok) return identity;
		return this.realIdentity(identity.value.displayPath);
	}
}

/** 供 workspace settings/安全组合复用的 canonical path adapter。 */
export function createNativeWorkspacePathAdapter(
	platform: WorkspacePlatform,
	syscall: PathSyscallPort = defaultSyscall(),
): WorkspacePathAdapter {
	return new NativePathAdapter(platform, syscall);
}

interface GitRunResult {
	readonly stdout: string;
	readonly signaled: boolean;
}

class NativeGitWorktreeAdapter implements GitWorktreeAdapter {
	readonly platform: WorkspacePlatform;
	readonly #git: GitCommandPort;
	readonly #path: WorkspacePathAdapter;
	readonly #managedRoot: PathIdentity;
	readonly #timeoutMs: number;

	public constructor(platform: WorkspacePlatform, git: GitCommandPort, path: WorkspacePathAdapter, managedRoot: string, timeoutMs: number) {
		this.platform = platform;
		this.#git = git;
		this.#path = path;
		const parsedRoot = parsePath(managedRoot, platform);
		if (!parsedRoot.ok) throw new Error(`managedRoot is not an absolute ${platform} path: ${managedRoot}`);
		this.#managedRoot = parsedRoot.value;
		this.#timeoutMs = timeoutMs;
	}

	async #run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<WorkspacePathResult<GitRunResult>> {
		try {
			const result = await this.#git.run({ cwd, arguments: args, timeoutMs: this.#timeoutMs }, signal);
			const detail = boundedDetail(result.stderr);
			return result.exitCode === 0 && !result.signaled
				? { ok: true, value: { stdout: result.stdout, signaled: false } }
				: failure("git_failed", `git ${args[0]} failed${detail.length > 0 ? `: ${detail}` : ""}`, result.signaled);
		} catch {
			return failure("git_failed", "git command broker is unavailable", true);
		}
	}

	#target(input: string): WorkspacePathResult<string> {
		const parsed = this.#path.parse(input);
		if (!parsed.ok) return parsed;
		const check = this.#path.isWithin(this.#managedRoot, parsed.value);
		if (!check.ok) return check;
		if (check.value !== "inside") return failure("cross_root_containment", "Git worktree target is outside the managed root");
		return { ok: true, value: parsed.value.displayPath };
	}

	public async list(repo: string, signal?: AbortSignal): Promise<WorkspacePathResult<readonly PorcelainWorktreeEntry[]>> {
		const listed = await this.#run(repo, ["worktree", "list", "--porcelain"], signal);
		return listed.ok ? { ok: true, value: parseWorktreePorcelain(listed.value.stdout) } : listed;
	}

	public async createDetached(repo: string, target: string, baseCommit: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>> {
		const parsed = this.#target(target);
		if (!parsed.ok) return parsed;
		if (!isCommit(baseCommit)) return failure("invalid_path", "Git base commit is not a canonical commit");
		const result = await this.#run(repo, ["worktree", "add", "--detach", parsed.value, baseCommit], signal);
		return result.ok ? { ok: true, value: parsed.value } : result;
	}

	public async createBranch(repo: string, target: string, branch: string, baseCommit: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>> {
		const parsed = this.#target(target);
		if (!parsed.ok) return parsed;
		const valid = validateBranchName(branch);
		if (!valid.ok) return failure("invalid_path", "Git worktree branch name is unsafe");
		if (!isCommit(baseCommit)) return failure("invalid_path", "Git base commit is not a canonical commit");
		const result = await this.#run(repo, ["worktree", "add", "--no-track", "-b", valid.value, parsed.value, baseCommit], signal);
		return result.ok ? { ok: true, value: parsed.value } : result;
	}

	public async remove(repo: string, target: string, force: boolean, signal?: AbortSignal): Promise<WorkspacePathResult<string>> {
		const parsed = this.#target(target);
		if (!parsed.ok) return parsed;
		const registered = await this.registeredTarget(repo, parsed.value, signal);
		if (!registered.ok) return registered;
		if (registered.value.registered.locked) return failure("invalid_state", "registered worktree is locked by git; unlock before remove");
		const result = await this.#run(repo, ["worktree", "remove", ...(force ? ["--force"] : []), parsed.value], signal);
		return result.ok ? { ok: true, value: parsed.value } : result;
	}

	public async inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorkspacePathResult<GitRepositoryInfo>> {
		const root = await this.#run(cwd, ["rev-parse", "--show-toplevel"], signal);
		if (!root.ok) return failure("invalid_path", "cwd is not inside a Git repository");
		const prefix = await this.#run(cwd, ["rev-parse", "--show-prefix"], signal);
		if (!prefix.ok) return prefix;
		const head = await this.#run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		const branch = await this.#run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
		return {
			ok: true,
			value: {
				root: root.value.stdout.trim(),
				prefix: prefix.value.stdout.trim().replace(/\/$/u, ""),
				headCommit: head.value.stdout.trim(),
				branch: branch.ok ? branch.value.stdout.trim() : "HEAD",
			},
		};
	}

	public async inspectWorktree(path: string, signal?: AbortSignal): Promise<WorkspacePathResult<GitWorktreeStatus>> {
		const target = this.#target(path);
		if (!target.ok) return target;
		const status = await this.#run(target.value, ["status", "--porcelain", "--untracked-files=all"], signal);
		if (!status.ok) return status;
		const head = await this.#run(target.value, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
		if (!head.ok) return head;
		return { ok: true, value: { dirty: status.value.stdout.trimEnd().length > 0, status: status.value.stdout, headCommit: head.value.stdout.trim() } };
	}

	public async resolveCommit(repo: string, ref: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>> {
		if (ref.length === 0 || ref.length > 256 || ref.startsWith("-") || ref.includes("\0") || /[\s~^:?*[\\]/u.test(ref)) {
			return failure("invalid_path", "Git base ref is unsafe");
		}
		const resolved = await this.#run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal);
		return resolved.ok ? { ok: true, value: resolved.value.stdout.trim() } : resolved;
	}

	public async registeredTarget(repo: string, requested: string, signal?: AbortSignal): Promise<WorkspacePathResult<RegisteredWorktreeMatch>> {
		const parsed = this.#path.parse(requested);
		if (!parsed.ok) return parsed;
		const entries = await this.list(repo, signal);
		if (!entries.ok) return entries;
		for (const entry of entries.value) {
			const identity = this.#path.parse(entry.path);
			if (!identity.ok) continue;
			if (identity.value.compareKey === parsed.value.compareKey) {
				return { ok: true, value: { registered: entry, identity: identity.value, match: true } };
			}
		}
		const listed = entries.value.map((entry) => entry.path).join(", ");
		return failure("stale_registration", `no registered worktree matches the requested target identity${listed.length > 0 ? ` (registered: ${listed})` : ""}`);
	}
}

class NativeProcessAdapter implements WorkspaceProcessAdapter {
	readonly platform: WorkspacePlatform;
	readonly #syscall: PathSyscallPort;
	readonly #env: Record<string, string | undefined>;

	public constructor(platform: WorkspacePlatform, syscall: PathSyscallPort, env: Record<string, string | undefined>) {
		this.platform = platform;
		this.#syscall = syscall;
		this.#env = env;
	}

	public capability() {
		return processCapabilityFor(this.platform, { shell: this.#env["SHELL"], comspec: this.#env["COMSPEC"], pathext: this.#env["PATHEXT"] });
	}

	async #resolvable(candidate: string): Promise<boolean> {
		return (await this.#syscall.realpath(candidate)) !== undefined;
	}

	public async resolveShell(shellId?: string): Promise<WorkspacePathResult<ResolvedShell>> {
		const capability = this.capability();
		const descriptor = shellId === undefined
			? capability.shells.find((s) => s.id === capability.defaultShellId) ?? capability.shells[0]
			: capability.shells.find((s) => s.id === shellId);
		if (descriptor === undefined) return failure("invalid_path", `unknown shell id: ${String(shellId)}`);
		const pathSeparator = this.platform === "windows" ? ";" : ":";
		const pathExt = capability.pathExt ?? [""];
		const pathDirs = (this.#env["PATH"] ?? "").split(pathSeparator).filter((p) => p.length > 0);
		for (const candidate of descriptor.executableCandidates) {
			if (this.platform !== "windows") {
				const names = candidate.includes("/") ? [candidate] : pathDirs.map((dir) => `${dir.replace(/\/+$/u, "")}/${candidate}`);
				for (const full of names) {
					if (await this.#resolvable(full)) return this.#resolved(descriptor, full);
				}
				continue;
			}
			const names = candidate.includes("\\") || candidate.includes(":") ? [candidate] : pathDirs.map((dir) => `${dir.replace(/\\+$/u, "")}\\${candidate}`);
			const withExt = names.flatMap((name) => pathExt.map((ext) => (name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`)));
			for (const full of withExt) {
				if (await this.#resolvable(full)) return this.#resolved(descriptor, full);
			}
		}
		return failure("invalid_path", `shell executable not found: ${descriptor.id}`);
	}

	#resolved(descriptor: { id: string; launchArgs: readonly string[]; pathTranslation: "native" | "msys" }, executable: string): WorkspacePathResult<ResolvedShell> {
		return { ok: true, value: { id: descriptor.id, executable, launchArgs: descriptor.launchArgs, pathTranslation: descriptor.pathTranslation } };
	}
}

export function createNativeWorkspaceAdapters(platform: WorkspacePlatform, deps: NativeAdapterDeps): WorkspaceAdapters {
	const syscall = deps.fs ?? defaultSyscall();
	const managedParsed = parsePath(deps.managedRoot, platform);
	const path = new NativePathAdapter(platform, syscall, managedParsed.ok ? managedParsed.value : undefined);
	const git = new NativeGitWorktreeAdapter(platform, deps.git, path, deps.managedRoot, deps.timeoutMs ?? 30_000);
	const env: Record<string, string | undefined> = {
		SHELL: deps.env?.shell,
		COMSPEC: deps.env?.comspec,
		PATHEXT: deps.env?.pathext,
		PATH: deps.env?.path ?? process.env.PATH,
	};
	const processAdapter = new NativeProcessAdapter(platform, syscall, env);
	return { platform, path, git, process: processAdapter };
}
