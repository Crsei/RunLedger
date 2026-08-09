/** Managed native Git worktree 生命周期；不直接持有 raw filesystem/process API。 */

import { basename, resolve } from "node:path";
import { createRuntimeId, runtimeDigest, type SessionId, type WorkspaceId } from "../runtime/contracts/public.ts";
import type { WorkspaceAdapters } from "../workspace/native/types.ts";
import type { GitWorktreeInfo } from "./git-operations.ts";
import { buildManagedWorktreePath, pathWithin, resolveSubdirOffset, validateBranchName, validateWorktreeLabel } from "./paths.ts";
import { WorktreeRegistry } from "./registry.ts";
import type { GitCommandPort } from "./ports.ts";
import type { PorcelainWorktreeEntry } from "../workspace/git-porcelain.ts";
import { GitOperations } from "./git-operations.ts";
import type { WorktreeRecord, WorktreeResult } from "./types.ts";

export interface WorktreeCreateRequest {
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly sourceCwd: string;
	readonly label: string;
	readonly baseRef?: string;
	readonly branch?: string;
	/** Session Owner production locator；必须仍位于 managedRoot 内。 */
	readonly canonicalTarget?: string;
	readonly signal?: AbortSignal;
}

export interface WorktreeRemovalApproval {
	readonly requestId: string;
}

export interface WorktreeRemoveOptions {
	readonly dryRun?: boolean;
	readonly force?: boolean;
	readonly approval?: WorktreeRemovalApproval;
	readonly signal?: AbortSignal;
}

export interface WorktreeRemovalPreview {
	readonly record: WorktreeRecord;
	readonly dirty: boolean;
	readonly status: string;
	readonly dryRun: boolean;
}

export interface WorktreeListing {
	readonly record: WorktreeRecord;
	readonly gitPresent: boolean;
	readonly stale: boolean;
	readonly git?: GitWorktreeInfo;
}

export interface WorktreeManagerOptions {
	readonly registry: WorktreeRegistry;
	readonly git: GitOperations | GitCommandPort;
	readonly managedRoot: string;
	readonly clock?: () => Date;
	readonly timeoutMs?: number;
	/**
	 * P6：平台 workspace adapters（factory 装配）。注入后 containment 与
	 * Git 生命周期（create/remove/list/status/resolveCommit）全部经 adapter
	 * （compare-key + porcelain）；缺省保留 GitOperations/node:path 语义
	 * （测试/fake 接缝，生产组合必传）。
	 */
	readonly workspace?: WorkspaceAdapters;
}

