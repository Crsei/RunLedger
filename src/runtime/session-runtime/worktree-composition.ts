/** S3:Session row-owned worktree locator 与 cold-resume production composition。 */

import { join, resolve } from "node:path";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import type { SessionId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionWorkspaceFactory, SessionWorkspaceHandle } from "../../cli/embedded-session-runtime.ts";
import { WorktreeManager } from "../../worktree/manager.ts";
import { WorktreeLeaseManager } from "../../worktree/lease.ts";
import {
	createPersistedWorkspaceBinding,
	validatePersistedWorkspaceBinding,
	validateWorkspaceBindingObservation,
	type PersistedWorkspaceBinding,
} from "../../worktree/persisted-binding.ts";
import type { GitCommandPort } from "../../worktree/ports.ts";
import { WorktreeRegistry } from "../../worktree/registry.ts";
import type { WorktreeLeaseRecord } from "../../worktree/types.ts";
import { resumeWorktreeLocator } from "../../workspace/resume.ts";
import type { WorkspaceAdapters } from "../../workspace/native/types.ts";

export type SessionWorkspaceMode = "auto" | "create" | "disabled";

export interface SessionWorkspaceFactoryOptions {
	readonly layout: RunledgerLayout;
	readonly sourceCwd: string;
	readonly mode: SessionWorkspaceMode;
	readonly label?: string;
	readonly baseRef?: string;
	readonly branch?: string;
	readonly git: GitCommandPort;
	readonly registry: WorktreeRegistry;
	readonly workspace: WorkspaceAdapters;
}

export function createSessionWorkspaceFactory(options: SessionWorkspaceFactoryOptions): SessionWorkspaceFactory {
	const sourceCwd = resolve(options.sourceCwd);
	const manager = new WorktreeManager({
		registry: options.registry,
		git: options.git,
		managedRoot: options.layout.worktrees,
		workspace: options.workspace,
	});
	const leases = new WorktreeLeaseManager(options.registry);
	return {
		open: async ({ sessionId, store, fence }) => {
			const session = store.getSession(sessionId);
			if (session === undefined) throw new Error(`session worktree open failed: session not found: ${sessionId}`);
			if (session.worktreeLocator === undefined) {
				if (options.mode !== "create") return sourceWorkspaceHandle(sourceCwd);
				const created = await manager.create({
					sessionId,
					workspaceId: session.workspaceId as Parameters<typeof manager.create>[0]["workspaceId"],
					sourceCwd,
					label: options.label === undefined || options.label.length === 0 ? sessionId : options.label,
					canonicalTarget: join(options.layout.worktrees, sessionId),
					...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
					...(options.branch === undefined ? {} : { branch: options.branch }),
				});
				if (!created.ok) throw new Error(`session worktree create failed: ${created.error.code}: ${created.error.message}`);
				const acquired = await leases.acquire(created.value.workspaceId, fence.runtimeId);
				if (!acquired.ok) throw new Error(`session worktree lease failed: ${acquired.error.code}: ${acquired.error.message}`);
				const status = await options.workspace.git.inspectWorktree(created.value.worktreeLocator);
				if (!status.ok) {
					await leases.release(acquired.value).catch(() => undefined);
					throw new Error(`session worktree observation failed: ${status.error.code}: ${status.error.message}`);
				}
				const binding = createPersistedWorkspaceBinding({
					record: created.value,
					lease: acquired.value,
					effectiveCwd: resolve(created.value.worktreeLocator, created.value.effectiveSubdir === "." ? "" : created.value.effectiveSubdir),
					headCommit: status.value.headCommit,
					platform: options.workspace.platform,
				});
				if (!binding.ok) {
					await leases.release(acquired.value).catch(() => undefined);
					throw new Error(`session worktree binding failed: ${binding.error.code}: ${binding.error.message}`);
				}
				persistBinding(store, fence, binding.value, "workspace.bound");
				return leasedWorkspaceHandle(binding.value, leases);
			}
			if (options.mode === "disabled") {
				throw new Error("session is bound to a worktree; --no-worktree cannot bypass the persisted binding");
			}
			return resumeBinding(options, store, fence, session.worktreeLocator, leases);
		},
	};
}

