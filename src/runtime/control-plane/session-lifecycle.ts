/** idle unload、resume 与 subscription/approval 竞态的单 session 串行边界。 */

import { randomUUID } from "node:crypto";
import type { ApprovalId, SessionId } from "../protocol/v3/ids.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "./errors.ts";

export type IdleSessionLifecycleState = "active" | "unloading" | "unloaded" | "paused" | "stopped";

export interface IdleSessionRuntimeSnapshot {
	activeWork: boolean;
	pendingApprovalIds: readonly ApprovalId[];
}

export interface IdleSessionUnloadReceipt {
	state: "unloaded" | "stopped";
	durable: boolean;
}

/**
 * 实现必须让 closeMutationGate 返回后不再创建新的 turn/tool/approval request；
 * cancelPendingApprovals 只有在取消结果已持久化后才能成功。
 */
export interface IdleSessionRuntimePort {
	inspect(sessionId: SessionId): Promise<ControlPlaneResult<IdleSessionRuntimeSnapshot>>;
	closeMutationGate(sessionId: SessionId): Promise<ControlPlaneResult<void>>;
	openMutationGate(sessionId: SessionId): Promise<ControlPlaneResult<void>>;
	cancelPendingApprovals(
		sessionId: SessionId,
		approvalIds: readonly ApprovalId[],
	): Promise<ControlPlaneResult<{ cancelledApprovalIds: readonly ApprovalId[] }>>;
	unload(sessionId: SessionId, signal: AbortSignal): Promise<ControlPlaneResult<IdleSessionUnloadReceipt>>;
	resume(sessionId: SessionId): Promise<ControlPlaneResult<void>>;
}

export interface SessionSubscriptionLease {
	leaseId: string;
	sessionId: SessionId;
	release(): Promise<ControlPlaneResult<void>>;
}

export interface SessionSubscriptionLifecyclePort {
	acquireSubscription(sessionId: SessionId): Promise<ControlPlaneResult<SessionSubscriptionLease>>;
}

export type IdleUnloadOutcome =
	| { status: "unloaded" | "stopped"; cancelledApprovals: number }
	| { status: "skipped"; reason: "subscribed" | "active_work" | "already_unloaded" | "stopped" };

