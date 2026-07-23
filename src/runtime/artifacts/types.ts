/** Artifact CAS、脱敏、保留策略与 checkpoint 的公共类型。 */

import type {
	ArtifactKind,
	ArtifactRedactionClass,
	ArtifactRef,
	CapabilityName,
} from "../protocol/v3/capability.ts";
import type {
	DeclassificationReceiptRef,
	InputSourceRef,
	TaintLabel,
	TaintSink,
} from "../protocol/v3/taint.ts";
import type { EventCursor, IntegrityStatus, AttestationStatus } from "../protocol/v3/events.ts";
import type {
	AgentId,
	ApprovalId,
	ArtifactId,
	AuthorityId,
	CheckpointId,
	CommandId,
	EpisodeSealId,
	LeafId,
	PrincipalId,
	ReceiptId,
	RepositoryId,
	ResourceId,
	SessionId,
	TenantId,
	VerificationId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";
import type { WorkspaceCheckpointDescriptor, WorkspaceExecutionEnvelope } from "../protocol/v3/workspace.ts";

export const ARTIFACT_METADATA_SCHEMA_VERSION = 1 as const;
export const EPISODE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const EPISODE_SEAL_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_SNAPSHOT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const COMPOSITE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION = 1 as const;

export type ArtifactCompression = "none" | "gzip";
export type ArtifactEvidenceStatus = "verified_transform" | "legacy_unverified";
export type ArtifactKeyState = "available" | "unavailable" | "lost" | "rotating";
export type ArtifactLineageOrigin = "internal" | "user" | "external" | "candidate" | "model_derived" | "legacy";
export type ArtifactLineageStatus = "verified" | "quarantined" | "legacy_unverified";

export interface ArtifactScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export interface ArtifactSource {
	sessionId: SessionId;
	workspaceId?: WorkspaceId;
	producerId: AgentId | PrincipalId;
}

export type ArtifactSourceReceipt =
	| {
		status: "protected";
		scheme: "hmac-sha256";
		keyVersion: string;
		digest: string;
	}
	| {
		status: "unavailable";
		reason: "key_provider_unavailable" | "key_lost" | "key_rotating";
	}
	| {
		status: "legacy_unverified";
		reason: "legacy_tmp_import";
	};

export interface ArtifactRedactionPolicyRef {
	policyId: string;
	version: number;
}

export interface ArtifactTransformReceipt {
	receiptId: ReceiptId;
	receiptDigest: string;
	policy: ArtifactRedactionPolicyRef;
	redaction: ArtifactRedactionClass;
	replacementCount: number;
	sourceReceipt: ArtifactSourceReceipt;
	keyState: ArtifactKeyState;
}

export interface ArtifactEncryptionMetadata {
	algorithm: "aes-256-gcm";
	keyVersion: string;
	envelopeVersion: 1;
}

export interface ArtifactLegalHold {
	status: "none" | "active";
	reasonDigest?: string;
}

export interface ArtifactLineageInput {
	origin: Exclude<ArtifactLineageOrigin, "legacy">;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export interface ArtifactLineage {
	origin: ArtifactLineageOrigin;
	status: ArtifactLineageStatus;
	inputSources: readonly InputSourceRef[];
	taintUpperBound: readonly TaintLabel[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	lineageDigest: string;
}

export interface ArtifactMetadataBody extends ArtifactScope {
	schemaVersion: typeof ARTIFACT_METADATA_SCHEMA_VERSION;
	artifactId: ArtifactId;
	intentId: CommandId;
	state: "pending" | "committed";
	kind: ArtifactKind;
	mediaType: string;
	originalSize: number;
	storedSize: number;
	compression: ArtifactCompression;
	storedDigest: string;
	source: ArtifactSource;
	sourceReceipt: ArtifactSourceReceipt;
	redaction: ArtifactRedactionClass;
	redactionPolicy: ArtifactRedactionPolicyRef;
	transformReceipt: ArtifactTransformReceipt;
	lineage: ArtifactLineage;
	encryption?: ArtifactEncryptionMetadata;
	references: readonly ArtifactId[];
	expiresAt?: string;
	pins: readonly string[];
	referenceCount: number;
	legalHold: ArtifactLegalHold;
	evidenceStatus: ArtifactEvidenceStatus;
	createdAt: string;
	committedAt?: string;
}

export interface ArtifactMetadata extends ArtifactMetadataBody {
	metadataDigest: string;
}

export interface ArtifactRetentionInput {
	expiresAt?: string;
	pins?: readonly string[];
	referenceCount?: number;
	legalHold?: ArtifactLegalHold;
}

export interface ArtifactWriteRequest extends ArtifactScope {
	artifactId: ArtifactId;
	intentId: CommandId;
	principalId: PrincipalId;
	source: ArtifactSource;
	kind: ArtifactKind;
	mediaType: string;
	content: string | Uint8Array;
	compression?: ArtifactCompression;
	references?: readonly ArtifactId[];
	retention?: ArtifactRetentionInput;
	redaction?: "default" | "metadata_only" | "forensic";
	forensicAuthorization?: {
		approvalId: ApprovalId;
		purpose: string;
	};
	/** 未提供 lineage 时按 unknown external 输入隔离，不能进入危险 sink 或 Verification pass。 */
	lineage?: ArtifactLineageInput;
	createdAt?: string;
}

export interface ArtifactIntentRecord extends ArtifactScope {
	intentId: CommandId;
	artifactId: ArtifactId;
	sessionId: SessionId;
	workspaceId?: WorkspaceId;
	producerId: AgentId | PrincipalId;
	kind: ArtifactKind;
	mediaType: string;
	lineageDigest: string;
	createdAt: string;
}

export interface ArtifactCommitRecord extends ArtifactScope {
	intentId: CommandId;
	artifactId: ArtifactId;
	storedDigest: string;
	storedSize: number;
	metadataDigest: string;
	transformReceiptId: ReceiptId;
	committedAt: string;
}

export type ArtifactAbortReason = "staging_failed" | "metadata_failed" | "reconciled_rollback";

export interface ArtifactAbortRecord extends ArtifactScope {
	intentId: CommandId;
	artifactId: ArtifactId;
	reason: ArtifactAbortReason;
	reasonDigest: string;
	abortedAt: string;
}

export type ArtifactJournalState =
	| { state: "absent" }
	| { state: "intent_recorded"; intent: ArtifactIntentRecord }
	| { state: "aborted"; intent: ArtifactIntentRecord; abort: ArtifactAbortRecord }
	| { state: "committed"; intent: ArtifactIntentRecord; commit: ArtifactCommitRecord };

export interface ArtifactEventJournalPort {
	recordIntent(intent: ArtifactIntentRecord): Promise<ArtifactResult<void>>;
	recordCommit(commit: ArtifactCommitRecord): Promise<ArtifactResult<void>>;
	recordAbort(abort: ArtifactAbortRecord): Promise<ArtifactResult<void>>;
	stateForIntent(intentId: CommandId): Promise<ArtifactResult<ArtifactJournalState>>;
	listOpenIntents(scope: ArtifactScope): Promise<ArtifactResult<readonly ArtifactIntentRecord[]>>;
}

export const ARTIFACT_ERROR_CODES = [
	"invalid_request",
	"authorization_denied",
	"authorization_unavailable",
	"key_unavailable",
	"redaction_failed",
	"durable_write_failed",
	"metadata_write_failed",
	"not_found",
	"digest_mismatch",
	"not_committed",
	"corrupted_metadata",
	"fenced",
] as const;

export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number];

export interface ArtifactError {
	code: ArtifactErrorCode;
	message: string;
	retryable: boolean;
	details?: Readonly<Record<string, string | number | boolean>>;
}

export type ArtifactResult<T> = { ok: true; value: T } | { ok: false; error: ArtifactError };

export interface ArtifactWriteOutcome {
	state: "committed" | "pending";
	metadata: ArtifactMetadata;
	reference?: ArtifactRef;
}

export const ARTIFACT_EXTERNAL_DELIVERY_STATES = [
	"accepted_enqueued",
	"durable",
	"content_verified",
	"externally_acknowledged",
	"failed",
] as const;

export type ArtifactExternalDeliveryState =
	(typeof ARTIFACT_EXTERNAL_DELIVERY_STATES)[number];

interface ArtifactExternalDeliveryReceiptCommon extends ArtifactScope {
	schemaVersion: typeof ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION;
	deliveryId: CommandId;
	receiptId: ReceiptId;
	artifact: ArtifactRef;
	destinationId: ResourceId;
	destinationDigest: string;
	revision: number;
	recordedAt: string;
	receiptDigest: string;
}

/**
 * accepted_enqueued 只证明外部系统接受了请求。后续每一步都必须引用前一份
 * receipt；只有 externally_acknowledged 能作为 Episode evidence 或本地清理依据。
 */
export type ArtifactExternalDeliveryReceipt =
	| (ArtifactExternalDeliveryReceiptCommon & {
			state: "accepted_enqueued";
			revision: 0;
	  })
	| (ArtifactExternalDeliveryReceiptCommon & {
			state: "durable";
			previousState: "accepted_enqueued";
			previousReceiptDigest: string;
			storageReceiptDigest: string;
			remoteObjectDigest: string;
	  })
	| (ArtifactExternalDeliveryReceiptCommon & {
			state: "content_verified";
			previousState: "durable";
			previousReceiptDigest: string;
			verifiedContentDigest: string;
			verificationReceiptDigest: string;
	  })
	| (ArtifactExternalDeliveryReceiptCommon & {
			state: "externally_acknowledged";
			previousState: "content_verified";
			previousReceiptDigest: string;
			externalAcknowledgementDigest: string;
	  })
	| (ArtifactExternalDeliveryReceiptCommon & {
			state: "failed";
			previousState: Exclude<ArtifactExternalDeliveryState, "externally_acknowledged" | "failed">;
			previousReceiptDigest: string;
			failureCode: string;
			failureDigest: string;
	  });

export interface ArtifactExternalDeliveryProjection extends ArtifactScope {
	schemaVersion: typeof ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION;
	deliveryId: CommandId;
	artifact: ArtifactRef;
	destinationId: ResourceId;
	destinationDigest: string;
	state: ArtifactExternalDeliveryState;
	revision: number;
	lastReceiptDigest: string;
	acceptedAt: string;
	durableAt?: string;
	contentVerifiedAt?: string;
	externallyAcknowledgedAt?: string;
	failedAt?: string;
	remoteObjectDigest?: string;
	verifiedContentDigest?: string;
	externalAcknowledgementDigest?: string;
	failureDigest?: string;
	projectionDigest: string;
}

export interface ArtifactCapabilityRequest extends ArtifactScope {
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId?: WorkspaceId;
	artifact: ArtifactRef;
	capability: CapabilityName;
	operation: "read" | "read_forensic";
	inputSources: readonly InputSourceRef[];
	targetSink: TaintSink;
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	requestDigest: string;
}

export interface ArtifactCapabilityDecision extends ArtifactScope {
	decision: "allow" | "ask" | "deny" | "unavailable";
	receiptId?: ReceiptId;
	receiptDigest?: string;
}

export interface ArtifactCapabilityGatewayPort {
	recheckArtifactAccess(request: ArtifactCapabilityRequest): Promise<ArtifactResult<ArtifactCapabilityDecision>>;
}

export interface ArtifactAccessLogEntry extends ArtifactScope {
	artifactId: ArtifactId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId?: WorkspaceId;
	operation: "read" | "read_forensic";
	decision: "allowed" | "denied" | "unavailable";
	purposeDigest?: string;
	timestamp: string;
}

export interface ArtifactAccessLogPort {
	append(entry: ArtifactAccessLogEntry): Promise<ArtifactResult<void>>;
}

export interface ArtifactReadRequest extends ArtifactScope {
	artifactId: ArtifactId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId?: WorkspaceId;
	capability: CapabilityName;
	targetSink?: TaintSink;
	declassificationReceipts?: readonly DeclassificationReceiptRef[];
	forensicPurpose?: string;
}

export interface ArtifactReadResult {
	metadata: ArtifactMetadata;
	content: Uint8Array;
	authorizationReceiptId?: ReceiptId;
}

export type WorkspaceEntryKind = "regular" | "executable" | "symlink" | "submodule";

export interface WorkspaceTrackedEntry {
	pathDigest: string;
	kind: WorkspaceEntryKind;
	mode: string;
	contentArtifact?: ArtifactRef;
	symlinkTarget?: string;
	status: "unchanged" | "added" | "modified" | "deleted" | "type_changed";
}

export interface WorkspaceConflictEntry {
	pathDigest: string;
	base?: ArtifactRef;
	ours?: ArtifactRef;
	theirs?: ArtifactRef;
}

export interface WorkspaceSubmoduleEntry {
	pathDigest: string;
	commit: string;
	status: "clean" | "dirty" | "missing";
}

export interface WorkspaceLfsEntry {
	pathDigest: string;
	oid: string;
	size: number;
	status: "available" | "missing" | "pointer_only";
	contentArtifact?: ArtifactRef;
}

export type WorkspaceSnapshotPartialReason =
	| "ignored_excluded"
	| "policy_excluded"
	| "dirty_submodule"
	| "missing_lfs_object"
	| "size_limit"
	| "unrepresentable_entry";

export interface WorkspaceSnapshotExclusion {
	pathDigest: string;
	reason: WorkspaceSnapshotPartialReason;
	detailDigest: string;
}

export interface WorkspaceSnapshotManifest extends ArtifactScope {
	schemaVersion: typeof WORKSPACE_SNAPSHOT_MANIFEST_SCHEMA_VERSION;
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	baseCommit: string;
	headCommit: string;
	rawIndexArtifact: ArtifactRef;
	stagedDiffArtifact?: ArtifactRef;
	unstagedDiffArtifact?: ArtifactRef;
	tracked: readonly WorkspaceTrackedEntry[];
	untracked: readonly WorkspaceTrackedEntry[];
	conflicts: readonly WorkspaceConflictEntry[];
	submodules: readonly WorkspaceSubmoduleEntry[];
	lfsObjects: readonly WorkspaceLfsEntry[];
	exclusions: readonly WorkspaceSnapshotExclusion[];
	completeness: "complete" | "partial";
	partialReasons: readonly WorkspaceSnapshotPartialReason[];
	capturedAt: string;
	manifestDigest: string;
}

export interface CompositeCheckpointBody extends ArtifactScope {
	schemaVersion: typeof COMPOSITE_CHECKPOINT_SCHEMA_VERSION;
	checkpointId: CheckpointId;
	logical: {
		cursor: EventCursor;
		reducerDigest: string;
		activeLeafId: LeafId;
	};
	workspace: WorkspaceCheckpointDescriptor;
	workspaceSnapshotManifestRef: ArtifactRef;
	diffArtifacts: readonly ArtifactRef[];
	untrackedArtifacts: readonly ArtifactRef[];
	completeness: "complete" | "partial";
	partialReasons: readonly WorkspaceSnapshotPartialReason[];
	createdAt: string;
}

export interface CompositeCheckpoint extends CompositeCheckpointBody {
	checkpointDigest: string;
}

export interface CompositeCheckpointRef extends ArtifactScope {
	checkpointId: CheckpointId;
	checkpointDigest: string;
	workspaceId: WorkspaceId;
	completeness: "complete" | "partial";
}

export interface WorkspaceRewindReceipt extends ArtifactScope {
	receiptId: ReceiptId;
	checkpointId: CheckpointId;
	workspaceId: WorkspaceId;
	expectedLeaseRevision: number;
	targetLeafId: LeafId;
	outcome: "applied" | "failed" | "interrupted" | "fenced";
	receiptDigest: string;
}

export interface WorkspaceCleanupReceipt extends ArtifactScope {
	receiptId: ReceiptId;
	checkpointId: CheckpointId;
	workspaceId: WorkspaceId;
	expectedLeaseRevision: number;
	state: "pending_gc" | "completed" | "failed" | "fenced";
	receiptDigest: string;
}

export interface WorkspaceCheckpointPort {
	rewind(request: {
		checkpoint: CompositeCheckpointRef;
		envelope: WorkspaceExecutionEnvelope;
		expectedLeaseRevision: number;
		targetLeafId: LeafId;
	}): Promise<ArtifactResult<WorkspaceRewindReceipt>>;
	cleanup(request: {
		checkpoint: CompositeCheckpointRef;
		envelope: WorkspaceExecutionEnvelope;
		expectedLeaseRevision: number;
	}): Promise<ArtifactResult<WorkspaceCleanupReceipt>>;
}

export interface EpisodeManifestBody extends ArtifactScope {
	schemaVersion: typeof EPISODE_MANIFEST_SCHEMA_VERSION;
	sessionId: SessionId;
	principalId: PrincipalId;
	/** Manifest 只固定 seal 之前的证据链 head，不能引用其自身 commit 或 seal event。 */
	evidenceHead: EventCursor;
	integrity: IntegrityStatus;
	attestation: AttestationStatus;
	workspace: {
		workspaceId: WorkspaceId;
		repositoryId: RepositoryId;
		baseCommit: string;
		headCommit?: string;
	};
	artifacts: readonly ArtifactRef[];
	/** 仅允许已经 content-verified 且被外部明确确认的投递进入证据封存。 */
	externalDeliveries: readonly ArtifactExternalDeliveryProjection[];
	permissionReceiptIds: readonly ReceiptId[];
	approvalIds: readonly ApprovalId[];
	cost: {
		status: "unavailable" | "partial" | "complete";
		totalUsd?: number;
	};
	verification: {
		status: "not_run" | "partial" | "complete";
		verificationIds: readonly VerificationId[];
	};
	artifactSecurity: {
		keyState: ArtifactKeyState;
		degraded: boolean;
		legacyUnverifiedCount: number;
	};
	createdAt: string;
}

export interface EpisodeManifest extends EpisodeManifestBody {
	manifestDigest: string;
}

export interface EpisodeSealSignerIdentity {
	issuerId: string;
	schemaVersion: number;
	algorithm: "ed25519" | "hmac-sha256";
	keyId: string;
	issuedAt: string;
}

export interface EpisodeSealSignerAttestation extends EpisodeSealSignerIdentity {
	signature: string;
}

/**
 * Seal 只向后引用已 durable 的 Manifest commit。signature 输入排除 signature
 * 自身，sealDigest 则覆盖完整 attestation，因此不会形成 digest 自引用。
 */
export interface EpisodeSealBody extends ArtifactScope {
	schemaVersion: typeof EPISODE_SEAL_SCHEMA_VERSION;
	sealId: EpisodeSealId;
	sessionId: SessionId;
	manifestBodyDigest: string;
	evidenceHead: EventCursor;
	manifestCommitCursor: EventCursor;
	referenceClosureDigest: string;
	verificationReceiptDigests: readonly string[];
	signerAttestation: EpisodeSealSignerAttestation;
}

export interface EpisodeSeal extends EpisodeSealBody {
	sealDigest: string;
}
