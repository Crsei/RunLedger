/** Worktree lease 的 acquire/release 与 fencing 适配；状态唯一保存在 WorktreeRegistry。 */

import type {
	RuntimeInstanceId,
	WorkspaceId,
	WorkspaceLeaseRef,
} from "../runtime/contracts/public.ts";
import { WorktreeRegistry } from "./registry.ts";
import type { WorktreeLeaseRecord, WorktreeResult } from "./types.ts";

export interface WorktreeLeaseManagerOptions {
	readonly clock?: () => Date;
	readonly defaultTtlMs?: number;
}

function failure<T>(code: "invalid_request" | "lease_stale", message: string): WorktreeResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

export class WorktreeLeaseManager {
	readonly #registry: WorktreeRegistry;
	readonly #clock: () => Date;
	readonly #defaultTtlMs: number;

	public constructor(registry: WorktreeRegistry, options: WorktreeLeaseManagerOptions = {}) {
		this.#registry = registry;
		this.#clock = options.clock ?? (() => new Date());
		this.#defaultTtlMs = validTtl(options.defaultTtlMs) ? options.defaultTtlMs : 30_000;
	}

	public async acquire(
		workspaceId: WorkspaceId,
		ownerRuntimeId: RuntimeInstanceId,
		ttlMs = this.#defaultTtlMs,
	): Promise<WorktreeResult<WorktreeLeaseRecord>> {
		if (!validTtl(ttlMs)) return failure("invalid_request", "worktree lease ttl must be a positive safe integer");
		const now = this.#clock();
		const nowMs = now.getTime();
		if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER - ttlMs) return failure("invalid_request", "worktree lease clock is invalid");
		const acquired = await this.#registry.acquireLease({
			workspaceId,
			ownerRuntimeId,
			now: now.toISOString(),
			expiresAt: new Date(nowMs + ttlMs).toISOString(),
		});
		return acquired.ok ? { ok: true, value: acquired.value.lease } : acquired;
	}

	public async release(lease: WorkspaceLeaseRef): Promise<WorktreeResult<WorktreeLeaseRecord>> {
		const expiresAt = lease.expiresAt === undefined ? undefined : Date.parse(lease.expiresAt);
		if (expiresAt !== undefined && expiresAt <= this.#clock().getTime()) return failure("lease_stale", "worktree lease has expired");
		return this.#registry.releaseLease(lease);
	}
}

function validTtl(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
