/** Finding 的单向生命周期、阻塞策略与有界 remediation。 */

import type { FindingId } from "../protocol/v3/ids.ts";
import { TrustedVerifierIssuerRegistry } from "./security.ts";
import type {
	FindingBlockingPolicy,
	FindingState,
	FindingTransitionRequest,
	RemediationBudget,
	RemediationState,
	VerificationCoreResult,
	VerificationFinding,
	VerificationReport,
} from "./types.ts";

const NEXT_STATE: Readonly<Record<FindingState, FindingState | undefined>> = {
	detected: "drafted",
	drafted: "verified",
	verified: "published",
	published: "addressed",
	addressed: "reverified",
	reverified: "closed",
	closed: undefined,
};

function failure(
	code: "invalid_transition" | "untrusted_issuer" | "cross_commit_evidence" | "budget_exhausted",
	message: string,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function reportMatchesFinding(
	report: VerificationReport,
	finding: VerificationFinding,
	candidateCommit: string,
	requireVerificationId: boolean,
): boolean {
	return (
		report.result.authorityId === finding.authorityId &&
		report.result.tenantId === finding.tenantId &&
		(!requireVerificationId || report.result.verificationId === finding.verificationId) &&
		report.result.gateDigest === finding.gateDigest &&
		report.result.baseline.baseCommit === finding.baseCommit &&
		report.result.candidate.candidateCommit === candidateCommit
	);
}

export async function transitionFinding(
	finding: VerificationFinding,
	request: FindingTransitionRequest,
	registry: TrustedVerifierIssuerRegistry,
): Promise<VerificationCoreResult<VerificationFinding>> {
	if (
		!/^[a-f0-9]{64}$/.test(request.evidenceDigest) ||
		request.expectedRevision !== finding.revision ||
		NEXT_STATE[finding.state] !== request.to
	) {
		return failure("invalid_transition", "finding transition is not the next declared lifecycle state");
	}
	let confirmation = finding.confirmation;
	let candidateCommit = request.candidateCommit ?? finding.candidateCommit;
	if (request.to === "verified") {
		if (!request.verification || request.verification.result.outcome !== "failed") {
			return failure("invalid_transition", "finding verification requires a deterministic failed gate report");
		}
		if (!reportMatchesFinding(request.verification, finding, finding.candidateCommit, true)) {
			return failure("cross_commit_evidence", "finding verification report is stale or belongs to another commit");
		}
		if (!(await registry.verify(request.verification)).ok) {
			return failure("untrusted_issuer", "finding verification report is not trusted");
		}
		confirmation = "verified";
	}
	if (request.to === "addressed") {
		if (!request.candidateCommit || request.candidateCommit === finding.candidateCommit) {
			return failure("invalid_transition", "addressed finding requires a new candidate commit");
		}
		candidateCommit = request.candidateCommit;
	}
	if (request.to === "reverified") {
		if (!request.verification || request.verification.result.outcome !== "passed") {
			return failure("invalid_transition", "reverified finding requires a deterministic passed gate report");
		}
		if (!reportMatchesFinding(request.verification, finding, finding.candidateCommit, false)) {
			return failure("cross_commit_evidence", "reverification report does not bind the addressed commit");
		}
		if (!(await registry.verifyForCompletion(request.verification))) {
			return failure("untrusted_issuer", "finding reverification report is not trusted");
		}
	}
	return {
		ok: true,
		value: {
			...finding,
			...(request.to === "reverified" && request.verification
				? { verificationId: request.verification.result.verificationId }
				: {}),
			state: request.to,
			candidateCommit,
			confirmation,
			revision: finding.revision + 1,
		},
	};
}

/** inconclusive 或 LLM candidate 永不阻塞；addressed 在复验通过前仍阻塞。 */
export function isBlockingFinding(finding: VerificationFinding, policy: FindingBlockingPolicy): boolean {
	return (
		finding.confirmation === "verified" &&
		(finding.state === "verified" || finding.state === "published" || finding.state === "addressed") &&
		policy.blockingSeverities.includes(finding.severity) &&
		policy.blockingPolicyClasses.includes(finding.policyClass)
	);
}

export function createRemediationState(findingId: FindingId, startedAt: string): RemediationState {
	return { findingId, startedAt, roundsCompleted: 0, costUsd: 0, durationMs: 0, status: "ready" };
}

function exhausted(state: RemediationState, budget: RemediationBudget): boolean {
	return (
		state.roundsCompleted >= budget.maxRounds ||
		state.costUsd >= budget.maxCostUsd ||
		state.durationMs >= budget.maxDurationMs
	);
}

function validBudget(budget: RemediationBudget): boolean {
	return (
		Number.isSafeInteger(budget.maxRounds) &&
		budget.maxRounds > 0 &&
		Number.isFinite(budget.maxCostUsd) &&
		budget.maxCostUsd > 0 &&
		Number.isSafeInteger(budget.maxDurationMs) &&
		budget.maxDurationMs > 0
	);
}

export function beginRemediationRound(
	state: RemediationState,
	budget: RemediationBudget,
): VerificationCoreResult<RemediationState> {
	if (!validBudget(budget)) return failure("budget_exhausted", "remediation budget is invalid");
	if (state.status !== "ready") {
		return failure("invalid_transition", "a remediation round cannot start before prior reverification settles");
	}
	if (exhausted(state, budget)) return failure("budget_exhausted", "remediation budget is exhausted");
	return { ok: true, value: { ...state, status: "round_active" } };
}

export function finishRemediationRound(
	state: RemediationState,
	budget: RemediationBudget,
	result: { costUsd: number; durationMs: number; candidateCommit: string },
): VerificationCoreResult<RemediationState> {
	if (
		!validBudget(budget) ||
		state.status !== "round_active" ||
		!Number.isFinite(result.costUsd) ||
		!Number.isSafeInteger(result.durationMs) ||
		result.costUsd < 0 ||
		result.durationMs < 0 ||
		!result.candidateCommit
	) {
		return failure("invalid_transition", "invalid remediation round settlement");
	}
	const settled: RemediationState = {
		...state,
		roundsCompleted: state.roundsCompleted + 1,
		costUsd: state.costUsd + result.costUsd,
		durationMs: state.durationMs + result.durationMs,
		status: "awaiting_reverification",
		lastCandidateCommit: result.candidateCommit,
	};
	// 即使本轮耗尽预算，也必须先完成 reverification；预算只阻止下一轮。
	return { ok: true, value: settled };
}

export async function recordRemediationReverification(
	state: RemediationState,
	report: VerificationReport,
	registry: TrustedVerifierIssuerRegistry,
	budget: RemediationBudget,
): Promise<VerificationCoreResult<RemediationState>> {
	if (!validBudget(budget)) return failure("budget_exhausted", "remediation budget is invalid");
	if (state.status !== "awaiting_reverification" || report.result.candidate.candidateCommit !== state.lastCandidateCommit) {
		return failure("cross_commit_evidence", "remediation reverification is stale or out of sequence");
	}
	if (!(await registry.verify(report)).ok) return failure("untrusted_issuer", "remediation reverification is not trusted");
	if (report.result.outcome === "inconclusive") {
		return { ok: true, value: { ...state, lastVerificationReceiptDigest: report.receipt.receiptDigest } };
	}
	if (report.result.outcome === "passed") {
		return {
			ok: true,
			value: { ...state, status: "succeeded", lastVerificationReceiptDigest: report.receipt.receiptDigest },
		};
	}
	const nextStatus = exhausted(state, budget) ? "exhausted" as const : "ready" as const;
	return {
		ok: true,
		value: { ...state, status: nextStatus, lastVerificationReceiptDigest: report.receipt.receiptDigest },
	};
}
