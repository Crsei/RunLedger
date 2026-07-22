/** Reviewer 读取证明、证据不可变性与 Artifact 持久化绑定。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import { ArtifactEvidenceReceiptSchema, CandidateIdentitySchema } from "./evidence.ts";
import {
	REVIEW_EVIDENCE_SCHEMA_VERSION,
	type ReviewDiffReadProof,
	type ReviewEvidence,
	type ReviewEvidenceBody,
	type VerificationCoreResult,
} from "./types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const boundedToken = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ReviewerProfileSchema = exact({
	role: Type.Union([
		Type.Literal("builder"),
		Type.Literal("test_generator"),
		Type.Literal("reviewer"),
		Type.Literal("security_reviewer"),
	]),
	readOnly: Type.Boolean(),
	freshContext: Type.Boolean(),
	startsFrom: Type.Union([Type.Literal("task"), Type.Literal("tests"), Type.Literal("diff")]),
	writeScope: Type.Union([Type.Literal("workspace"), Type.Literal("tests_only"), Type.Literal("none")]),
	network: Type.Union([Type.Literal("policy"), Type.Literal("deny")]),
});

const ReviewDiffReadProofBodySchema = exact({
	candidateCommit: boundedToken,
	diffArtifactReceiptDigest: digest,
	complete: Type.Boolean(),
	readHunkDigests: Type.Array(digest, { maxItems: 8_192 }),
	proofIssuerId: runtimeId("principal"),
});

export const ReviewDiffReadProofSchema = exact({
	...ReviewDiffReadProofBodySchema.properties,
	proofDigest: digest,
});

export const ReviewEvidenceBodySchema = exact({
	schemaVersion: Type.Literal(REVIEW_EVIDENCE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	reviewId: runtimeId("command"),
	reviewerId: runtimeId("principal"),
	reviewerProfile: ReviewerProfileSchema,
	candidate: CandidateIdentitySchema,
	trustedBaselineReceiptDigest: digest,
	diffArtifact: ArtifactEvidenceReceiptSchema,
	diffReadProof: ReviewDiffReadProofSchema,
	inspectedFiles: Type.Array(exact({
		path: boundedToken,
		contentDigest: digest,
		inspectionDigest: digest,
	}), { maxItems: 8_192 }),
	verificationArtifacts: Type.Array(ArtifactEvidenceReceiptSchema, { maxItems: 512 }),
	reverseAuditHypotheses: Type.Array(exact({
		hypothesisDigest: digest,
		evidenceArtifactIds: Type.Array(runtimeId("artifact"), { maxItems: 512 }),
	}), { maxItems: 1_024 }),
	verdict: Type.Union([
		Type.Literal("approve"),
		Type.Literal("request_changes"),
		Type.Literal("inconclusive"),
	]),
	producedAt: timestamp,
});

export const ReviewEvidenceSchema = exact({
	...ReviewEvidenceBodySchema.properties,
	evidenceDigest: digest,
});

export interface ReviewEvidencePersistenceRequest {
	readonly evidence: ReviewEvidence;
	readonly canonicalDocument: string;
}

export interface ReviewEvidencePersistenceResult {
	readonly artifact: ArtifactRef;
	readonly sourceDigest: string;
	readonly persistedAt: string;
}

export interface ReviewEvidenceArtifactPort {
	persist(
		request: ReviewEvidencePersistenceRequest,
	): Promise<VerificationCoreResult<ReviewEvidencePersistenceResult>>;
}

export interface ReviewEvidenceRef {
	readonly schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
	readonly reviewId: ReviewEvidence["reviewId"];
	readonly candidateCommit: string;
	readonly evidenceDigest: string;
	readonly artifact: ArtifactRef;
	readonly persistedAt: string;
	readonly refDigest: string;
}

export const ReviewEvidenceRefSchema = exact({
	schemaVersion: Type.Literal(REVIEW_EVIDENCE_SCHEMA_VERSION),
	reviewId: runtimeId("command"),
	candidateCommit: boundedToken,
	evidenceDigest: digest,
	artifact: ArtifactRefSchema,
	persistedAt: timestamp,
	refDigest: digest,
});

function failure(
	code: "invalid_schema" | "invalid_digest" | "artifact_invalid" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

function proofBody(proof: ReviewDiffReadProof): Omit<ReviewDiffReadProof, "proofDigest"> {
	const { proofDigest: _proofDigest, ...body } = proof;
	return body;
}

function evidenceBody(evidence: ReviewEvidence): ReviewEvidenceBody {
	const { evidenceDigest: _evidenceDigest, ...body } = evidence;
	return body;
}

export function createReviewDiffReadProof(
	input: Omit<ReviewDiffReadProof, "proofDigest">,
): VerificationCoreResult<ReviewDiffReadProof> {
	if (!Check(ReviewDiffReadProofBodySchema, input)) {
		return failure("invalid_schema", "review diff-read proof is not exact or bounded");
	}
	const proof: ReviewDiffReadProof = { ...input, proofDigest: canonicalDigest(input) };
	return Check(ReviewDiffReadProofSchema, proof)
		? { ok: true, value: deepFreeze(structuredClone(proof)) }
		: failure("invalid_schema", "review diff-read proof is invalid");
}

export function isReviewDiffReadProof(value: unknown): value is ReviewDiffReadProof {
	if (!Check(ReviewDiffReadProofSchema, value)) return false;
	const proof = value as unknown as ReviewDiffReadProof;
	return proof.proofDigest === canonicalDigest(proofBody(proof));
}

export function createReviewEvidence(input: ReviewEvidenceBody): VerificationCoreResult<ReviewEvidence> {
	if (!Check(ReviewEvidenceBodySchema, input) || !isReviewDiffReadProof(input.diffReadProof)) {
		return failure("invalid_schema", "review evidence is not exact, bounded, or canonically proven");
	}
	const evidence: ReviewEvidence = { ...input, evidenceDigest: canonicalDigest(input) };
	return Check(ReviewEvidenceSchema, evidence)
		? { ok: true, value: deepFreeze(structuredClone(evidence)) }
		: failure("invalid_schema", "review evidence is invalid");
}

export function isReviewEvidence(value: unknown): value is ReviewEvidence {
	if (!Check(ReviewEvidenceSchema, value)) return false;
	const evidence = value as unknown as ReviewEvidence;
	return (
		isReviewDiffReadProof(evidence.diffReadProof) &&
		evidence.evidenceDigest === canonicalDigest(evidenceBody(evidence))
	);
}

export function isReviewEvidenceRef(value: unknown): value is ReviewEvidenceRef {
	if (!Check(ReviewEvidenceRefSchema, value)) return false;
	const reference = value as ReviewEvidenceRef;
	const { refDigest, ...body } = reference;
	return reference.artifact.kind === "session_report" && refDigest === canonicalDigest(body);
}

export async function persistReviewEvidence(
	evidence: ReviewEvidence,
	port: ReviewEvidenceArtifactPort,
): Promise<VerificationCoreResult<ReviewEvidenceRef>> {
	if (!isReviewEvidence(evidence)) return failure("invalid_schema", "review evidence changed before persistence");
	let persisted: Awaited<ReturnType<ReviewEvidenceArtifactPort["persist"]>>;
	try {
		persisted = await port.persist({ evidence, canonicalDocument: canonicalJson(evidence) });
	} catch {
		return failure("evidence_unavailable", "review evidence Artifact store is unavailable", true);
	}
	if (!persisted.ok) return persisted;
	const { artifact, sourceDigest, persistedAt } = persisted.value;
	if (
		!Check(ArtifactRefSchema, artifact) ||
		artifact.kind !== "session_report" ||
		artifact.authorityId !== evidence.authorityId ||
		artifact.tenantId !== evidence.tenantId ||
		artifact.workspaceId !== evidence.candidate.workspaceId ||
		sourceDigest !== evidence.evidenceDigest ||
		Number.isNaN(Date.parse(persistedAt))
	) return failure("artifact_invalid", "review evidence Artifact is not correlated to the immutable evidence");
	const body: Omit<ReviewEvidenceRef, "refDigest"> = {
		schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
		reviewId: evidence.reviewId,
		candidateCommit: evidence.candidate.candidateCommit,
		evidenceDigest: evidence.evidenceDigest,
		artifact,
		persistedAt,
	};
	return { ok: true, value: deepFreeze({ ...body, refDigest: canonicalDigest(body) }) };
}
