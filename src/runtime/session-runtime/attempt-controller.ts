/**
 * S5 拆分:attempt/receipt 生命周期与 recovery assess/decide。
 *
 * begin 先经 barrier admission 再 owner-fenced 记录 intent + started
 * receipt;settle 只 append 不猜 outcome,interrupted/uncertain 保留
 * unresolved;recovery decision 只投影 barrier 结果并发布状态。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { createRuntimeId, type AttemptId, type SessionId } from "../protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { CommandAttemptOutcome, CommandEffectClass, OwnerFence } from "../session-owner/types.ts";
import type { SessionControllerEvent } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier, RecoveryDecision } from "./recovery-barrier.ts";
import type { LateBoundAttemptPort, StableAttemptRequest, AttemptPortBeginResult } from "./attempt-gateway.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";

export interface SessionAttemptPort {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly sessionId: SessionId;
	readonly domain: SessionDomainPort | undefined;
	readonly barrier: RecoveryBarrier;
	readonly onFenced: () => void;
	readonly currentState: () => SessionRuntimeState;
	readonly setState: (state: SessionRuntimeState) => void;
	readonly invalidateIdleRecap: () => void;
	readonly emit: (event: SessionControllerEvent) => void;
	readonly ownerPublishRunning: () => void;
}

export class SessionAttemptController {
	private readonly port: SessionAttemptPort;
	private attemptCounter = 0;

	public constructor(port: SessionAttemptPort) {
		this.port = port;
	}

	public unresolvedAttemptsCount(): number {
		return this.port.barrier.unresolvedAttempts().length;
	}

	public listUnresolvedAttempts(): ReturnType<RecoveryBarrier["unresolvedAttempts"]> {
		return this.port.barrier.unresolvedAttempts();
	}

	// ── attempt / receipt 生命周期(领域执行由 R6 composition 注入)──────────

	/**
	 * §7.3 开始一次 attempt:先经 barrier admission(只读放行、side-effect 需
	 * barrier closed),再 owner-fenced 记录 command intent + started receipt。
	 */
	public beginAttempt(
		effectClassOrRequest: CommandEffectClass | StableAttemptRequest,
		requestDigest?: RuntimeDigest,
	): AttemptPortBeginResult {
		const stableRequest = typeof effectClassOrRequest === "string" ? undefined : effectClassOrRequest;
		const effectClass: CommandEffectClass = typeof effectClassOrRequest === "string" ? effectClassOrRequest : effectClassOrRequest.effectClass;
		const admission = this.port.barrier.admitMutation(effectClass);
		if (!admission.ok) return { error: admission.code };
		const attemptId = stableRequest?.attemptId ?? createRuntimeId("attempt", `a${++this.attemptCounter}-${Date.now().toString(36)}`);
		const commandId = stableRequest?.commandId ?? createRuntimeId("command", `c${this.attemptCounter}-${Date.now().toString(36)}`);
		try {
			const result = this.port.store.beginCommandAttempt(this.port.fence, {
				sessionId: this.port.sessionId,
				commandId,
				attemptId,
				effectClass,
				requestDigest: stableRequest?.requestDigest ?? requestDigest ?? runtimeDigest({ effectClass, operation: "unspecified" }),
				originGeneration: this.port.fence.generation,
				createdAtMs: Date.now(),
			});
			this.port.domain?.trajectory?.invalidate();
			if (stableRequest !== undefined) return result;
			if (result.status === "started") return { attemptId, commandId };
			return result;
		} catch {
			this.port.onFenced();
			return { error: "owner_fenced" };
		}
	}

	/**
	 * §7.3 收口 attempt:只 append,不猜 outcome。
	 * interrupted/uncertain 保留 unresolved(barrier 评估可见)。
	 */
	public settleAttempt(attemptId: AttemptId, outcome: CommandAttemptOutcome, resultDigest?: RuntimeDigest, evidenceDigest?: RuntimeDigest): { readonly ok: true } | { readonly ok: false; readonly code: string } {
		const receipt = this.port.store.listAllAttemptReceipts(this.port.sessionId).find((candidate) => candidate.attemptId === attemptId);
		if (receipt === undefined) return { ok: false, code: "attempt_not_found" };
		try {
			this.port.store.appendAttemptReceipt(this.port.fence, {
				receiptId: createRuntimeId("receipt", `settle-${attemptId.slice(-20)}-${Date.now().toString(36)}`),
				sessionId: this.port.sessionId,
				commandId: receipt.commandId,
				attemptId,
				originGeneration: receipt.originGeneration,
				settledGeneration: isTerminalAttemptOutcome(outcome) ? this.port.fence.generation : undefined,
				effectClass: receipt.effectClass,
				outcome,
				resultDigest,
				evidenceDigest,
				createdAtMs: Date.now(),
			});
		} catch {
			this.port.onFenced();
			return { ok: false, code: "owner_fenced" };
		}
		this.port.domain?.trajectory?.invalidate();
		return { ok: true };
	}

	// ── recovery decision(§7.3)───────────────────────────────────────────

	public recoveryAssess(): { readonly ok: true; readonly barrierState: "closed" | "open"; readonly unresolvedRemaining: number } {
		if (this.port.domain?.process?.hasRecoveryUncertainty?.() === true) {
			this.port.setState("recovery_required");
			this.port.invalidateIdleRecap();
			return { ok: true, barrierState: "open", unresolvedRemaining: this.unresolvedAttemptsCount() };
		}
		const result = this.port.barrier.assess();
		if (result.ok && result.state === "closed") {
			this.port.setState("ready");
			this.port.invalidateIdleRecap();
			this.port.ownerPublishRunning();
			this.port.emit({ eventType: "recovery.assessed_clean", payload: { barrierState: "closed" } });
		}
		return { ok: true, barrierState: result.ok ? result.state : "open", unresolvedRemaining: result.ok ? result.unresolvedRemaining : this.unresolvedAttemptsCount() };
	}

	public recoveryDecide(decision: RecoveryDecision): { readonly ok: boolean; readonly code?: string; readonly state: SessionRuntimeState } {
		const result = this.port.barrier.decide(decision);
		if (!result.ok) return { ok: false, code: result.code, state: this.port.currentState() };
		if (decision.kind === "resume_despite_uncertainty") {
			this.port.setState("ready_with_uncertainty");
			this.port.invalidateIdleRecap();
		} else if (result.state === "closed") {
			this.port.setState("ready");
			this.port.invalidateIdleRecap();
		}
		if (result.state === "closed") this.port.ownerPublishRunning();
		return { ok: true, state: this.port.currentState() };
	}
}

function isTerminalAttemptOutcome(outcome: CommandAttemptOutcome): boolean {
	return outcome === "committed" || outcome === "rejected" || outcome === "verified";
}
