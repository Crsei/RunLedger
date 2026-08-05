/** P4 native adapter 接口与注入端口；实现目录是平台分支的唯一合法归属（除 factory）。 */

import type { GitCommandPort } from "../../worktree/ports.ts";
import type { WorkspaceProcessCapability, ProcessCapabilityEnv } from "../process-capability.ts";
import type { PathIdentity, PrivateLocatorV1, WorkspacePathResult, WorkspacePlatform } from "../types.ts";
import type { PorcelainWorktreeEntry } from "../git-porcelain.ts";

/** filesystem syscall 注入端口：native adapter 不直接持有 node:fs（保持可测试与静态边界可查）。 */
export interface PathSyscallPort {
	/** 已存在路径的 real identity（symlink 全部解析）；不存在/不可解析返回 undefined。 */
	realpath(path: string): Promise<string | undefined>;
}

export interface WorkspacePathAdapter {
	readonly platform: WorkspacePlatform;
	parse(input: string): WorkspacePathResult<PathIdentity>;
	/** existing path：realpath 真实身份（ADR D2）。 */
	realIdentity(input: string): Promise<WorkspacePathResult<PathIdentity>>;
	/** candidate path：nearest-existing-ancestor realpath + lexical 剩余段（ADR D2）。 */
	candidateIdentity(input: string): Promise<WorkspacePathResult<PathIdentity>>;
	isWithin(parent: PathIdentity, child: PathIdentity): WorkspacePathResult<"inside" | "outside" | "cross_root">;
	/** ADR D4：同平台恢复 + 重验证；platform mismatch/不存在 fail closed。 */
	openLocator(locator: PrivateLocatorV1): Promise<WorkspacePathResult<PathIdentity>>;
}

export interface GitRepositoryInfo {
	readonly root: string;
	readonly prefix: string;
	readonly headCommit: string;
	readonly branch: string;
}

export interface RegisteredWorktreeMatch {
	readonly registered: PorcelainWorktreeEntry;
	readonly identity: PathIdentity;
	/** requested target 与 Git 注册 target 的同一性比较结果（ADR D2）。 */
	readonly match: boolean;
}

export interface GitWorktreeStatus {
	readonly dirty: boolean;
	readonly status: string;
	readonly headCommit: string;
}

export interface GitWorktreeAdapter {
	readonly platform: WorkspacePlatform;
	list(repo: string, signal?: AbortSignal): Promise<WorkspacePathResult<readonly PorcelainWorktreeEntry[]>>;
	createDetached(repo: string, target: string, baseCommit: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>>;
	createBranch(repo: string, target: string, branch: string, baseCommit: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>>;
	remove(repo: string, target: string, force: boolean, signal?: AbortSignal): Promise<WorkspacePathResult<string>>;
	inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorkspacePathResult<GitRepositoryInfo>>;
	/** 解析 ref 到 canonical commit（rev-parse --verify --end-of-options）。 */
	resolveCommit(repo: string, ref: string, signal?: AbortSignal): Promise<WorkspacePathResult<string>>;
	/** worktree 脏状态与 HEAD（status --porcelain + rev-parse HEAD）。 */
	inspectWorktree(path: string, signal?: AbortSignal): Promise<WorkspacePathResult<GitWorktreeStatus>>;
	/**
	 * 把 requested target 与 `git worktree list --porcelain` 的注册 target 做
	 * 同一性比较；无注册条目时 match=false（remove/resume 前必须验证）。
	 */
	registeredTarget(repo: string, requested: string, signal?: AbortSignal): Promise<WorkspacePathResult<RegisteredWorktreeMatch>>;
}

export interface ResolvedShell {
	readonly id: string;
	readonly executable: string;
	readonly launchArgs: readonly string[];
	readonly pathTranslation: "native" | "msys";
}

export interface WorkspaceProcessAdapter {
	readonly platform: WorkspacePlatform;
	/** 平台 Shell/termination/cleanup 能力描述（P3 纯层）。 */
	capability(): WorkspaceProcessCapability;
	/** 解析 shell 可执行路径（PATH/PATHEXT 规则）；不 spawn，只解析。 */
	resolveShell(shellId?: string): Promise<WorkspacePathResult<ResolvedShell>>;
}

export interface WorkspaceAdapters {
	readonly platform: WorkspacePlatform;
	readonly path: WorkspacePathAdapter;
	readonly git: GitWorktreeAdapter;
	readonly process: WorkspaceProcessAdapter;
}

export interface NativeAdapterDeps {
	readonly git: GitCommandPort;
	readonly fs?: PathSyscallPort;
	readonly env?: ProcessCapabilityEnv;
	/** Git worktree target 的 managed root（containment 校验）。 */
	readonly managedRoot: string;
	readonly timeoutMs?: number;
}
