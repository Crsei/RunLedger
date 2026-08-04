/**
 * Host-owned worktree composition.
 *
 * WorktreeManager owns Git lifecycle, WorktreeRegistry owns durable identity,
 * and JsonWorkspaceBindingStore owns the cold-replay binding.  This service
 * only composes those ports; it does not create a second writer or process
 * backend.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RunledgerLayout, RuntimeInstanceId, SessionId, WorkspaceId, WorkspaceLeaseRef } from "../runtime/contracts/public.ts";
import { isWorkspaceLeaseRef } from "../runtime/contracts/public.ts";
import { GitOperations, type GitCommandPort } from "./git-operations.ts";
import { WorktreeLeaseManager } from "./lease.ts";
import {
	createPersistedWorkspaceBinding,
	JsonWorkspaceBindingStore,
	validatePersistedWorkspaceBinding,
	validateWorkspaceBindingObservation,
	type PersistedWorkspaceBinding,
	type WorkspaceBindingErrorCode,
} from "./persisted-binding.ts";
import { WorktreeManager, type WorktreeCreateRequest } from "./manager.ts";
import { WorktreeRegistry } from "./registry.ts";
import type { WorktreeErrorCode, WorktreeResult } from "./types.ts";

export interface HostWorkspaceBindingCreateRequest extends Omit<WorktreeCreateRequest, "signal"> {
	readonly effectiveCwd?: string;
}

export interface HostWorkspaceBindingResumeRequest {
	readonly cwd: string;
}

export type WorkspaceBindingServiceErrorCode = WorktreeErrorCode | WorkspaceBindingErrorCode | "worktree_drift";

export interface WorkspaceBindingServiceError {
	readonly code: WorkspaceBindingServiceErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type WorkspaceBindingServiceResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: WorkspaceBindingServiceError };

export interface HostWorkspaceBindingServiceOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly managedRoot: string;
	readonly registry: WorktreeRegistry;
	readonly git: GitOperations | GitCommandPort;
	readonly ownerRuntimeId: RuntimeInstanceId;
	readonly clock?: () => Date;
	readonly leaseTtlMs?: number;
}

function failure<T>(code: WorkspaceBindingServiceErrorCode, message: string, retryable = false): WorkspaceBindingServiceResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function mapWorktree<T>(result: WorktreeResult<T>): WorkspaceBindingServiceResult<T> {
	return result.ok ? result : failure(result.error.code, result.error.message, result.error.retryable);
}

function sameLease(left: WorkspaceLeaseRef, right: WorkspaceLeaseRef): boolean {
	return left.workspaceId === right.workspaceId &&
		left.ownerRuntimeId === right.ownerRuntimeId &&
		left.leaseRevision === right.leaseRevision &&
		left.state === right.state &&
		left.fencingTokenDigest.digest === right.fencingTokenDigest.digest &&
		left.expiresAt === right.expiresAt;
}

function within(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function isActiveLease(lease: WorkspaceLeaseRef, now: number): boolean {
	return lease.state === "active" && (lease.expiresAt === undefined || Date.parse(lease.expiresAt) > now);
}

/**
 * The only production entry point that turns a WorktreeRecord into a Runtime
 * WorkspaceBindingRef.  All subsequent Host resume paths call resume(), which
 * re-observes Git registration, head, path and lease before returning.
 */
export class HostWorkspaceBindingService {
	readonly #store: JsonWorkspaceBindingStore;
	readonly #registry: WorktreeRegistry;
	readonly #git: GitOperations;
	readonly #manager: WorktreeManager;
	readonly #leases: WorktreeLeaseManager;
	readonly #ownerRuntimeId: RuntimeInstanceId;
	readonly #clock: () => Date;

