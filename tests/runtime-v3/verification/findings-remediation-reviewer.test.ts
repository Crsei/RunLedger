import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createReviewDiffReadProof,
	createReviewEvidence,
	persistReviewEvidence,
} from "../../../src/runtime/verification/review-evidence.ts";
import {
	beginRemediationRound,
	createRemediationState,
	finishRemediationRound,
	isBlockingFinding,
	recordRemediationReverification,
	transitionFinding,
} from "../../../src/runtime/verification/findings.ts";
import {
	REVIEWER_PROFILES,
	assessReviewEvidence,
	createReviewFindingCandidate,
} from "../../../src/runtime/verification/reviewer.ts";
import type { ReviewEvidence, VerificationFinding } from "../../../src/runtime/verification/types.ts";
import {
	AUTHORITY_ID,
	CANDIDATE_COMMIT,
	FINISHED,
	PRINCIPAL_ID,
	TENANT_ID,
	VERIFICATION_ID,
	artifactReceipt,
	candidate,
	digest,
	registry,
	reportFor,
	verificationResult,
} from "./helpers.ts";

function failedReport() {
	return reportFor(verificationResult({ exitCode: 1 }));
}

function reviewEvidence(input: { commit?: string; diffCommit?: string; readProof?: boolean } = {}): ReviewEvidence {
	const selected = candidate(input.commit ?? CANDIDATE_COMMIT);
	const diffArtifact = artifactReceipt({
		candidateCommit: input.diffCommit ?? selected.candidateCommit,
		outputName: "diff",
		kind: "diff",
		mediaType: "text/x-diff",
		schemaDigest: digest("diff-schema"),
		artifactSeed: "review-diff",
	});
	const proof = createReviewDiffReadProof({
		candidateCommit: selected.candidateCommit,
		diffArtifactReceiptDigest: diffArtifact.receiptDigest,
		complete: input.readProof !== false,
		readHunkDigests: input.readProof === false ? [] : [digest("diff-hunk")],
		proofIssuerId: PRINCIPAL_ID,
	});
	if (!proof.ok) throw new Error(proof.error.message);
	const evidence = createReviewEvidence({
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		reviewId: createRuntimeId("command", "review-evidence"),
		reviewerId: PRINCIPAL_ID,
		reviewerProfile: REVIEWER_PROFILES.reviewer,
		candidate: selected,
		trustedBaselineReceiptDigest: digest("trusted-baseline"),
		diffArtifact,
		diffReadProof: proof.value,
		inspectedFiles: input.readProof === false ? [] : [{
			path: "src/file.ts",
			contentDigest: digest("src/file.ts:content"),
			inspectionDigest: digest("src/file.ts:inspection"),
		}],
		verificationArtifacts: [artifactReceipt({ candidateCommit: selected.candidateCommit })],
		reverseAuditHypotheses: [{
			hypothesisDigest: digest("reverse-hypothesis"),
			evidenceArtifactIds: [],
		}],
		verdict: "approve",
		producedAt: FINISHED,
	});
	if (!evidence.ok) throw new Error(evidence.error.message);
	return evidence.value;
}

async function persistEvidence(evidence: ReviewEvidence) {
	const persisted = await persistReviewEvidence(evidence, {
		persist: async ({ canonicalDocument }) => ({
			ok: true,
			value: {
				artifact: {
					authorityId: evidence.authorityId,
					tenantId: evidence.tenantId,
					artifactId: createRuntimeId("artifact", "review-evidence"),
					storedDigest: digest(canonicalDocument),
					kind: "session_report",
					originalSize: canonicalDocument.length,
					storedSize: canonicalDocument.length,
					mediaType: "application/vnd.runledger.review-evidence+json",
					redaction: "redacted",
					transformReceipt: createRuntimeId("receipt", "review-evidence-transform"),
					workspaceId: evidence.candidate.workspaceId,
				},
				sourceDigest: evidence.evidenceDigest,
				persistedAt: FINISHED,
			},
		}),
	});
	if (!persisted.ok) throw new Error(persisted.error.message);
	return persisted.value;
}

