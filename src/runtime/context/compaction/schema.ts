/** Compaction contract 的 exact TypeBox schema 与安全 cut/chain 约束。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema } from "../../protocol/v3/capability.ts";
import { ApprovedPlanRefSchema, isApprovedPlanRef } from "../../modes/plan/schema.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import {
	DeclassificationReceiptRefSchema,
	InputSourceRefSchema,
	isDeclassificationReceiptRef,
	isInputSourceRef,
} from "../../protocol/v3/taint.ts";
import { WorkspaceBindingRefSchema } from "../../protocol/v3/workspace.ts";
import {
	COMPACTION_CONTRACT_VERSION,
	COMPACTION_INSTALLATION_STATES,
	COMPACTION_REASONS,
	COMPACTION_RECOVERY_CODES,
	COMPACTION_RECOVERY_OUTCOMES,
	COMPACTION_SUPPRESSION_REASONS,
	COMPACTION_VALIDATION_CODES,
	type CompactionAttemptReceipt,
	type CompactionCheckpoint,
	type CompactionCheckpointRef,
	type CompactionCut,
	type CompactionInvariantSnapshot,
	type CompactionProjectionInstallationReceipt,
	type CompactionRecoveryAssessment,
	type CompactionRecoveryCandidate,
	type CompactionReplacementHistoryEvidence,
	type CompactionSuffixRecoveryEvidence,
	type CompactionSuppressionReceipt,
	type CompactionValidationDiagnostic,
	type CompactionValidationResult,
} from "./types.ts";

export const COMPACTION_SCHEMA_VERSION = COMPACTION_CONTRACT_VERSION;
export const MAX_COMPACTION_ARTIFACTS = 256;
export const MAX_COMPACTION_DIAGNOSTICS = 64;
export const MAX_COMPACTION_TOKENS = 4_194_304;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const id = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 256 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boundedTokens = Type.Integer({ minimum: 0, maximum: MAX_COMPACTION_TOKENS });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literals = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const CompactionCutSchema = Type.Unsafe<CompactionCut>(exact({
	sourceFromSequence: count,
	sourceToSequence: count,
	retainedFromSequence: count,
	completedTurnCount: count,
	toolPairingDigest: digest,
	offloadedArtifacts: Type.Array(ArtifactRefSchema, { maxItems: MAX_COMPACTION_ARTIFACTS }),
}));

export const CompactionInvariantSnapshotSchema = Type.Unsafe<CompactionInvariantSnapshot>(exact({
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sessionId: id("session"),
	workspace: WorkspaceBindingRefSchema,
	modeRevision: count,
	approvedPlan: Type.Optional(ApprovedPlanRefSchema),
	pendingApprovalIds: Type.Array(id("approval"), { maxItems: 64, uniqueItems: true }),
	goalStateDigest: digest,
	taskStateDigest: digest,
	workspaceStateDigest: digest,
	verificationStateDigest: digest,
	toolPairingDigest: digest,
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
	invariantDigest: digest,
}));

export const CompactionValidationDiagnosticSchema = Type.Unsafe<CompactionValidationDiagnostic>(exact({
	code: literals(COMPACTION_VALIDATION_CODES),
	diagnosticDigest: digest,
	sequence: Type.Optional(count),
	artifactId: Type.Optional(id("artifact")),
}));

export const CompactionValidationResultSchema = Type.Unsafe<CompactionValidationResult>(Type.Union([
	exact({
		outcome: Type.Literal("valid"),
		validationDigest: digest,
		validatedAt: timestamp,
		diagnostics: Type.Tuple([]),
	}),
	exact({
		outcome: Type.Literal("invalid"),
		validationDigest: digest,
		validatedAt: timestamp,
		diagnostics: Type.Array(CompactionValidationDiagnosticSchema, { minItems: 1, maxItems: MAX_COMPACTION_DIAGNOSTICS }),
	}),
]));

export const CompactionReplacementHistoryEvidenceSchema =
	Type.Unsafe<CompactionReplacementHistoryEvidence>(exact({
		format: literals(["full", "patch"] as const),
		sessionId: id("session"),
		storedDigest: digest,
		contentDigest: digest,
		survivingSuffixFromSequence: count,
		previousReplacementHistoryDigest: Type.Optional(digest),
	}));

export const CompactionSuffixRecoveryEvidenceSchema =
	Type.Unsafe<CompactionSuffixRecoveryEvidence>(exact({
		integrity: literals(["verified", "jsonl_corrupted"] as const),
		fromSequence: count,
	}));

export const CompactionRecoveryCandidateSchema = Type.Unsafe<CompactionRecoveryCandidate>(exact({
	checkpoint: Type.Unknown(),
	checkpointIntegrity: literals(["verified", "digest_mismatch"] as const),
	previousCheckpoint: Type.Optional(Type.Unknown()),
	replacementHistory: Type.Optional(CompactionReplacementHistoryEvidenceSchema),
	legacyImport: Type.Boolean(),
	observedInvariantDigest: digest,
	suffix: CompactionSuffixRecoveryEvidenceSchema,
}));

export const CompactionRecoveryAssessmentSchema = Type.Unsafe<CompactionRecoveryAssessment>(exact({
	outcome: literals(COMPACTION_RECOVERY_OUTCOMES),
	codes: Type.Array(literals(COMPACTION_RECOVERY_CODES), {
		maxItems: COMPACTION_RECOVERY_CODES.length,
		uniqueItems: true,
	}),
	checkpointId: Type.Optional(id("checkpoint")),
	assessmentDigest: digest,
}));

export const CompactionCheckpointRefSchema = Type.Unsafe<CompactionCheckpointRef>(exact({
	schemaVersion: Type.Literal(COMPACTION_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	checkpointId: id("checkpoint"),
	compactionId: id("compaction"),
	sessionId: id("session"),
	sourceFromSequence: count,
	sourceToSequence: count,
	retainedFromSequence: count,
	survivingSuffixFromSequence: count,
	summaryArtifact: ArtifactRefSchema,
	summaryDigest: digest,
	replacementHistoryArtifact: ArtifactRefSchema,
	replacementHistoryDigest: digest,
	invariantDigest: digest,
	previousCheckpointId: Type.Optional(id("checkpoint")),
	previousCheckpointDigest: Type.Optional(digest),
	previousReplacementHistoryDigest: Type.Optional(digest),
	checkpointDigest: digest,
}));

export const CompactionCheckpointSchema = Type.Unsafe<CompactionCheckpoint>(exact({
	schemaVersion: Type.Literal(COMPACTION_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	compactionId: id("compaction"),
	checkpointId: id("checkpoint"),
	sessionId: id("session"),
	reason: literals(COMPACTION_REASONS),
	commandId: id("command"),
	cut: CompactionCutSchema,
	inputArtifact: ArtifactRefSchema,
	summaryArtifact: ArtifactRefSchema,
	summaryDigest: digest,
	replacementHistoryArtifact: ArtifactRefSchema,
	replacementHistoryDigest: digest,
	survivingSuffixFromSequence: count,
	previousReplacementHistoryDigest: Type.Optional(digest),
	summarizerProfileId: id("resource"),
	summarizerProfileDigest: digest,
	preEstimatedTokens: boundedTokens,
	postEstimatedTokens: boundedTokens,
	maxSummaryTokens: boundedTokens,
	invariantsBefore: CompactionInvariantSnapshotSchema,
	invariantsAfter: CompactionInvariantSnapshotSchema,
	validation: CompactionValidationResultSchema,
	previousCheckpoint: Type.Optional(CompactionCheckpointRefSchema),
	checkpointDigest: digest,
	createdAt: timestamp,
}));

export const CompactionProjectionInstallationReceiptSchema = Type.Unsafe<CompactionProjectionInstallationReceipt>(exact({
	schemaVersion: Type.Literal(COMPACTION_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sessionId: id("session"),
	receiptId: id("receipt"),
	state: Type.Literal(COMPACTION_INSTALLATION_STATES[2]),
	checkpointId: id("checkpoint"),
	checkpointDigest: digest,
	replacementHistoryArtifact: ArtifactRefSchema,
	replacementHistoryDigest: digest,
	expectedProjectionRevision: count,
	installedProjectionRevision: count,
	previousProjectionDigest: digest,
	projectionDigest: digest,
	installedAt: timestamp,
	receiptDigest: digest,
}));

const suppressionBase = {
	schemaVersion: Type.Literal(COMPACTION_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	receiptId: id("receipt"),
	compactionId: id("compaction"),
	sessionId: id("session"),
} as const;

export const CompactionSuppressionReceiptSchema = Type.Unsafe<CompactionSuppressionReceipt>(exact({
	...suppressionBase,
	reason: literals(COMPACTION_SUPPRESSION_REASONS),
	attemptDigest: digest,
	suppressedAt: timestamp,
}));

const attemptBase = { ...suppressionBase, attemptDigest: digest } as const;
export const CompactionAttemptReceiptSchema = Type.Unsafe<CompactionAttemptReceipt>(Type.Union([
	exact({ ...attemptBase, status: Type.Literal("started"), startedAt: timestamp }),
	exact({
		...attemptBase,
		status: Type.Literal("completed"),
		checkpoint: CompactionCheckpointRefSchema,
		completedAt: timestamp,
	}),
	exact({
		...attemptBase,
		status: Type.Literal("failed"),
		errorCode: token,
		errorDigest: digest,
		originalProjectionDigest: digest,
		failedAt: timestamp,
	}),
	exact({
		...attemptBase,
		status: Type.Literal("suppressed"),
		suppression: CompactionSuppressionReceiptSchema,
	}),
]));

function sameScope(
	value: { authorityId: string; tenantId: string },
	child: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === child.authorityId && value.tenantId === child.tenantId;
}

function validCut(cut: CompactionCut): boolean {
	return cut.sourceFromSequence <= cut.sourceToSequence && cut.retainedFromSequence === cut.sourceToSequence + 1;
}

function validInvariant(value: CompactionInvariantSnapshot): boolean {
	return (
		sameScope(value, value.workspace) &&
		(value.approvedPlan === undefined || (sameScope(value, value.approvedPlan) && isApprovedPlanRef(value.approvedPlan))) &&
		value.inputSources.every((source) => sameScope(value, source) && isInputSourceRef(source)) &&
		value.declassificationReceipts.every(
			(receipt) => sameScope(value, receipt) && isDeclassificationReceiptRef(receipt),
		)
	);
}

export function isCompactionCut(value: unknown): value is CompactionCut {
	return Check(CompactionCutSchema, value) && validCut(value);
}

export function isCompactionInvariantSnapshot(value: unknown): value is CompactionInvariantSnapshot {
	return Check(CompactionInvariantSnapshotSchema, value) && validInvariant(value);
}

export function isCompactionValidationResult(value: unknown): value is CompactionValidationResult {
	return Check(CompactionValidationResultSchema, value);
}

export function isCompactionRecoveryCandidate(value: unknown): value is CompactionRecoveryCandidate {
	return Check(CompactionRecoveryCandidateSchema, value);
}

export function isCompactionRecoveryAssessment(value: unknown): value is CompactionRecoveryAssessment {
	return Check(CompactionRecoveryAssessmentSchema, value);
}

export function isCompactionCheckpointRef(value: unknown): value is CompactionCheckpointRef {
	return (
		Check(CompactionCheckpointRefSchema, value) &&
		value.sourceFromSequence <= value.sourceToSequence &&
		value.retainedFromSequence === value.sourceToSequence + 1 &&
		value.survivingSuffixFromSequence === value.retainedFromSequence &&
		sameScope(value, value.summaryArtifact) &&
		sameScope(value, value.replacementHistoryArtifact) &&
		value.summaryArtifact.storedDigest === value.summaryDigest &&
		((value.previousCheckpointId === undefined && value.previousCheckpointDigest === undefined &&
			value.previousReplacementHistoryDigest === undefined) ||
			(value.previousCheckpointId !== undefined && value.previousCheckpointDigest !== undefined &&
				value.previousReplacementHistoryDigest !== undefined))
	);
}

export function isCompactionCheckpoint(value: unknown): value is CompactionCheckpoint {
	if (!Check(CompactionCheckpointSchema, value)) return false;
	if (!validCut(value.cut) || !validInvariant(value.invariantsBefore) || !validInvariant(value.invariantsAfter)) return false;
	if (
		!sameScope(value, value.inputArtifact) ||
		!sameScope(value, value.summaryArtifact) ||
		!sameScope(value, value.replacementHistoryArtifact) ||
		value.summaryArtifact.storedDigest !== value.summaryDigest ||
		value.survivingSuffixFromSequence !== value.cut.retainedFromSequence ||
		value.invariantsBefore.sessionId !== value.sessionId ||
		value.invariantsAfter.sessionId !== value.sessionId ||
		value.invariantsBefore.invariantDigest !== value.invariantsAfter.invariantDigest ||
		value.invariantsBefore.toolPairingDigest !== value.cut.toolPairingDigest ||
		canonicalDigest(value.invariantsBefore.inputSources) !== canonicalDigest(value.invariantsAfter.inputSources) ||
		canonicalDigest(value.invariantsBefore.declassificationReceipts) !==
			canonicalDigest(value.invariantsAfter.declassificationReceipts) ||
		value.postEstimatedTokens > value.preEstimatedTokens ||
		value.postEstimatedTokens > value.maxSummaryTokens + value.cut.completedTurnCount * value.maxSummaryTokens
	) {
		return false;
	}
	if (value.validation.outcome !== "valid") return false;
	if (value.previousCheckpoint !== undefined) {
		if (!isCompactionCheckpointRef(value.previousCheckpoint) || !sameScope(value, value.previousCheckpoint)) return false;
		if (value.previousCheckpoint.sessionId !== value.sessionId) return false;
		if (value.previousCheckpoint.sourceToSequence >= value.cut.sourceFromSequence) return false;
		if (value.previousReplacementHistoryDigest !== value.previousCheckpoint.replacementHistoryDigest) return false;
	} else if (value.previousReplacementHistoryDigest !== undefined) {
		return false;
	}
	return value.cut.offloadedArtifacts.every((artifact) => sameScope(value, artifact));
}

function installationReceiptBody(
	value: CompactionProjectionInstallationReceipt,
): Omit<CompactionProjectionInstallationReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = value;
	return body;
}

export function isCompactionProjectionInstallationReceipt(
	value: unknown,
): value is CompactionProjectionInstallationReceipt {
	if (!Check(CompactionProjectionInstallationReceiptSchema, value)) return false;
	return (
		sameScope(value, value.replacementHistoryArtifact) &&
		value.installedProjectionRevision === value.expectedProjectionRevision + 1 &&
		value.receiptDigest === canonicalDigest(installationReceiptBody(value))
	);
}

export function isCompactionSuppressionReceipt(value: unknown): value is CompactionSuppressionReceipt {
	return Check(CompactionSuppressionReceiptSchema, value);
}

export function isCompactionAttemptReceipt(value: unknown): value is CompactionAttemptReceipt {
	if (!Check(CompactionAttemptReceiptSchema, value)) return false;
	if (value.status === "completed") {
		return sameScope(value, value.checkpoint) && value.checkpoint.compactionId === value.compactionId &&
		value.checkpoint.sessionId === value.sessionId && isCompactionCheckpointRef(value.checkpoint);
	}
	if (value.status === "suppressed") {
		return sameScope(value, value.suppression) && value.suppression.compactionId === value.compactionId &&
		value.suppression.sessionId === value.sessionId && value.suppression.attemptDigest === value.attemptDigest;
	}
	return true;
}
