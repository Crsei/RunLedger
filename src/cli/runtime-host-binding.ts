/** Resident Host 启动时唯一的 persisted workspace binding 恢复边界。 */

import type { RuntimeHostScope } from "../runtime/host/types.ts";
import {
	validatePersistedWorkspaceBinding,
	validateWorkspaceBindingObservation,
	type JsonWorkspaceBindingStore,
	type PersistedWorkspaceBinding,
} from "../worktree/persisted-binding.ts";

export interface RestoreHostWorkspaceBindingOptions {
	readonly store: JsonWorkspaceBindingStore;
	readonly scope: Pick<RuntimeHostScope, "workspaceId" | "repositoryId">;
	readonly cwd: string;
}

/**
 * Reads only the current exact binding format and verifies it against the
 * authenticated Host scope before Security, Session, or Process composition.
 * An empty store is the explicit source-workspace case; any present but stale
 * or mismatched binding fails closed.
 */
export async function restoreHostWorkspaceBinding(
	options: RestoreHostWorkspaceBindingOptions,
): Promise<PersistedWorkspaceBinding | undefined> {
	const stored = await options.store.read();
	if (stored === undefined) return undefined;
	const exact = validatePersistedWorkspaceBinding(stored);
	if (!exact.ok) throw new Error(`workspace binding invalid: ${exact.error.message}`);
	if (exact.value.binding.workspaceId !== options.scope.workspaceId || exact.value.binding.repositoryId !== options.scope.repositoryId) {
		throw new Error("workspace binding identity mismatch with Host scope");
	}
	const observed = validateWorkspaceBindingObservation(exact.value, {
		workspaceId: options.scope.workspaceId,
		repositoryId: options.scope.repositoryId,
		worktreeId: exact.value.worktreeId,
		sourceSubdir: exact.value.sourceSubdir,
		worktreePath: exact.value.worktreePath,
		effectiveCwd: options.cwd,
		baseCommit: exact.value.baseCommit,
		...(exact.value.headCommit === undefined ? {} : { headCommit: exact.value.headCommit }),
	});
	if (!observed.ok) throw new Error(`workspace binding ${observed.error.code}: ${observed.error.message}`);
	return observed.value;
}
