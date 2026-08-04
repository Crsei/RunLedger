/** Managed native Git worktree 生命周期；不直接持有 raw filesystem/process API。 */

import { basename, resolve } from "node:path";
import { createRuntimeId, runtimeDigest, type SessionId, type WorkspaceId } from "../runtime/contracts/public.ts";
import { GitOperations, type GitCommandPort, type GitWorktreeInfo } from "./git-operations.ts";
import { buildManagedWorktreePath, pathWithin, resolveSubdirOffset, validateBranchName, validateWorktreeLabel } from "./paths.ts";
import { WorktreeRegistry } from "./registry.ts";
import type { WorktreeRecord, WorktreeResult } from "./types.ts";

export interface WorktreeCreateRequest {
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly sourceCwd: string;
	readonly label: string;
	readonly baseRef?: string;
	readonly branch?: string;
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

export class WorktreeManager {
	readonly #registry: WorktreeRegistry;
	readonly #git: GitOperations;
	readonly #managedRoot: string;
	readonly #clock: () => Date;

	public constructor(options: WorktreeManagerOptions) {
		this.#registry = options.registry;
		this.#managedRoot = resolve(options.managedRoot);
		this.#git = gitOperations(options.git, this.#managedRoot, options.timeoutMs);
		this.#clock = options.clock ?? (() => new Date());
	}

	public async create(request: WorktreeCreateRequest): Promise<WorktreeResult<WorktreeRecord>> {
		const label = validateWorktreeLabel(request.label);
		if (!label.ok) return label;
		if (request.branch !== undefined) {
			const branch = validateBranchName(request.branch);
			if (!branch.ok) return branch;
		}
		const repository = await this.#git.inspectRepository(request.sourceCwd, request.signal);
		if (!repository.ok) return repository;
		const sourceOffset = resolveSubdirOffset(repository.value.root, request.sourceCwd);
		if (!sourceOffset.ok) return sourceOffset;
		const baseRef = request.baseRef ?? (repository.value.branch === "HEAD" ? "HEAD" : repository.value.branch);
		const baseCommit = await this.#git.resolveCommit(repository.value.root, baseRef, request.signal);
		if (!baseCommit.ok) return baseCommit;
		// Workspace binding validation derives the repository identity from the
		// canonical source root. Keep the manager and cold-replay formula equal.
		const repositoryId = createRuntimeId("repository", runtimeDigest(repository.value.root).digest.slice(0, 48));
		const target = buildManagedWorktreePath(this.#managedRoot, repositoryId, request.workspaceId, label.value);
		if (!target.ok) return target;
		if (pathWithin(repository.value.root, target.value) || pathWithin(target.value, repository.value.root)) return failure("outside_managed_root", "managed worktree target overlaps source repository");
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
		const created = request.branch === undefined
			? await this.#git.createDetachedWorktree(repository.value.root, target.value, baseCommit.value, request.signal)
			: await this.#git.createWorktree(repository.value.root, target.value, request.branch, baseCommit.value, request.signal);
		if (!created.ok) {
			await this.#git.removeWorktree(repository.value.root, target.value, true, request.signal);
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
		if (!pathWithin(this.#managedRoot, record.worktreeLocator) || pathWithin(record.sourceRepositoryPath, record.worktreeLocator) || pathWithin(record.worktreeLocator, record.sourceRepositoryPath)) return failure("outside_managed_root", "worktree removal target is outside the managed worktree boundary");
		const status = await this.#git.inspectWorktreeStatus(record.worktreeLocator, options.signal);
		if (!status.ok) return status;
		const preview: WorktreeRemovalPreview = { record, dirty: status.value.dirty, status: status.value.status, dryRun: options.dryRun === true };
		if (options.dryRun === true) return { ok: true, value: preview };
		if (status.value.dirty && options.force !== true) return failure("dirty_worktree", "dirty worktree removal requires exact force approval");
		if (options.force === true && options.approval === undefined) return failure("approval_required", "force worktree removal requires an exact approval reference");
		const removing = await this.#registry.state(record.id, "removing", this.#clock().getTime());
		if (!removing.ok) return removing;
		const removed = await this.#git.removeWorktree(record.sourceRepositoryPath, record.worktreeLocator, options.force === true, options.signal);
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
				const listed = await this.#git.listWorktrees(record.sourceRepositoryPath);
				if (!listed.ok) return listed;
				byRepository.set(record.sourceRepositoryPath, [...listed.value]);
			}
		}
		return {
			ok: true,
			value: records.value.map((record) => {
				const git = byRepository.get(record.sourceRepositoryPath)?.find((item) => item.path === record.worktreeLocator);
				return { record, gitPresent: git !== undefined, stale: git === undefined, ...(git === undefined ? {} : { git }) };
			}),
		};
	}
}
