/**
 * R5:recovery barrier(06 §7.3)。
 *
 * - crash takeover 后无条件进入 RECOVERY_REQUIRED:barrier open,只允许
 *   attach/subscribe/只读 query/只读检查/best-effort terminate/recovery decision;
 * - barrier 内禁止:normal prompt admission、自动 completion follow-up、
 *   write/edit/bash/process spawn/dependency install/Git mutation/deploy/
 *   MCP/network mutation、把普通 side-effect 降级为 allow;
 * - 收口路径:recovery.verified_clean(无 unresolved attempt)、recovery.verify
 *   (核验既往 attempt + receipt 收口)、显式 recovery.resume_despite_uncertainty
 *   (人工决策,必须记录 principal/reason/origin/settled generation + evidence);
 * - 所有 decision 都走 owner-fenced durable event + receipt,不依赖 UI 隐藏;
 * - spawnCount 是测试证据:barrier 未收口前所有新副作用 spawnCount 必须为 0。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { CommandAttemptReceipt, CommandEffectClass, OwnerFence } from "../session-owner/types.ts";
import { createRuntimeId, type AttemptId } from "../protocol/ids.ts";
import type { PrincipalId } from "../protocol/ids.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import { canonicalDigest } from "../protocol/canonical-json.ts";

export type BarrierState = "closed" | "open";

/** §7.3 barrier 内允许的只读检查 effect class。 */
export const BARRIER_SAFE_READONLY: readonly CommandEffectClass[] = ["readonly"] as const;

/** side-effect effect class:barrier open 时一律拒绝。 */
export const BARRIER_SIDE_EFFECT_CLASSES: readonly CommandEffectClass[] = ["workspace_mutation", "process_spawn", "external_mutation"] as const;

export const UNRESOLVED_ATTEMPT_OUTCOMES = ["started", "interrupted", "uncertain"] as const;

export type RecoveryDecision =
	| { readonly kind: "verify_clean"; readonly evidenceDigest: RuntimeDigest }
	| { readonly kind: "verify"; readonly attemptId: AttemptId; readonly outcome: "settled" | "verified_clean"; readonly evidenceDigest?: RuntimeDigest }
	| { readonly kind: "abort"; readonly reasonCode: string }
	| { readonly kind: "resume_despite_uncertainty"; readonly principalId: PrincipalId; readonly reasonCode: string; readonly originGeneration: number; readonly settledGeneration: number; readonly evidenceDigest: RuntimeDigest };

export type RecoveryDecisionResult =
	| { readonly ok: true; readonly state: BarrierState; readonly unresolvedRemaining: number }
	| { readonly ok: false; readonly code: string };

export interface RecoveryBarrierOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
}

/**
 * §7.3 recovery barrier:admission 由 Runtime admission 与 ExecutionGateway
 * final leaf 双重执行(本模块是 durable decision 与 evidence 的唯一 owner)。
 */
export class RecoveryBarrier {
	private readonly store: SessionStore;
	private readonly fence: OwnerFence;
	private state: BarrierState;
	private spawnCount = 0;

	public constructor(options: RecoveryBarrierOptions, initialState: BarrierState = "closed") {
		this.store = options.store;
		this.fence = options.fence;
		this.state = initialState;
	}

	public get isOpen(): boolean {
		return this.state === "open";
	}

	public get currentState(): BarrierState {
		return this.state;
	}

	/** 测试证据:本 owner generation 已 admitted 的 side-effect 数。 */
	public get sideEffectSpawnCount(): number {
		return this.spawnCount;
	}

	/**
	 * §7.3 admission:side-effect mutation 在 barrier open 时一律拒绝
	 * (typed recovery_barrier_active);readonly 检查允许。调用方必须是
	 * Runtime command admission 与 ExecutionGateway final leaf 两处。
	 */
	public admitMutation(effectClass: CommandEffectClass): { readonly ok: true } | { readonly ok: false; readonly code: "recovery_barrier_active" } {
		if (this.state === "open" && (BARRIER_SIDE_EFFECT_CLASSES as readonly string[]).includes(effectClass)) {
			return { ok: false, code: "recovery_barrier_active" };
		}
		if ((BARRIER_SIDE_EFFECT_CLASSES as readonly string[]).includes(effectClass)) {
			this.spawnCount += 1;
		}
		return { ok: true };
	}

	/** barrier 内的 prompt/自动 completion 一律拒绝(§7.3 禁止项)。 */
	public admitPrompt(): { readonly ok: true } | { readonly ok: false; readonly code: "recovery_barrier_active" } {
		if (this.state === "open") return { ok: false, code: "recovery_barrier_active" };
		return { ok: true };
	}

	/** §7.3 未收口的 unresolved attempt 列表(projection,不猜 outcome)。 */
	public unresolvedAttempts(): readonly CommandAttemptReceipt[] {
		// 每个 attempt 取最新 receipt 判断;旧 receipt 只 append 不原地改写。
		const latestByAttempt = new Map<string, CommandAttemptReceipt>();
		for (const receipt of this.store.listAllAttemptReceipts(this.fence.sessionId)) {
			// Store 已按 created_at_ms,receipt_id 排序；最后一条是 projection 真值。
			latestByAttempt.set(receipt.attemptId, receipt);
		}
		return [...latestByAttempt.values()].filter(
			(receipt) => (UNRESOLVED_ATTEMPT_OUTCOMES as readonly string[]).includes(receipt.outcome) && receipt.settledGeneration === undefined,
		);
	}

	public hasUnresolvedAttempts(): boolean {
		return this.unresolvedAttempts().length > 0;
	}

