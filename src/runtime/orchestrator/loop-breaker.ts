/** 重复调用、重复失败、无进展 diff 与 remediation 上限的确定性熔断器。 */

import type { GoalPhase, OrchestratorResult } from "./types.ts";

export type LoopBreakReason =
	| "repeated_tool_signature"
	| "repeated_failure"
	| "no_progress_diff"
	| "remediation_limit";

export interface LoopBreakerPolicy {
	maxRepeatedToolSignature: number;
	maxRepeatedFailure: number;
	maxNoProgress: number;
	maxRemediationAttempts: number;
}

export interface LoopObservation {
	observationId: string;
	phase: GoalPhase;
	toolSignature?: string;
	failureDigest?: string;
	diffDigest?: string;
	madeProgress: boolean;
	observedAt: string;
}

export interface LoopBreakerState {
	observationIds: ReadonlySet<string>;
	lastToolSignature?: string;
	repeatedToolSignature: number;
	lastFailureDigest?: string;
	repeatedFailure: number;
	lastDiffDigest?: string;
	noProgressCount: number;
	remediationAttempts: number;
	tripped?: { reason: LoopBreakReason; observationId: string; trippedAt: string };
}

export function initialLoopBreakerState(): LoopBreakerState {
	return {
		observationIds: new Set(),
		repeatedToolSignature: 0,
		repeatedFailure: 0,
		noProgressCount: 0,
		remediationAttempts: 0,
	};
}

function policyIsValid(policy: LoopBreakerPolicy): boolean {
	return Object.values(policy).every((limit) => Number.isSafeInteger(limit) && limit > 0);
}

function cloneState(state: LoopBreakerState): LoopBreakerState {
	return { ...state, observationIds: new Set(state.observationIds), tripped: state.tripped ? { ...state.tripped } : undefined };
}

export function observeLoop(
	state: LoopBreakerState,
	observation: LoopObservation,
	policy: LoopBreakerPolicy,
): OrchestratorResult<LoopBreakerState> {
	if (!policyIsValid(policy) || observation.observationId.length === 0) {
		return { ok: false, error: { code: "invalid_input", message: "loop breaker input is invalid", retryable: false } };
	}
	if (state.observationIds.has(observation.observationId)) return { ok: true, value: cloneState(state) };
	if (state.tripped) {
		return { ok: false, error: { code: "loop_broken", message: `loop already broken: ${state.tripped.reason}`, retryable: false } };
	}
	const next = cloneState(state);
	(next.observationIds as Set<string>).add(observation.observationId);
	if (observation.toolSignature) {
		next.repeatedToolSignature =
			observation.toolSignature === state.lastToolSignature ? state.repeatedToolSignature + 1 : 1;
		next.lastToolSignature = observation.toolSignature;
	} else {
		next.repeatedToolSignature = 0;
		next.lastToolSignature = undefined;
	}
	if (observation.failureDigest) {
		next.repeatedFailure = observation.failureDigest === state.lastFailureDigest ? state.repeatedFailure + 1 : 1;
		next.lastFailureDigest = observation.failureDigest;
	} else {
		next.repeatedFailure = 0;
		next.lastFailureDigest = undefined;
	}
	if (!observation.madeProgress) {
		next.noProgressCount = observation.diffDigest === state.lastDiffDigest ? state.noProgressCount + 1 : 1;
		next.lastDiffDigest = observation.diffDigest;
	} else {
		next.noProgressCount = 0;
		next.lastDiffDigest = observation.diffDigest;
	}
	if (observation.phase === "remediation") next.remediationAttempts += 1;

	let reason: LoopBreakReason | undefined;
	if (next.repeatedToolSignature >= policy.maxRepeatedToolSignature) reason = "repeated_tool_signature";
	else if (next.repeatedFailure >= policy.maxRepeatedFailure) reason = "repeated_failure";
	else if (next.noProgressCount >= policy.maxNoProgress) reason = "no_progress_diff";
	else if (next.remediationAttempts >= policy.maxRemediationAttempts) reason = "remediation_limit";
	if (reason) next.tripped = { reason, observationId: observation.observationId, trippedAt: observation.observedAt };
	return { ok: true, value: next };
}

export function replayLoopBreaker(
	observations: readonly LoopObservation[],
	policy: LoopBreakerPolicy,
): OrchestratorResult<LoopBreakerState> {
	let state = initialLoopBreakerState();
	for (const observation of observations) {
		const next = observeLoop(state, observation, policy);
		if (!next.ok) return next;
		state = next.value;
	}
	return { ok: true, value: state };
}

export class LoopBreaker {
	private readonly policy: LoopBreakerPolicy;
	private state: LoopBreakerState;

	public constructor(policy: LoopBreakerPolicy, replay: readonly LoopObservation[] = []) {
		this.policy = policy;
		const restored = replayLoopBreaker(replay, policy);
		this.state = restored.ok ? restored.value : initialLoopBreakerState();
	}

	public observe(observation: LoopObservation): OrchestratorResult<LoopBreakerState> {
		const result = observeLoop(this.state, observation, this.policy);
		if (result.ok) this.state = result.value;
		return result;
	}

	public snapshot(): LoopBreakerState {
		return cloneState(this.state);
	}

	public canStartWork(): OrchestratorResult<void> {
		return this.state.tripped
			? { ok: false, error: { code: "loop_broken", message: `loop broken: ${this.state.tripped.reason}`, retryable: false } }
			: { ok: true, value: undefined };
	}
}