function finding(): VerificationFinding {
	const failed = failedReport();
	return {
		authorityId: failed.result.authorityId,
		tenantId: failed.result.tenantId,
		findingId: createRuntimeId("finding", "verification-finding"),
		verificationId: failed.result.verificationId,
		gateDigest: failed.result.gateDigest,
		baseCommit: failed.result.candidate.baseCommit,
		candidateCommit: failed.result.candidate.candidateCommit,
		source: "deterministic_gate",
		state: "detected",
		severity: "high",
		policyClass: "required-test",
		summaryDigest: digest("finding-summary"),
		evidenceArtifactIds: failed.result.artifacts.map((entry) => entry.artifact.artifactId),
		confirmation: "candidate",
		revision: 0,
	};
}

describe("finding lifecycle, remediation, and isolated review", () => {
	it("enforces the complete adjacent Finding lifecycle and requires trusted verification/reverification", async () => {
		const trust = registry();
		let current = finding();
		const drafted = await transitionFinding(current, {
			to: "drafted",
			expectedRevision: current.revision,
			evidenceDigest: digest("draft"),
		}, trust);
		if (!drafted.ok) throw new Error(drafted.error.message);
		current = drafted.value;
		const verified = await transitionFinding(current, {
			to: "verified",
			expectedRevision: current.revision,
			evidenceDigest: digest("verify"),
			verification: failedReport(),
		}, trust);
		if (!verified.ok) throw new Error(verified.error.message);
		current = verified.value;
		expect(current.confirmation).toBe("verified");
		expect(isBlockingFinding(current, { blockingSeverities: ["high", "critical"], blockingPolicyClasses: ["required-test"] })).toBe(true);

		for (const to of ["published", "addressed"] as const) {
			const transitioned = await transitionFinding(current, {
				to,
				expectedRevision: current.revision,
				evidenceDigest: digest(to),
				...(to === "addressed" ? { candidateCommit: "3".repeat(40) } : {}),
			}, trust);
			if (!transitioned.ok) throw new Error(transitioned.error.message);
			current = transitioned.value;
		}
		const newVerificationId = createRuntimeId("verification", "reverification");
		const passed = reportFor(verificationResult({
			candidate: candidate("3".repeat(40)),
			verificationId: newVerificationId,
			requestId: createRuntimeId("command", "reverification"),
		}));
		const reverified = await transitionFinding(current, {
			to: "reverified",
			expectedRevision: current.revision,
			evidenceDigest: digest("reverified"),
			verification: passed,
		}, trust);
		if (!reverified.ok) throw new Error(reverified.error.message);
		current = reverified.value;
		expect(current.verificationId).toBe(newVerificationId);
		expect(isBlockingFinding(current, { blockingSeverities: ["high"], blockingPolicyClasses: ["required-test"] })).toBe(false);
		const closed = await transitionFinding(current, {
			to: "closed",
			expectedRevision: current.revision,
			evidenceDigest: digest("closed"),
		}, trust);
		expect(closed.ok && closed.value.state).toBe("closed");
	});

	it("does not let inconclusive evidence or a lifecycle skip verify a Finding", async () => {
		const trust = registry();
		const initial = finding();
		expect((await transitionFinding(initial, {
			to: "verified",
			expectedRevision: 0,
			evidenceDigest: digest("skip"),
			verification: failedReport(),
		}, trust)).ok).toBe(false);
		const drafted = await transitionFinding(initial, {
			to: "drafted",
			expectedRevision: 0,
			evidenceDigest: digest("draft"),
		}, trust);
		if (!drafted.ok) throw new Error(drafted.error.message);
		const inconclusive = reportFor(verificationResult({ enforcement: "degraded" }));
		expect((await transitionFinding(drafted.value, {
			to: "verified",
			expectedRevision: 1,
			evidenceDigest: digest("inconclusive"),
			verification: inconclusive,
		}, trust)).ok).toBe(false);
	});

	it("requires reverification after every bounded remediation round", async () => {
		const trust = registry();
		const budget = { maxRounds: 1, maxCostUsd: 5, maxDurationMs: 60_000 };
		let state = createRemediationState(createRuntimeId("finding", "remediation"), "2026-07-22T08:00:00.000Z");
		const begun = beginRemediationRound(state, budget);
		if (!begun.ok) throw new Error(begun.error.message);
		const settled = finishRemediationRound(begun.value, budget, {
			costUsd: 6,
			durationMs: 1_000,
			candidateCommit: CANDIDATE_COMMIT,
		});
		if (!settled.ok) throw new Error(settled.error.message);
		state = settled.value;
		expect(state.status).toBe("awaiting_reverification");
		expect(beginRemediationRound(state, budget).ok).toBe(false);

		const inconclusive = reportFor(verificationResult({ enforcement: "degraded" }));
		const stillWaiting = await recordRemediationReverification(state, inconclusive, trust, budget);
		if (!stillWaiting.ok) throw new Error(stillWaiting.error.message);
		expect(stillWaiting.value.status).toBe("awaiting_reverification");

		const failed = await recordRemediationReverification(state, failedReport(), trust, budget);
		if (!failed.ok) throw new Error(failed.error.message);
		expect(failed.value.status).toBe("exhausted");
		expect(beginRemediationRound(
			createRemediationState(createRuntimeId("finding", "invalid-budget"), "2026-07-22T08:00:00.000Z"),
			{ maxRounds: 1, maxCostUsd: Number.NaN, maxDurationMs: 1_000 },
		).ok).toBe(false);
	});

	it("keeps reviewer profiles isolated and makes missing read-proof inconclusive", async () => {
		expect(REVIEWER_PROFILES.reviewer).toMatchObject({ readOnly: true, freshContext: true, startsFrom: "diff", writeScope: "none" });
		expect(REVIEWER_PROFILES.security_reviewer).toMatchObject({ readOnly: true, freshContext: true, network: "deny" });
		expect(REVIEWER_PROFILES.test_generator.writeScope).toBe("tests_only");

		const complete = assessReviewEvidence(reviewEvidence());
		expect(complete.ok && complete.value.verdict).toBe("approve");
		if (complete.ok) expect(complete.value.deterministicPass).toBe(false);
		const unread = assessReviewEvidence(reviewEvidence({ readProof: false }));
		expect(unread.ok && unread.value.verdict).toBe("inconclusive");
		if (unread.ok) expect(unread.value.issueCodes).toContain("diff_not_read");

		const evidence = reviewEvidence();
		const candidateFinding = createReviewFindingCandidate({
			findingId: createRuntimeId("finding", "review-candidate"),
			verificationId: VERIFICATION_ID,
			evidence,
			evidenceRef: await persistEvidence(evidence),
			securityReview: false,
			severity: "medium",
			policyClass: "review",
			summaryDigest: digest("review-summary"),
		});
		expect(candidateFinding.ok && candidateFinding.value.confirmation).toBe("candidate");
		expect(candidateFinding.ok && candidateFinding.value.state).toBe("detected");
	});

	it("makes cross-commit reuse inconclusive and freezes canonical evidence", () => {
		const stale = reviewEvidence({ diffCommit: "0".repeat(40) });
		const assessed = assessReviewEvidence(stale);
		expect(assessed.ok && assessed.value.verdict).toBe("inconclusive");
		if (assessed.ok) expect(assessed.value.issueCodes).toContain("diff_artifact_stale");
		expect(Object.isFrozen(stale)).toBe(true);
		expect(Object.isFrozen(stale.inspectedFiles)).toBe(true);
	});
});
