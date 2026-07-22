/** Builder/Test Generator/Reviewer/Security Reviewer 的隔离 profile 与 review evidence。 */

import type { FindingId, VerificationId } from "../protocol/v3/ids.ts";
import { isArtifactEvidenceReceipt } from "./evidence.ts";
import { isReviewEvidence, isReviewEvidenceRef, type ReviewEvidenceRef } from "./review-evidence.ts";
import type {
	ReviewEvidence,
	ReviewerProfile,
	VerificationCoreResult,
	VerificationFinding,
} from "./types.ts";

export const REVIEWER_PROFILES: Readonly<Record<ReviewerProfile["role"], ReviewerProfile>> = {
	builder: {
		role: "builder",
		readOnly: false,
		freshContext: false,
		startsFrom: "task",
		writeScope: "workspace",
		network: "policy",
	},
	test_generator: {
		role: "test_generator",
		readOnly: false,
		freshContext: true,
		startsFrom: "tests",
		writeScope: "tests_only",
		network: "deny",
	},
	reviewer: {
		role: "reviewer",
		readOnly: true,
		freshContext: true,
		startsFrom: "diff",
		writeScope: "none",
		network: "deny",
	},
	security_reviewer: {
		role: "security_reviewer",
		readOnly: true,
		freshContext: true,
		startsFrom: "diff",
		writeScope: "none",
		network: "deny",
	},
};

export interface ReviewAssessment {
	kind: "finding_candidates";
	verdict: ReviewEvidence["verdict"];
	evidenceDigest: string;
	issueCodes: readonly string[];
	/** LLM review 结果永远不能成为 deterministic gate pass。 */
	deterministicPass: false;
}

function failure(message: string): VerificationCoreResult<never> {
	return { ok: false, error: { code: "invalid_schema", message, retryable: false } };
}

function artifactMatchesCandidate(evidence: ReviewEvidence, output: ReviewEvidence["diffArtifact"]): boolean {
	return (
		isArtifactEvidenceReceipt(output) &&
		output.authorityId === evidence.candidate.authorityId &&
		output.tenantId === evidence.candidate.tenantId &&
		output.candidateCommit === evidence.candidate.candidateCommit &&
		output.artifact.workspaceId === evidence.candidate.workspaceId
	);
}

export function assessReviewEvidence(evidence: ReviewEvidence): VerificationCoreResult<ReviewAssessment> {
	if (!isReviewEvidence(evidence)) return failure("review evidence is not an immutable canonical record");
	const issues: string[] = [];
	if (!artifactMatchesCandidate(evidence, evidence.diffArtifact) || evidence.diffArtifact.artifact.kind !== "diff") {
		issues.push("diff_artifact_stale");
	}
	if (
		!evidence.diffReadProof.complete ||
		evidence.diffReadProof.candidateCommit !== evidence.candidate.candidateCommit ||
		evidence.diffReadProof.diffArtifactReceiptDigest !== evidence.diffArtifact.receiptDigest ||
		evidence.diffReadProof.readHunkDigests.length === 0 ||
		evidence.inspectedFiles.length === 0
	) issues.push("diff_not_read");
	if (
		(evidence.reviewerProfile.role !== "reviewer" && evidence.reviewerProfile.role !== "security_reviewer") ||
		!evidence.reviewerProfile.readOnly ||
		!evidence.reviewerProfile.freshContext ||
		evidence.reviewerProfile.writeScope !== "none"
	) issues.push("reviewer_not_isolated");
	if (!evidence.verificationArtifacts.every((artifact) => artifactMatchesCandidate(evidence, artifact))) {
		issues.push("cross_commit_evidence");
	}
	if (evidence.reverseAuditHypotheses.length === 0) issues.push("reverse_audit_missing");
	if (evidence.verificationArtifacts.length === 0) issues.push("verification_artifacts_missing");
	const verdict = issues.length > 0 ? "inconclusive" as const : evidence.verdict;
	return {
		ok: true,
		value: {
			kind: "finding_candidates",
			verdict,
			evidenceDigest: evidence.evidenceDigest,
			issueCodes: issues,
			deterministicPass: false,
		},
	};
}

export function createReviewFindingCandidate(input: {
	findingId: FindingId;
	verificationId: VerificationId;
	evidence: ReviewEvidence;
	evidenceRef: ReviewEvidenceRef;
	securityReview: boolean;
	severity: VerificationFinding["severity"];
	policyClass: string;
	summaryDigest: string;
}): VerificationCoreResult<VerificationFinding> {
	const assessment = assessReviewEvidence(input.evidence);
	if (!assessment.ok) return assessment;
	if (
		!isReviewEvidenceRef(input.evidenceRef) ||
		input.evidenceRef.evidenceDigest !== input.evidence.evidenceDigest ||
		input.evidenceRef.reviewId !== input.evidence.reviewId ||
		input.evidenceRef.candidateCommit !== input.evidence.candidate.candidateCommit ||
		input.evidenceRef.artifact.kind !== "session_report"
	) return failure("review evidence must be persisted as the matching immutable Artifact before publication");
	return {
		ok: true,
		value: {
			authorityId: input.evidence.candidate.authorityId,
			tenantId: input.evidence.candidate.tenantId,
			findingId: input.findingId,
			verificationId: input.verificationId,
			gateDigest: input.evidence.diffArtifact.schemaDigest,
			baseCommit: input.evidence.candidate.baseCommit,
			candidateCommit: input.evidence.candidate.candidateCommit,
			source: input.securityReview ? "security_review" : "llm_review",
			state: "detected",
			severity: input.severity,
			policyClass: input.policyClass,
			summaryDigest: input.summaryDigest,
			evidenceArtifactIds: [
				input.evidenceRef.artifact.artifactId,
				input.evidence.diffArtifact.artifact.artifactId,
				...input.evidence.verificationArtifacts.map((entry) => entry.artifact.artifactId),
			],
			confirmation: assessment.value.verdict === "inconclusive" ? "inconclusive" : "candidate",
			revision: 0,
		},
	};
}