	/** §7.3 评估:无 unresolved attempt 时自动形成 recovery.verified_clean 收口。 */
	public assess(): RecoveryDecisionResult {
		if (this.state === "closed") return { ok: true, state: "closed", unresolvedRemaining: 0 };
		if (!this.hasUnresolvedAttempts()) {
			this.closeBarrier("recovery.verified_clean", { evidenceDigest: canonicalRuntimeDigest({ assessment: "no-unresolved-attempts" }) });
			return { ok: true, state: "closed", unresolvedRemaining: 0 };
		}
		return { ok: true, state: "open", unresolvedRemaining: this.unresolvedAttempts().length };
	}

	/** §7.3 执行一个 recovery decision(全部 owner-fenced durable)。 */
	public decide(decision: RecoveryDecision): RecoveryDecisionResult {
		if (this.state !== "open") {
			return { ok: false, code: "recovery_not_open" };
		}
		switch (decision.kind) {
			case "verify_clean": {
				this.closeBarrier("recovery.verified_clean", { evidenceDigest: decision.evidenceDigest.digest });
				return { ok: true, state: "closed", unresolvedRemaining: 0 };
			}
			case "verify": {
				const receipt = this.store
					.listAllAttemptReceipts(this.fence.sessionId)
					.find((candidate) => candidate.attemptId === decision.attemptId);
				if (receipt === undefined) return { ok: false, code: "attempt_not_found" };
				// 收口:追加 verified/settled receipt,origin 不改写,settled = 当前 generation。
				this.store.appendAttemptReceipt(this.fence, {
					receiptId: createRuntimeId("receipt", `verify-${decision.attemptId.slice(-20)}-${Date.now().toString(36)}`),
					sessionId: this.fence.sessionId,
					commandId: receipt.commandId,
					attemptId: decision.attemptId,
					originGeneration: receipt.originGeneration,
					settledGeneration: this.fence.generation,
					effectClass: receipt.effectClass,
					outcome: "verified",
					evidenceDigest: decision.evidenceDigest ?? canonicalRuntimeDigest({ verify: decision.attemptId }),
					createdAtMs: Date.now(),
				});
				this.appendRecoveryEvent("recovery.verify", {
					attemptId: decision.attemptId,
					outcome: decision.outcome,
					settledGeneration: this.fence.generation,
					evidenceDigest: decision.evidenceDigest?.digest,
				});
				const remaining = this.unresolvedAttempts().length;
				if (remaining === 0) this.state = "closed";
				return { ok: true, state: this.state, unresolvedRemaining: remaining };
			}
			case "abort": {
				this.appendRecoveryEvent("recovery.abort", { reasonCode: decision.reasonCode });
				return { ok: true, state: "open", unresolvedRemaining: this.unresolvedAttempts().length };
			}
			case "resume_despite_uncertainty": {
				const unresolved = this.unresolvedAttempts();
				for (const receipt of unresolved) {
					// 保留 outcome=uncertain 的真实性，只以 settledGeneration 表示用户
					// 已明确接受该不确定性；后续 replay 不会再次视为 unresolved。
					this.store.appendAttemptReceipt(this.fence, {
						receiptId: createRuntimeId("receipt", `accepted-${receipt.attemptId.slice(-20)}-${Date.now().toString(36)}`),
						sessionId: this.fence.sessionId,
						commandId: receipt.commandId,
						attemptId: receipt.attemptId,
						originGeneration: receipt.originGeneration,
						settledGeneration: this.fence.generation,
						effectClass: receipt.effectClass,
						outcome: "uncertain",
						evidenceDigest: decision.evidenceDigest,
						createdAtMs: Date.now(),
					});
					this.appendRecoveryEvent("recovery.resume_despite_uncertainty", {
						principalId: decision.principalId,
						reasonCode: decision.reasonCode,
						originGeneration: receipt.originGeneration,
						settledGeneration: this.fence.generation,
						evidenceDigest: decision.evidenceDigest.digest,
					});
				}
				this.state = "closed";
				return { ok: true, state: "closed", unresolvedRemaining: 0 };
			}
		}
	}

	private closeBarrier(eventType: "recovery.verified_clean", payload: Record<string, unknown>): void {
		this.appendRecoveryEvent(eventType, payload);
		this.state = "closed";
	}

	/** R0 契约 payload 需要 eventId/sessionId/runtimeId/generation(additionalProperties: false)。 */
	private appendRecoveryEvent(eventType: string, payload: Record<string, unknown>): void {
		const eventId = createRuntimeId("event", `recovery-${eventType.replaceAll(".", "-")}-${this.fence.generation}-${Date.now().toString(36)}`);
		const headRow = this.store.database().querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [this.fence.sessionId]);
		const headSequence = Number(headRow?.head_sequence ?? 0);
		const previousRow = this.store.database().querySingle(
			"SELECT current_event_hash FROM session_events WHERE session_id = ? AND sequence = ?",
			[this.fence.sessionId, headSequence],
		);
		this.store.appendEvent(this.fence, {
			eventId,
			ownerGeneration: this.fence.generation,
			eventType,
			payloadJson: JSON.stringify({
				...payload,
				eventId,
				sessionId: this.fence.sessionId,
				runtimeId: this.fence.runtimeId,
				generation: this.fence.generation,
			}),
			createdAtMs: Date.now(),
			expectedPreviousEventHash: previousRow === undefined ? null : String(previousRow.current_event_hash),
		});
	}
}

function canonicalRuntimeDigest(value: unknown): RuntimeDigest {
	return { algorithm: "sha256", digest: canonicalDigest(value) as RuntimeDigest["digest"] };
}