async function resumeBinding(
	options: SessionWorkspaceFactoryOptions,
	store: SessionStore,
	fence: OwnerFence,
	serialized: string,
	leases: WorktreeLeaseManager,
): Promise<SessionWorkspaceHandle> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(serialized) as unknown;
	} catch {
		throw new Error("session worktree locator requires migration or repair");
	}
	const checked = validatePersistedWorkspaceBinding(decoded);
	if (!checked.ok) throw new Error(`session worktree locator rejected: ${checked.error.code}: ${checked.error.message}`);
	const stored = checked.value;
	const record = await options.registry.get(stored.worktreeId);
	if (!record.ok) throw new Error(`session worktree record unavailable: ${record.error.code}: ${record.error.message}`);
	if (record.value.sessionId !== fence.sessionId || record.value.worktreeLocator !== stored.worktreePath) {
		throw new Error("session worktree record identity drift");
	}
	const current = await options.registry.lease(stored.binding.workspaceId);
	if (!current.ok) throw new Error(`session worktree lease unavailable: ${current.error.code}: ${current.error.message}`);
	let lease: WorktreeLeaseRecord;
	if (current.value?.state === "active" && !leaseExpired(current.value)) {
		if (current.value.ownerRuntimeId !== fence.runtimeId) {
			throw new Error("session worktree lease is bound to another live Runtime");
		}
		lease = current.value;
	} else {
		const acquired = await leases.acquire(stored.binding.workspaceId, fence.runtimeId);
		if (!acquired.ok) throw new Error(`session worktree lease reacquire failed: ${acquired.error.code}: ${acquired.error.message}`);
		lease = acquired.value;
	}
	const rebound = createPersistedWorkspaceBinding({
		record: record.value,
		lease,
		effectiveCwd: stored.effectiveCwd,
		headCommit: stored.headCommit,
		platform: options.workspace.platform,
	});
	if (!rebound.ok) {
		await leases.release(lease).catch(() => undefined);
		throw new Error(`session worktree rebound locator rejected: ${rebound.error.code}: ${rebound.error.message}`);
	}
	const resumed = await resumeWorktreeLocator(
		{
			path: options.workspace.path,
			git: options.workspace.git,
			checkLease: async () => {
				const observed = await options.registry.lease(rebound.value.binding.workspaceId);
				if (!observed.ok || observed.value === undefined || !sameLease(observed.value, rebound.value.lease) || observed.value.state !== "active" || leaseExpired(observed.value)) {
					return "persisted workspace lease is stale or fenced";
				}
				return undefined;
			},
		},
		{
			record: rebound.value.worktreeLocator,
			repo: rebound.value.sourceRepositoryPath,
			expectedBaseCommit: rebound.value.baseCommit,
			effectiveSubdir: rebound.value.sourceSubdir,
		},
	);
	if (!resumed.ok) {
		await leases.release(lease).catch(() => undefined);
		throw new Error(`session worktree cold resume failed: ${resumed.error.code}: ${resumed.error.message}`);
	}
	const observation = validateWorkspaceBindingObservation(rebound.value, {
		workspaceId: rebound.value.binding.workspaceId,
		repositoryId: rebound.value.binding.repositoryId,
		worktreeId: rebound.value.worktreeId,
		sourceSubdir: rebound.value.sourceSubdir,
		worktreePath: rebound.value.worktreePath,
		effectiveCwd: resumed.effectiveCwd,
		baseCommit: rebound.value.baseCommit,
		headCommit: resumed.headCommit,
	});
	if (!observation.ok) {
		await leases.release(lease).catch(() => undefined);
		throw new Error(`session worktree observation drift: ${observation.error.code}: ${observation.error.message}`);
	}
	persistBinding(store, fence, observation.value, "workspace.validation_recorded");
	return leasedWorkspaceHandle(observation.value, leases);
}

function persistBinding(
	store: SessionStore,
	fence: OwnerFence,
	binding: PersistedWorkspaceBinding,
	eventType: "workspace.bound" | "workspace.validation_recorded",
): void {
	store.putWorktreeLocator(fence, {
		locatorJson: JSON.stringify(binding),
		repositoryId: binding.binding.repositoryId,
		eventType,
		payload: {
			binding: binding.binding,
			bindingDigest: binding.bindingDigest.digest,
		},
	});
}

function sourceWorkspaceHandle(effectiveCwd: string): SessionWorkspaceHandle {
	return { effectiveCwd, release: async () => undefined };
}

function leasedWorkspaceHandle(binding: PersistedWorkspaceBinding, leases: WorktreeLeaseManager): SessionWorkspaceHandle {
	let released = false;
	return {
		effectiveCwd: binding.effectiveCwd,
		release: async () => {
			if (released) return;
			released = true;
			const result = await leases.release(binding.lease);
			if (!result.ok && result.error.code !== "lease_stale") {
				throw new Error(`session worktree lease release failed: ${result.error.code}: ${result.error.message}`);
			}
		},
	};
}

function sameLease(left: WorktreeLeaseRecord, right: PersistedWorkspaceBinding["lease"]): boolean {
	return left.workspaceId === right.workspaceId && left.ownerRuntimeId === right.ownerRuntimeId &&
		left.leaseRevision === right.leaseRevision && left.fencingTokenDigest.digest === right.fencingTokenDigest.digest;
}

function leaseExpired(lease: WorktreeLeaseRecord): boolean {
	return lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= Date.now();
}
