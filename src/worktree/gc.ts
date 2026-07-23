/** TTL GC 先 dry-run/report，只清理 fresh preview 可安全删除的 retained worktree。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { WorktreeManager } from "./manager.ts";
import type { WorktreeGcCandidate, WorktreeResult } from "./types.ts";

export interface WorktreeGcReport {
	dryRun: boolean;
	evaluatedAt: string;
	cutoffAt: string;
	candidates: readonly WorktreeGcCandidate[];
	removedWorkspaceIds: readonly WorktreeGcCandidate["workspaceId"][];
	reportDigest: string;
}

export class WorktreeGarbageCollector {
	readonly #manager: WorktreeManager;
	readonly #ttlMs: number;

	public constructor(manager: WorktreeManager, ttlMs: number) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("worktree GC ttl must be a positive integer");
		this.#manager = manager;
		this.#ttlMs = ttlMs;
	}

	public async run(at: Date, dryRun: boolean): Promise<WorktreeResult<WorktreeGcReport>> {
		const records = await this.#manager.list();
		if (!records.ok) return records;
		const cutoff = new Date(at.getTime() - this.#ttlMs);
		const candidates: WorktreeGcCandidate[] = [];
		const removedWorkspaceIds: WorktreeGcCandidate["workspaceId"][] = [];
		for (const record of records.value) {
			if (record.bindingKind === "source" || record.state !== "retained" || Date.parse(record.lastAccessedAt) > cutoff.getTime()) continue;
			const request = {
				authorityId: record.authorityId,
				tenantId: record.tenantId,
				principalId: record.principalId,
				workspaceId: record.workspaceId,
				dryRun: true,
				force: false,
				expectedLeaseRevision: record.leaseRevision,
				requestId: createRuntimeId("command", `gc-preview-${canonicalDigest({ workspaceId: record.workspaceId, at: at.toISOString() }).slice(0, 48)}`),
				...(record.lastCheckpoint ? { checkpoint: record.lastCheckpoint } : {}),
			};
			const preview = await this.#manager.removePreview(request);
			if (!preview.ok) {
				candidates.push({
					workspaceId: record.workspaceId, worktreePath: record.worktreePath, state: record.state,
					lastAccessedAt: record.lastAccessedAt,
					dirty: false, unpublished: false, active: false, reason: preview.error.code,
				});
				continue;
			}
			candidates.push({
				workspaceId: record.workspaceId, worktreePath: record.worktreePath, state: record.state,
				lastAccessedAt: record.lastAccessedAt,
				dirty: preview.value.dirty, unpublished: preview.value.unpublished, active: preview.value.active,
				reason: preview.value.removable ? "ttl-expired" : preview.value.reasonCodes.join(","),
			});
			if (dryRun || !preview.value.removable) continue;
			const removed = await this.#manager.remove({ ...request, dryRun: false });
			if (removed.ok) removedWorkspaceIds.push(record.workspaceId);
		}
		const body = {
			dryRun, evaluatedAt: at.toISOString(), cutoffAt: cutoff.toISOString(), candidates, removedWorkspaceIds,
		};
		return { ok: true, value: { ...body, reportDigest: canonicalDigest(body) } };
	}
}