function failure<T>(code: "invalid_request" | "outside_managed_root" | "git_failed" | "registry_failed" | "not_found" | "invalid_state" | "dirty_worktree" | "approval_required" | "lease_conflict" | "lease_stale" | "reconcile_stale", message: string, retryable = false): WorktreeResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function gitOperations(value: GitOperations | GitCommandPort, managedRoot: string, timeoutMs: number | undefined): GitOperations {
	return value instanceof GitOperations ? value : new GitOperations(value, { managedRoot, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

function activeState(state: WorktreeRecord["state"]): boolean {
	return state === "creating" || state === "ready" || state === "active" || state === "retained" || state === "removing";
}

function porcelainToInfo(entry: PorcelainWorktreeEntry): GitWorktreeInfo {
	return { path: entry.path, headCommit: entry.head ?? "", ...(entry.branch === undefined ? {} : { branch: entry.branch }) };
}

export class WorktreeManager {
	readonly #registry: WorktreeRegistry;
	readonly #git: GitOperations;
	readonly #managedRoot: string;
	readonly #clock: () => Date;
	readonly #workspace: WorkspaceAdapters | undefined;

	public constructor(options: WorktreeManagerOptions) {
		this.#registry = options.registry;
		this.#managedRoot = resolve(options.managedRoot);
		this.#git = gitOperations(options.git, this.#managedRoot, options.timeoutMs);
		this.#clock = options.clock ?? (() => new Date());
		this.#workspace = options.workspace;
	}

	// ---------------------------------------------------------------------------
	// adapter 优先的私有原语；workspace 注入时全部走 compare-key/porcelain。
	// ---------------------------------------------------------------------------

	#containedInManaged(target: string): WorktreeResult<boolean> {
		if (this.#workspace === undefined) return { ok: true, value: pathWithin(this.#managedRoot, target) };
		const parsed = this.#workspace.path.parse(target);
		if (!parsed.ok) return { ok: false, error: { code: "outside_managed_root", message: parsed.error.message, retryable: false } };
		const root = this.#workspace.path.parse(this.#managedRoot);
		if (!root.ok) return { ok: false, error: { code: "outside_managed_root", message: root.error.message, retryable: false } };
		const checked = this.#workspace.path.isWithin(root.value, parsed.value);
		if (!checked.ok) return { ok: false, error: { code: "outside_managed_root", message: checked.error.message, retryable: false } };
		return { ok: true, value: checked.value === "inside" };
	}

	#overlapsSource(sourceRoot: string, target: string): WorktreeResult<boolean> {
		const inside = (parent: string, child: string): WorktreeResult<boolean> => {
			if (this.#workspace !== undefined) {
				const parentParsed = this.#workspace.path.parse(parent);
				const childParsed = this.#workspace.path.parse(child);
				if (!parentParsed.ok || !childParsed.ok) return { ok: true, value: true };
				const checked = this.#workspace.path.isWithin(parentParsed.value, childParsed.value);
				return checked.ok ? { ok: true, value: checked.value === "inside" } : { ok: true, value: true };
			}
			return { ok: true, value: pathWithin(parent, child) };
		};
		const sourceInTarget = inside(sourceRoot, target);
		if (!sourceInTarget.ok) return sourceInTarget;
		if (sourceInTarget.value) return { ok: true, value: true };
		return inside(target, sourceRoot);
	}

	async #inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorktreeResult<{ root: string; prefix: string; headCommit: string; branch: string }>> {
		if (this.#workspace === undefined) return this.#git.inspectRepository(cwd, signal);
		const inspected = await this.#workspace.git.inspectRepository(cwd, signal);
		if (!inspected.ok) return { ok: false, error: { code: "git_failed", message: inspected.error.message, retryable: inspected.error.retryable } };
		return { ok: true, value: inspected.value };
	}

	async #resolveCommit(repo: string, ref: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		if (this.#workspace === undefined) return this.#git.resolveCommit(repo, ref, signal);
		const resolved = await this.#workspace.git.resolveCommit(repo, ref, signal);
		if (!resolved.ok) return { ok: false, error: { code: "git_failed", message: resolved.error.message, retryable: resolved.error.retryable } };
		return { ok: true, value: resolved.value };
	}

	async #createGitWorktree(repo: string, target: string, branch: string | undefined, baseCommit: string, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		if (this.#workspace === undefined) {
			return branch === undefined
				? this.#git.createDetachedWorktree(repo, target, baseCommit, signal)
				: this.#git.createWorktree(repo, target, branch, baseCommit, signal);
		}
		const created = branch === undefined
			? await this.#workspace.git.createDetached(repo, target, baseCommit, signal)
			: await this.#workspace.git.createBranch(repo, target, branch, baseCommit, signal);
		if (!created.ok) return { ok: false, error: { code: "git_failed", message: created.error.message, retryable: created.error.retryable } };
		return { ok: true, value: created.value };
	}

	async #removeGitWorktree(repo: string, target: string, force: boolean, signal?: AbortSignal): Promise<WorktreeResult<string>> {
		if (this.#workspace === undefined) return this.#git.removeWorktree(repo, target, force, signal);
		const removed = await this.#workspace.git.remove(repo, target, force, signal);
		if (!removed.ok) return { ok: false, error: { code: removed.error.code === "git_failed" ? "git_failed" : "invalid_state", message: removed.error.message, retryable: removed.error.retryable } };
		return { ok: true, value: removed.value };
	}

	async #inspectWorktreeStatus(path: string, signal?: AbortSignal): Promise<WorktreeResult<{ dirty: boolean; status: string; headCommit: string }>> {
		if (this.#workspace === undefined) return this.#git.inspectWorktreeStatus(path, signal);
		const status = await this.#workspace.git.inspectWorktree(path, signal);
		if (!status.ok) return { ok: false, error: { code: "git_failed", message: status.error.message, retryable: status.error.retryable } };
		return { ok: true, value: status.value };
	}

	async #listGitWorktrees(repo: string, signal?: AbortSignal): Promise<WorktreeResult<readonly GitWorktreeInfo[]>> {
		if (this.#workspace === undefined) return this.#git.listWorktrees(repo, signal);
		const listed = await this.#workspace.git.list(repo, signal);
		if (!listed.ok) return { ok: false, error: { code: "git_failed", message: listed.error.message, retryable: listed.error.retryable } };
		return { ok: true, value: listed.value.map(porcelainToInfo) };
	}

	/** Git 注册条目与记录 target 的同一性：adapter 用 compare-key，legacy 用字符串相等。 */
	#gitEntryMatches(entry: GitWorktreeInfo, record: WorktreeRecord): boolean {
		if (this.#workspace === undefined) return entry.path === record.worktreeLocator;
		const parsed = this.#workspace.path.parse(entry.path);
		if (!parsed.ok) return false;
		const recorded = this.#workspace.path.parse(record.worktreeLocator);
		return recorded.ok && parsed.value.compareKey === recorded.value.compareKey;
	}

	public async create(request: WorktreeCreateRequest): Promise<WorktreeResult<WorktreeRecord>> {
		const label = validateWorktreeLabel(request.label);
		if (!label.ok) return label;
		if (request.branch !== undefined) {
			const branch = validateBranchName(request.branch);
			if (!branch.ok) return branch;
		}
		const repository = await this.#inspectRepository(request.sourceCwd, request.signal);
		if (!repository.ok) return repository;
		const sourceOffset = resolveSubdirOffset(repository.value.root, request.sourceCwd);
		if (!sourceOffset.ok) return sourceOffset;
		const baseRef = request.baseRef ?? (repository.value.branch === "HEAD" ? "HEAD" : repository.value.branch);
		const baseCommit = await this.#resolveCommit(repository.value.root, baseRef, request.signal);
		if (!baseCommit.ok) return baseCommit;
		// Workspace binding validation derives the repository identity from the
		// canonical source root. Keep the manager and cold-replay formula equal.
		const repositoryId = createRuntimeId("repository", runtimeDigest(repository.value.root).digest.slice(0, 48));
		const target = request.canonicalTarget === undefined
			? buildManagedWorktreePath(this.#managedRoot, repositoryId, request.workspaceId, label.value)
			: { ok: true as const, value: resolve(request.canonicalTarget) };
		if (!target.ok) return target;
		const contained = await this.#containedInManaged(target.value);
		if (!contained.ok) return contained;
		if (!contained.value) return failure("outside_managed_root", "managed worktree target is outside the managed root");
		const overlap = await this.#overlapsSource(repository.value.root, target.value);
		if (!overlap.ok) return overlap;
		if (overlap.value) return failure("outside_managed_root", "managed worktree target overlaps source repository");
		const now = this.#clock().getTime();
		const record: WorktreeRecord = {
			id: createRuntimeId("workspace", runtimeDigest({ sessionId: request.sessionId, workspaceId: request.workspaceId, target: target.value, baseCommit: baseCommit.value }).digest.slice(0, 48)),
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			sourceRepositoryRef: { repositoryId, rootDigest: runtimeDigest(repository.value.root), displayName: basename(repository.value.root) || "repository" },
			sourceRepositoryPath: repository.value.root,
			sourceSubdir: sourceOffset.value,
			worktreeLocator: target.value,
			effectiveSubdir: sourceOffset.value,
			baseRef,
			baseCommit: baseCommit.value,
			...(request.branch === undefined ? {} : { branch: request.branch }),
			label: label.value,
			state: "creating",
			createdAt: now,
			lastAccessedAt: now,
		};
		const claimed = await this.#registry.create(record);
		if (!claimed.ok) return claimed;
		if (!claimed.value.inserted) return { ok: true, value: claimed.value.record };
		const created = await this.#createGitWorktree(repository.value.root, target.value, request.branch, baseCommit.value, request.signal);
		if (!created.ok) {
			await this.#removeGitWorktree(repository.value.root, target.value, true, request.signal);
			await this.#registry.state(record.id, "failed", this.#clock().getTime(), created.error.message);
			return created;
		}
		const finalized = await this.#registry.state(record.id, "ready", this.#clock().getTime());
		return finalized;
	}

	public async get(worktreeId: string): Promise<WorktreeResult<WorktreeRecord>> {
		return this.#registry.get(worktreeId);
	}

	public async touch(worktreeId: string): Promise<WorktreeResult<WorktreeRecord>> {
		return this.#registry.touch(worktreeId, this.#clock().getTime());
	}

	public async remove(worktreeId: string, options: WorktreeRemoveOptions = {}): Promise<WorktreeResult<WorktreeRemovalPreview>> {
		const found = await this.#registry.get(worktreeId);
		if (!found.ok) return found;
		const record = found.value;
		if (!activeState(record.state) || record.state === "creating" || record.state === "removing") return failure("invalid_state", `worktree is not removable in state ${record.state}`);
		const contained = await this.#containedInManaged(record.worktreeLocator);
		if (!contained.ok) return contained;
		const overlap = await this.#overlapsSource(record.sourceRepositoryPath, record.worktreeLocator);
		if (!overlap.ok) return overlap;
		if (!contained.value || overlap.value) return failure("outside_managed_root", "worktree removal target is outside the managed worktree boundary");
		const status = await this.#inspectWorktreeStatus(record.worktreeLocator, options.signal);
		if (!status.ok) return status;
		const preview: WorktreeRemovalPreview = { record, dirty: status.value.dirty, status: status.value.status, dryRun: options.dryRun === true };
		if (options.dryRun === true) return { ok: true, value: preview };
		if (status.value.dirty && options.force !== true) return failure("dirty_worktree", "dirty worktree removal requires exact force approval");
		if (options.force === true && options.approval === undefined) return failure("approval_required", "force worktree removal requires an exact approval reference");
		const removing = await this.#registry.state(record.id, "removing", this.#clock().getTime());
		if (!removing.ok) return removing;
		const removed = await this.#removeGitWorktree(record.sourceRepositoryPath, record.worktreeLocator, options.force === true, options.signal);
		if (!removed.ok) {
			await this.#registry.state(record.id, "ready", this.#clock().getTime(), removed.error.message);
			return removed;
		}
		const finalized = await this.#registry.state(record.id, "removed", this.#clock().getTime());
		if (!finalized.ok) return finalized;
		return { ok: true, value: { ...preview, dryRun: false, record: finalized.value } };
	}

	public async list(): Promise<WorktreeResult<readonly WorktreeListing[]>> {
		const records = await this.#registry.list();
		if (!records.ok) return records;
		const byRepository = new Map<string, GitWorktreeInfo[]>();
		for (const record of records.value) {
			if (!activeState(record.state)) continue;
			if (!byRepository.has(record.sourceRepositoryPath)) {
				const listed = await this.#listGitWorktrees(record.sourceRepositoryPath);
				if (!listed.ok) return listed;
				byRepository.set(record.sourceRepositoryPath, [...listed.value]);
			}
		}
		return {
			ok: true,
			value: records.value.map((record) => {
				const git = byRepository.get(record.sourceRepositoryPath)?.find((item) => this.#gitEntryMatches(item, record));
				return { record, gitPresent: git !== undefined, stale: git === undefined, ...(git === undefined ? {} : { git }) };
			}),
		};
	}
}