function thrownFailure<T>(operation: string, error: unknown): ControlPlaneResult<T> {
	return controlPlaneFailure("adapter_unavailable", `${operation} threw`, true, {
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
}

function validateSnapshot(snapshot: IdleSessionRuntimeSnapshot): ControlPlaneResult<IdleSessionRuntimeSnapshot> {
	if (typeof snapshot.activeWork !== "boolean" || !Array.isArray(snapshot.pendingApprovalIds)) {
		return controlPlaneFailure("adapter_contract_violation", "idle lifecycle snapshot is invalid");
	}
	const seen = new Set<string>();
	for (const approvalId of snapshot.pendingApprovalIds) {
		if (!isRuntimeId(approvalId, "approval") || seen.has(approvalId)) {
			return controlPlaneFailure("adapter_contract_violation", "idle lifecycle approval correlation is invalid");
		}
		seen.add(approvalId);
	}
	return { ok: true, value: snapshot };
}

/**
 * acquireSubscription、unloadIfIdle 与 resume 共用同一 session mutex。unload 先关闭
 * mutation gate，再重新检查 activity，并持久取消 pending approvals 后才释放 runtime。
 */
export class IdleSessionLifecycleCoordinator implements SessionSubscriptionLifecyclePort {
	readonly #runtime: IdleSessionRuntimePort;
	readonly #states = new Map<SessionId, IdleSessionLifecycleState>();
	readonly #subscriptions = new Map<SessionId, Set<string>>();
	readonly #serial = new Map<SessionId, Promise<void>>();
	readonly #unsettledUnloads = new Map<SessionId, Promise<ControlPlaneResult<IdleSessionUnloadReceipt>>>();

	public constructor(runtime: IdleSessionRuntimePort) {
		this.#runtime = runtime;
	}

	public state(sessionId: SessionId): IdleSessionLifecycleState {
		return this.#states.get(sessionId) ?? "active";
	}

	public subscriberCount(sessionId: SessionId): number {
		return this.#subscriptions.get(sessionId)?.size ?? 0;
	}

	#exclusive<T>(sessionId: SessionId, operation: () => Promise<ControlPlaneResult<T>>): Promise<ControlPlaneResult<T>> {
		const previous = this.#serial.get(sessionId) ?? Promise.resolve();
		const result = previous.then(async () => {
			try {
				return await operation();
			} catch (error) {
				return thrownFailure<T>("idle session lifecycle operation", error);
			}
		});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#serial.set(sessionId, settled);
		void settled.finally(() => {
			if (this.#serial.get(sessionId) === settled) this.#serial.delete(sessionId);
		});
		return result;
	}

	public acquireSubscription(sessionId: SessionId): Promise<ControlPlaneResult<SessionSubscriptionLease>> {
		return this.#exclusive(sessionId, async () => {
			const state = this.state(sessionId);
			if (state !== "active") {
				return controlPlaneFailure(
					state === "unloading" ? "session_replacing" : "recovery_required",
					`session cannot accept a subscription while ${state}`,
					state === "unloading",
					{ lifecycleState: state },
				);
			}
			const leaseId = randomUUID();
			let leases = this.#subscriptions.get(sessionId);
			if (!leases) {
				leases = new Set();
				this.#subscriptions.set(sessionId, leases);
			}
			leases.add(leaseId);
			let released = false;
			return {
				ok: true,
				value: {
					leaseId,
					sessionId,
					release: async () => {
						if (released) return { ok: true, value: undefined };
						const result = await this.#releaseSubscription(sessionId, leaseId);
						if (result.ok) released = true;
						return result;
					},
				},
			};
		});
	}

	#releaseSubscription(sessionId: SessionId, leaseId: string): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(sessionId, async () => {
			const leases = this.#subscriptions.get(sessionId);
			if (!leases?.has(leaseId)) return { ok: true, value: undefined };
			leases.delete(leaseId);
			if (leases.size === 0) this.#subscriptions.delete(sessionId);
			return { ok: true, value: undefined };
		});
	}

	async #inspect(sessionId: SessionId): Promise<ControlPlaneResult<IdleSessionRuntimeSnapshot>> {
		let inspected: ControlPlaneResult<IdleSessionRuntimeSnapshot>;
		try {
			inspected = await this.#runtime.inspect(sessionId);
		} catch (error) {
			return thrownFailure("idle session inspection", error);
		}
		return inspected.ok ? validateSnapshot(inspected.value) : inspected;
	}

	async #openGate(sessionId: SessionId): Promise<ControlPlaneResult<void>> {
		try {
			return await this.#runtime.openMutationGate(sessionId);
		} catch (error) {
			return thrownFailure("idle session mutation gate reopen", error);
		}
	}

	public unloadIfIdle(sessionId: SessionId, timeoutMs = 30_000): Promise<ControlPlaneResult<IdleUnloadOutcome>> {
		return this.#exclusive(sessionId, async () => {
			const state = this.state(sessionId);
			if (state === "unloaded") return { ok: true, value: { status: "skipped", reason: "already_unloaded" } };
			if (state === "stopped") return { ok: true, value: { status: "skipped", reason: "stopped" } };
			if (state !== "active") {
				return controlPlaneFailure("recovery_required", `session lifecycle is ${state}`, false, { lifecycleState: state });
			}
			if (this.subscriberCount(sessionId) > 0) {
				return { ok: true, value: { status: "skipped", reason: "subscribed" } };
			}
			const beforeGate = await this.#inspect(sessionId);
			if (!beforeGate.ok) return beforeGate;
			if (beforeGate.value.activeWork) {
				return { ok: true, value: { status: "skipped", reason: "active_work" } };
			}

			let gateClosed: ControlPlaneResult<void>;
			try {
				gateClosed = await this.#runtime.closeMutationGate(sessionId);
			} catch (error) {
				return thrownFailure("idle session mutation gate close", error);
			}
			if (!gateClosed.ok) return gateClosed;
			this.#states.set(sessionId, "unloading");

			const afterGate = await this.#inspect(sessionId);
			if (!afterGate.ok) {
				this.#states.set(sessionId, "paused");
				return afterGate;
			}
			if (afterGate.value.activeWork) {
				const reopened = await this.#openGate(sessionId);
				this.#states.set(sessionId, reopened.ok ? "active" : "paused");
				return reopened.ok
					? { ok: true, value: { status: "skipped", reason: "active_work" } }
					: reopened;
			}

			const pending = [...afterGate.value.pendingApprovalIds];
			if (pending.length > 0) {
				let cancelled: ControlPlaneResult<{ cancelledApprovalIds: readonly ApprovalId[] }>;
				try {
					cancelled = await this.#runtime.cancelPendingApprovals(sessionId, pending);
				} catch (error) {
					cancelled = thrownFailure("pending approval cancellation", error);
				}
				if (!cancelled.ok) {
					this.#states.set(sessionId, "paused");
					return cancelled;
				}
				const actual = new Set(cancelled.value.cancelledApprovalIds);
				if (actual.size !== pending.length || pending.some((approvalId) => !actual.has(approvalId))) {
					this.#states.set(sessionId, "paused");
					return controlPlaneFailure("adapter_contract_violation", "pending approval cancellation was not fully durable");
				}
			}

			const boundedTimeoutMs = Number.isFinite(timeoutMs)
				? Math.max(1, Math.min(300_000, Math.trunc(timeoutMs)))
				: 30_000;
			const controller = new AbortController();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const unload = this.#runtime.unload(sessionId, controller.signal).catch((error: unknown) =>
				thrownFailure<IdleSessionUnloadReceipt>("idle session unload", error));
			this.#unsettledUnloads.set(sessionId, unload);
			void unload.finally(() => {
				if (this.#unsettledUnloads.get(sessionId) === unload) this.#unsettledUnloads.delete(sessionId);
			});
			const timedOut = new Promise<ControlPlaneResult<IdleSessionUnloadReceipt>>((resolve) => {
				timeout = setTimeout(() => {
					controller.abort("idle_unload_timeout");
					resolve(controlPlaneFailure("drain_timeout", "idle session unload exceeded its deadline", false, {
						timeoutMs: boundedTimeoutMs,
					}, "uncertain"));
				}, boundedTimeoutMs);
			});
			const unloaded = await Promise.race([unload, timedOut]);
			if (timeout) clearTimeout(timeout);
			if (!unloaded.ok) {
				this.#states.set(sessionId, "paused");
				return unloaded;
			}
			if (!unloaded.value.durable) {
				this.#states.set(sessionId, "paused");
				return controlPlaneFailure("adapter_contract_violation", "idle session unload did not return a durable receipt");
			}
			this.#states.set(sessionId, unloaded.value.state);
			return { ok: true, value: { status: unloaded.value.state, cancelledApprovals: pending.length } };
		});
	}

	public resume(sessionId: SessionId): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(sessionId, async () => {
			if (this.#unsettledUnloads.has(sessionId)) {
				return controlPlaneFailure(
					"recovery_required",
					"previous idle unload has not reached a terminal result",
					false,
					{ lifecycleState: this.state(sessionId) },
				);
			}
			const state = this.state(sessionId);
			if (state === "active") return { ok: true, value: undefined };
			if (state === "stopped") {
				return controlPlaneFailure("recovery_required", "stopped session cannot be resumed automatically", false, {
					lifecycleState: state,
				});
			}
			if (state === "unloading") {
				return controlPlaneFailure("session_replacing", "session unload is still in progress", true);
			}
			let resumed: ControlPlaneResult<void>;
			try {
				resumed = await this.#runtime.resume(sessionId);
			} catch (error) {
				resumed = thrownFailure("idle session resume", error);
			}
			if (!resumed.ok) {
				this.#states.set(sessionId, "paused");
				return resumed;
			}
			const reopened = await this.#openGate(sessionId);
			this.#states.set(sessionId, reopened.ok ? "active" : "paused");
			return reopened;
		});
	}
}
