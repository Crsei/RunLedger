/** Evidence passive contract 的 exact schemas 与 guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { ArtifactRefSchema, isArtifactRef } from "../protocol/capability.ts";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import { RuntimeEventRangeRefSchema, isRuntimeEventRangeRef } from "../protocol/schemas.ts";
import { WorkspaceCheckpointDescriptorSchema, isWorkspaceCheckpointDescriptor } from "../protocol/workspace.ts";
import { AdapterIdentityRefSchema } from "./control-telemetry-schemas.ts";
import type {
	ArtifactCommitReceipt,
	ArtifactIntent,
	ChangeProposal,
	CompositeCheckpoint,
	EpisodeManifestBody,
	EpisodeSeal,
	FindingRecord,
	ProjectionCheckpoint,
	VerificationRequest,
	VerificationResult,
} from "./evidence.ts";

const ArtifactKindSchema = Type.Union([
	Type.Literal("diff"),
	Type.Literal("tool_output"),
	Type.Literal("log"),
	Type.Literal("test_report"),
	Type.Literal("screenshot"),
	Type.Literal("session_report"),
]);

export const ArtifactIntentSchema = Type.Object(
	{
		intentId: RuntimeIdSchema,
		subjectId: RuntimeIdSchema,
		sourceDigest: RuntimeDigestSchema,
		targetKind: ArtifactKindSchema,
		retentionPolicyDigest: RuntimeDigestSchema,
		accessPolicyDigest: RuntimeDigestSchema,
		idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9._:-]+$", minLength: 1, maxLength: 128 }),
		traceId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

export const ArtifactCommitReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		intentId: RuntimeIdSchema,
		artifact: ArtifactRefSchema,
		contentVerification: Type.Union([
			Type.Literal("verified"),
			Type.Literal("mismatch"),
			Type.Literal("unavailable"),
		]),
		keyAccessRef: RuntimeContentRefSchema,
		outcome: Type.Union([Type.Literal("durable"), Type.Literal("rejected"), Type.Literal("uncertain")]),
		committedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const ProjectionCheckpointSchema = Type.Object(
	{
		snapshotId: RuntimeIdSchema,
		sourceRange: RuntimeEventRangeRefSchema,
		projectionKind: Type.Union([
			Type.Literal("session"),
			Type.Literal("goal"),
			Type.Literal("task"),
			Type.Literal("queue"),
			Type.Literal("agent_graph"),
			Type.Literal("resource"),
			Type.Literal("context"),
		]),
		projectionDigest: RuntimeDigestSchema,
		artifactRef: RuntimeContentRefSchema,
		builtAt: CanonicalUtcTimestampSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	},
	{ additionalProperties: false },
);

export const CompositeCheckpointSchema = Type.Object(
	{
		snapshotId: RuntimeIdSchema,
		eventHead: RuntimeStreamHeadSchema,
		workspaceCheckpoint: WorkspaceCheckpointDescriptorSchema,
		artifacts: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
		workspaceStatusDigest: RuntimeDigestSchema,
		dirtyCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		untrackedCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		conflictCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		builtAt: CanonicalUtcTimestampSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	},
	{ additionalProperties: false },
);

export const EpisodeManifestBodySchema = Type.Object(
	{
		sessionId: RuntimeIdSchema,
		eventHeads: Type.Array(RuntimeStreamHeadSchema, { minItems: 1, maxItems: 64 }),
		workspaceCheckpoints: Type.Array(WorkspaceCheckpointDescriptorSchema, { maxItems: 64 }),
		artifacts: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
		permissionRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 256 }),
		costRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 256 }),
		verificationRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 256 }),
		retentionGraphDigest: RuntimeDigestSchema,
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const EpisodeSealSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		manifestDigest: RuntimeDigestSchema,
		terminalEventRef: RuntimeContentRefSchema,
		signerAttestationRef: RuntimeContentRefSchema,
		verificationOutcome: Type.Union([
			Type.Literal("verified"),
			Type.Literal("invalid"),
			Type.Literal("unavailable"),
		]),
		sealedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const VerificationRequestSchema = Type.Object(
	{
		requestId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
		candidateDigest: RuntimeDigestSchema,
		baselineDigest: Type.Optional(RuntimeDigestSchema),
		gateManifestRef: RuntimeContentRefSchema,
		runnerRequirementDigest: RuntimeDigestSchema,
		traceId: RuntimeIdSchema,
	},
	{ additionalProperties: false },
);

export const VerificationResultSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		requestId: RuntimeIdSchema,
		outcome: Type.Union([
			Type.Literal("pass"),
			Type.Literal("fail"),
			Type.Literal("error"),
			Type.Literal("unsupported"),
		]),
		runner: AdapterIdentityRefSchema,
		evidenceRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 256 }),
		findingIds: Type.Array(RuntimeIdSchema, { maxItems: 256 }),
		resultDigest: RuntimeDigestSchema,
		finishedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const FindingRecordSchema = Type.Object(
	{
		findingId: RuntimeIdSchema,
		severity: Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("critical"),
		]),
		status: Type.Union([
			Type.Literal("open"),
			Type.Literal("acknowledged"),
			Type.Literal("resolved"),
			Type.Literal("dismissed"),
		]),
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		locationRef: RuntimeContentRefSchema,
		evidenceRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 256 }),
		resolutionRef: Type.Optional(RuntimeContentRefSchema),
		findingDigest: RuntimeDigestSchema,
	},
	{ additionalProperties: false },
);

export const ChangeProposalSchema = Type.Object(
	{
		proposalId: RuntimeIdSchema,
		sessionId: RuntimeIdSchema,
		baseDigest: RuntimeDigestSchema,
		candidateDigest: RuntimeDigestSchema,
		diffRef: RuntimeContentRefSchema,
		verificationSummaryRef: RuntimeContentRefSchema,
		requestedAction: Type.Union([Type.Literal("human_review"), Type.Literal("draft_pr")]),
		proposalDigest: RuntimeDigestSchema,
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export function isArtifactIntent(value: unknown): value is ArtifactIntent {
	if (!Value.Check(ArtifactIntentSchema, value)) return false;
	return isRuntimeId(value.intentId, "command") && isRuntimeId(value.subjectId) && isRuntimeId(value.traceId, "trace");
}

export function isArtifactCommitReceipt(value: unknown): value is ArtifactCommitReceipt {
	if (!Value.Check(ArtifactCommitReceiptSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.intentId, "command") &&
		isArtifactRef(value.artifact) &&
		isCanonicalUtcTimestamp(value.committedAt)
	);
}

export function isProjectionCheckpoint(value: unknown): value is ProjectionCheckpoint {
	if (!Value.Check(ProjectionCheckpointSchema, value)) return false;
	return isRuntimeId(value.snapshotId, "snapshot") && isRuntimeEventRangeRef(value.sourceRange) && isCanonicalUtcTimestamp(value.builtAt);
}

export function isCompositeCheckpoint(value: unknown): value is CompositeCheckpoint {
	if (!Value.Check(CompositeCheckpointSchema, value)) return false;
	return (
		isRuntimeId(value.snapshotId, "snapshot") &&
		isWorkspaceCheckpointDescriptor(value.workspaceCheckpoint) &&
		value.artifacts.every(isArtifactRef) &&
		isCanonicalUtcTimestamp(value.builtAt)
	);
}

export function isEpisodeManifestBody(value: unknown): value is EpisodeManifestBody {
	if (!Value.Check(EpisodeManifestBodySchema, value)) return false;
	return (
		isRuntimeId(value.sessionId, "session") &&
		value.eventHeads.some((head) => head.streamId === value.sessionId) &&
		value.workspaceCheckpoints.every(isWorkspaceCheckpointDescriptor) &&
		value.artifacts.every(isArtifactRef) &&
		isCanonicalUtcTimestamp(value.createdAt)
	);
}

export function isEpisodeSeal(value: unknown): value is EpisodeSeal {
	if (!Value.Check(EpisodeSealSchema, value)) return false;
	return isRuntimeId(value.receiptId, "receipt") && isCanonicalUtcTimestamp(value.sealedAt);
}

export function isVerificationRequest(value: unknown): value is VerificationRequest {
	if (!Value.Check(VerificationRequestSchema, value)) return false;
	return isRuntimeId(value.requestId, "command") && isRuntimeId(value.sessionId, "session") && isRuntimeId(value.traceId, "trace");
}

export function isVerificationResult(value: unknown): value is VerificationResult {
	if (!Value.Check(VerificationResultSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		isRuntimeId(value.requestId, "command") &&
		value.findingIds.every((id) => isRuntimeId(id, "finding")) &&
		isCanonicalUtcTimestamp(value.finishedAt)
	);
}

export function isFindingRecord(value: unknown): value is FindingRecord {
	if (!Value.Check(FindingRecordSchema, value)) return false;
	return isRuntimeId(value.findingId, "finding");
}

export function isChangeProposal(value: unknown): value is ChangeProposal {
	if (!Value.Check(ChangeProposalSchema, value)) return false;
	return isRuntimeId(value.proposalId, "proposal") && isRuntimeId(value.sessionId, "session") && isCanonicalUtcTimestamp(value.createdAt);
}