	public constructor(options: HostWorkspaceBindingServiceOptions) {
		this.#store = new JsonWorkspaceBindingStore({ layout: options.layout, workspaceStorageKey: options.workspaceStorageKey });
		this.#registry = options.registry;
		this.#git = options.git instanceof GitOperations ? options.git : new GitOperations(options.git, { managedRoot: options.managedRoot });
		this.#manager = new WorktreeManager({ registry: options.registry, git: this.#git, managedRoot: options.managedRoot, clock: options.clock });
		this.#leases = new WorktreeLeaseManager(options.registry, { clock: options.clock, defaultTtlMs: options.leaseTtlMs });
		this.#ownerRuntimeId = options.ownerRuntimeId;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async read(): Promise<WorkspaceBindingServiceResult<PersistedWorkspaceBinding | undefined>> {
		try {
			return { ok: true, value: await this.#store.read() };
		} catch (error) {
			return failure("binding_invalid", error instanceof Error ? error.message : "workspace binding cannot be read", true);
		}
	}

	public async create(request: HostWorkspaceBindingCreateRequest): Promise<WorkspaceBindingServiceResult<PersistedWorkspaceBinding>> {
		let existing: PersistedWorkspaceBinding | undefined;
		try {
			existing = await this.#store.read();
		} catch (error) {
			return failure("binding_invalid", error instanceof Error ? error.message : "workspace binding cannot be read", true);
		}
		if (existing !== undefined) return this.resume({ cwd: request.effectiveCwd ?? defaultEffectiveCwd(existing) });

		const worktree = await this.#manager.create(request);
		const mappedWorktree = mapWorktree(worktree);
		if (!mappedWorktree.ok) return mappedWorktree;
		const record = mappedWorktree.value;
		const lease = await this.#leases.acquire(record.workspaceId, this.#ownerRuntimeId);
		const mappedLease = mapWorktree(lease);
		if (!mappedLease.ok) return mappedLease;

		const observed = await this.#observeGit(record.sourceRepositoryPath, record.worktreeLocator);
		if (!observed.ok) return observed;
		const effectiveCwd = request.effectiveCwd ?? resolve(record.worktreeLocator, record.effectiveSubdir === "." ? "" : record.effectiveSubdir);
		if (!within(record.worktreeLocator, effectiveCwd)) return failure("binding_invalid", "effective cwd escapes the managed worktree");
		const binding = createPersistedWorkspaceBinding({ record, lease: mappedLease.value, effectiveCwd, headCommit: observed.value.headCommit });
		if (!binding.ok) return failure(binding.error.code, binding.error.message, binding.error.retryable);
		try {
			const committed = await this.#store.commit(binding.value);
			return committed.ok ? committed : failure(committed.error.code, committed.error.message, committed.error.retryable);
		} catch (error) {
			return failure("binding_invalid", error instanceof Error ? error.message : "workspace binding cannot be committed", true);
		}
	}

	public async resume(request: HostWorkspaceBindingResumeRequest): Promise<WorkspaceBindingServiceResult<PersistedWorkspaceBinding>> {
		let stored: PersistedWorkspaceBinding | undefined;
		try {
			stored = await this.#store.read();
		} catch (error) {
			return failure("binding_invalid", error instanceof Error ? error.message : "workspace binding cannot be read", true);
		}
		if (stored === undefined) return failure("binding_not_found", "workspace binding is not persisted");
		const baseValidation = validatePersistedBinding(stored);
		if (!baseValidation.ok) return baseValidation;
		const cwd = resolve(request.cwd);
		if (!within(stored.worktreePath, cwd)) return failure("binding_drift", "resume cwd is outside the persisted worktree");

		const record = await this.#registry.get(stored.worktreeId);
		if (!record.ok) return failure(record.error.code, record.error.message, record.error.retryable);
		if (record.value.worktreeLocator !== stored.worktreePath || record.value.state === "removed" || record.value.state === "failed") {
			return failure("binding_drift", "persisted worktree record no longer matches the binding");
		}
		const lease = await this.#registry.lease(stored.binding.workspaceId);
		if (!lease.ok) return failure(lease.error.code, lease.error.message, lease.error.retryable);
		const now = this.#clock().getTime();
		if (!lease.value || !isWorkspaceLeaseRef(lease.value) || !sameLease(lease.value, stored.lease) || !isActiveLease(lease.value, now)) {
			return failure("binding_drift", "persisted workspace lease is stale or fenced");
		}
		const observed = await this.#observeGit(stored.sourceRepositoryPath, stored.worktreePath);
		if (!observed.ok) return observed;
		const validation = validateWorkspaceBindingObservation(stored, {
			workspaceId: stored.binding.workspaceId,
			repositoryId: stored.binding.repositoryId,
			worktreeId: stored.worktreeId,
			sourceSubdir: stored.sourceSubdir,
			worktreePath: stored.worktreePath,
			effectiveCwd: cwd,
			baseCommit: stored.baseCommit,
			headCommit: observed.value.headCommit,
		});
		if (!validation.ok) return failure(validation.error.code, validation.error.message, validation.error.retryable);
		return { ok: true, value: validation.value };
	}

	async #observeGit(sourceRepositoryPath: string, worktreePath: string): Promise<WorkspaceBindingServiceResult<{ readonly headCommit: string }>> {
		const listed = await this.#git.listWorktrees(sourceRepositoryPath);
		if (!listed.ok) return failure("worktree_drift", listed.error.message, listed.error.retryable);
		const registration = listed.value.find((entry) => resolve(entry.path) === resolve(worktreePath));
		if (!registration) return failure("binding_drift", "worktree is no longer registered with Git");
		const status = await this.#git.inspectWorktreeStatus(worktreePath);
		if (!status.ok) return failure("binding_drift", status.error.message, status.error.retryable);
		if (registration.headCommit !== status.value.headCommit) return failure("binding_drift", "worktree head changed during observation");
		return { ok: true, value: { headCommit: status.value.headCommit } };
	}
}

function validatePersistedBinding(value: PersistedWorkspaceBinding): WorkspaceBindingServiceResult<PersistedWorkspaceBinding> {
	const checked = validatePersistedWorkspaceBinding(value);
	return checked.ok ? checked : failure(checked.error.code, checked.error.message, checked.error.retryable);
}

function defaultEffectiveCwd(binding: PersistedWorkspaceBinding): string {
	return binding.effectiveCwd;
}
