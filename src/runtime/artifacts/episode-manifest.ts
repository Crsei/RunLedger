/** Episode、WorkspaceSnapshot 与 CompositeCheckpoint 的版本化 manifest。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import { sameRuntimeEventStream } from "../protocol/v3/events.ts";
import { EventCursorSchema } from "../protocol/v3/event-references.ts";
import { createRuntimeId, type LeafId } from "../protocol/v3/ids.ts";
import { isWorkspaceCheckpointDescriptor } from "../protocol/v3/workspace.ts";
import type { LogicalCheckpoint } from "../session/checkpoint.ts";
import {
	ArtifactExternalDeliveryProjectionSchema,
	artifactDeliveryMayEnterEpisodeEvidence,
} from "./external-delivery.ts";
import {
	COMPOSITE_CHECKPOINT_SCHEMA_VERSION,
	EPISODE_MANIFEST_SCHEMA_VERSION,
	EPISODE_SEAL_SCHEMA_VERSION,
	WORKSPACE_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
	type ArtifactError,
	type ArtifactKeyState,
	type ArtifactResult,
	type CompositeCheckpoint,
	type CompositeCheckpointBody,
	type CompositeCheckpointRef,
	type EpisodeManifest,
	type EpisodeManifestBody,
	type EpisodeSeal,
	type EpisodeSealBody,
	type EpisodeSealSignerIdentity,
	type WorkspaceCheckpointPort,
	type WorkspaceCleanupReceipt,
	type WorkspaceRewindReceipt,
	type WorkspaceSnapshotManifest,
	type WorkspaceSnapshotPartialReason,
} from "./types.ts";

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });

const PartialReasonSchema = Type.Union([
	Type.Literal("ignored_excluded"),
	Type.Literal("policy_excluded"),
	Type.Literal("dirty_submodule"),
	Type.Literal("missing_lfs_object"),
	Type.Literal("size_limit"),
	Type.Literal("unrepresentable_entry"),
]);

const WorkspaceEntrySchema = exact({
	pathDigest: digest,
	kind: Type.Union([Type.Literal("regular"), Type.Literal("executable"), Type.Literal("symlink"), Type.Literal("submodule")]),
	mode: Type.String({ minLength: 1, maxLength: 16 }),
	contentArtifact: Type.Optional(ArtifactRefSchema),
	symlinkTarget: Type.Optional(Type.String({ maxLength: 4096 })),
	status: Type.Union([
		Type.Literal("unchanged"),
		Type.Literal("added"),
		Type.Literal("modified"),
		Type.Literal("deleted"),
		Type.Literal("type_changed"),
	]),
});

const WorkspaceConflictSchema = exact({
	pathDigest: digest,
	base: Type.Optional(ArtifactRefSchema),
	ours: Type.Optional(ArtifactRefSchema),
	theirs: Type.Optional(ArtifactRefSchema),
});

const WorkspaceSubmoduleSchema = exact({
	pathDigest: digest,
	commit: token,
	status: Type.Union([Type.Literal("clean"), Type.Literal("dirty"), Type.Literal("missing")]),
});

const WorkspaceLfsSchema = exact({
	pathDigest: digest,
	oid: token,
	size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	status: Type.Union([Type.Literal("available"), Type.Literal("missing"), Type.Literal("pointer_only")]),
	contentArtifact: Type.Optional(ArtifactRefSchema),
});

const WorkspaceExclusionSchema = exact({ pathDigest: digest, reason: PartialReasonSchema, detailDigest: digest });

const WorkspaceSnapshotManifestBodySchema = exact({
	schemaVersion: Type.Literal(WORKSPACE_SNAPSHOT_MANIFEST_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	workspaceId: runtimeId("workspace"),
	repositoryId: runtimeId("repository"),
	baseCommit: token,
	headCommit: token,
	rawIndexArtifact: ArtifactRefSchema,
	stagedDiffArtifact: Type.Optional(ArtifactRefSchema),
	unstagedDiffArtifact: Type.Optional(ArtifactRefSchema),
	tracked: Type.Array(WorkspaceEntrySchema, { maxItems: 100_000 }),
	untracked: Type.Array(WorkspaceEntrySchema, { maxItems: 100_000 }),
	conflicts: Type.Array(WorkspaceConflictSchema, { maxItems: 100_000 }),
	submodules: Type.Array(WorkspaceSubmoduleSchema, { maxItems: 10_000 }),
	lfsObjects: Type.Array(WorkspaceLfsSchema, { maxItems: 100_000 }),
	exclusions: Type.Array(WorkspaceExclusionSchema, { maxItems: 100_000 }),
	completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	partialReasons: Type.Array(PartialReasonSchema, { maxItems: 6, uniqueItems: true }),
	capturedAt: timestamp,
});

export const WorkspaceSnapshotManifestSchema = exact({
	...WorkspaceSnapshotManifestBodySchema.properties,
	manifestDigest: digest,
});

const WorkspaceCheckpointSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	checkpointId: runtimeId("checkpoint"),
	workspaceId: runtimeId("workspace"),
	eventCursor: EventCursorSchema,
	baseCommit: token,
	headCommit: token,
	statusDigest: digest,
	snapshotArtifactId: Type.Optional(runtimeId("artifact")),
	completeness: Type.Union([Type.Literal("metadata_only"), Type.Literal("complete"), Type.Literal("partial")]),
});

const CompositeCheckpointBodySchema = exact({
	schemaVersion: Type.Literal(COMPOSITE_CHECKPOINT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	checkpointId: runtimeId("checkpoint"),
	logical: exact({ cursor: EventCursorSchema, reducerDigest: digest, activeLeafId: runtimeId("leaf") }),
	workspace: WorkspaceCheckpointSchema,
	workspaceSnapshotManifestRef: ArtifactRefSchema,
	diffArtifacts: Type.Array(ArtifactRefSchema, { maxItems: 100_000 }),
	untrackedArtifacts: Type.Array(ArtifactRefSchema, { maxItems: 100_000 }),
	completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	partialReasons: Type.Array(PartialReasonSchema, { maxItems: 6, uniqueItems: true }),
	createdAt: timestamp,
});

export const CompositeCheckpointSchema = exact({
	...CompositeCheckpointBodySchema.properties,
	checkpointDigest: digest,
});

const EpisodeManifestBodySchema = exact({
	schemaVersion: Type.Literal(EPISODE_MANIFEST_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	sessionId: runtimeId("session"),
	principalId: runtimeId("principal"),
	evidenceHead: EventCursorSchema,
	integrity: Type.Union([Type.Literal("valid"), Type.Literal("partial"), Type.Literal("corrupted")]),
	attestation: Type.Union([Type.Literal("attested"), Type.Literal("unattested"), Type.Literal("unavailable")]),
	workspace: exact({
		workspaceId: runtimeId("workspace"),
		repositoryId: runtimeId("repository"),
		baseCommit: token,
		headCommit: Type.Optional(token),
	}),
	artifacts: Type.Array(ArtifactRefSchema, { maxItems: 100_000 }),
	externalDeliveries: Type.Array(ArtifactExternalDeliveryProjectionSchema, {
		maxItems: 100_000,
	}),
	permissionReceiptIds: Type.Array(runtimeId("receipt"), { maxItems: 100_000, uniqueItems: true }),
	approvalIds: Type.Array(runtimeId("approval"), { maxItems: 100_000, uniqueItems: true }),
	cost: exact({
		status: Type.Union([Type.Literal("unavailable"), Type.Literal("partial"), Type.Literal("complete")]),
		totalUsd: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	verification: exact({
		status: Type.Union([Type.Literal("not_run"), Type.Literal("partial"), Type.Literal("complete")]),
		verificationIds: Type.Array(runtimeId("verification"), { maxItems: 100_000, uniqueItems: true }),
	}),
	artifactSecurity: exact({
		keyState: Type.Union([
			Type.Literal("available"),
			Type.Literal("unavailable"),
			Type.Literal("lost"),
			Type.Literal("rotating"),
		]),
		degraded: Type.Boolean(),
		legacyUnverifiedCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	}),
	createdAt: timestamp,
});

export const EpisodeManifestSchema = exact({ ...EpisodeManifestBodySchema.properties, manifestDigest: digest });

const EpisodeSealSignerAttestationSchema = exact({
	issuerId: token,
	schemaVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	algorithm: Type.Union([Type.Literal("ed25519"), Type.Literal("hmac-sha256")]),
	keyId: token,
	issuedAt: timestamp,
	signature: Type.String({ minLength: 1, maxLength: 16_384 }),
});

const EpisodeSealBodySchema = exact({
	schemaVersion: Type.Literal(EPISODE_SEAL_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	sealId: runtimeId("episodeSeal"),
	sessionId: runtimeId("session"),
	manifestBodyDigest: digest,
	evidenceHead: EventCursorSchema,
	manifestCommitCursor: EventCursorSchema,
	referenceClosureDigest: digest,
	verificationReceiptDigests: Type.Array(digest, { maxItems: 64, uniqueItems: true }),
	signerAttestation: EpisodeSealSignerAttestationSchema,
});

export const EpisodeSealSchema = exact({ ...EpisodeSealBodySchema.properties, sealDigest: digest });

function failure(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function artifactScopeMatches(
	artifact: ArtifactRef,
	authorityId: string,
	tenantId: string,
	workspaceId?: string,
): boolean {
	return (
		artifact.authorityId === authorityId &&
		artifact.tenantId === tenantId &&
		(workspaceId === undefined || artifact.workspaceId === undefined || artifact.workspaceId === workspaceId)
	);
}

function allArtifacts(manifest: WorkspaceSnapshotManifest): readonly ArtifactRef[] {
	return [
		manifest.rawIndexArtifact,
		...(manifest.stagedDiffArtifact ? [manifest.stagedDiffArtifact] : []),
		...(manifest.unstagedDiffArtifact ? [manifest.unstagedDiffArtifact] : []),
		...manifest.tracked.flatMap((entry) => (entry.contentArtifact ? [entry.contentArtifact] : [])),
		...manifest.untracked.flatMap((entry) => (entry.contentArtifact ? [entry.contentArtifact] : [])),
		...manifest.conflicts.flatMap((entry) => [entry.base, entry.ours, entry.theirs].filter((value): value is ArtifactRef => value !== undefined)),
		...manifest.lfsObjects.flatMap((entry) => (entry.contentArtifact ? [entry.contentArtifact] : [])),
	];
}

function manifestBody<T extends { manifestDigest: string }>(value: T): Omit<T, "manifestDigest"> {
	const { manifestDigest: _manifestDigest, ...body } = value;
	return body;
}

export function isWorkspaceSnapshotManifest(value: unknown): value is WorkspaceSnapshotManifest {
	if (!Check(WorkspaceSnapshotManifestSchema, value)) return false;
	const manifest = value as unknown as WorkspaceSnapshotManifest;
	const derivedReasons = derivePartialReasons(manifest);
	if (
		manifest.manifestDigest !== canonicalDigest(manifestBody(manifest)) ||
		manifest.rawIndexArtifact.kind !== "diff" ||
		!allArtifacts(manifest).every((artifact) =>
			artifactScopeMatches(artifact, manifest.authorityId, manifest.tenantId, manifest.workspaceId),
		) ||
		manifest.tracked.some((entry) => entry.kind === "symlink" ? entry.symlinkTarget === undefined : entry.symlinkTarget !== undefined) ||
		manifest.conflicts.some((entry) => !entry.base && !entry.ours && !entry.theirs) ||
		derivedReasons.some((reason) => !manifest.partialReasons.includes(reason)) ||
		(manifest.partialReasons.length === 0 ? manifest.completeness !== "complete" : manifest.completeness !== "partial")
	) return false;
	return true;
}

function derivePartialReasons(
	manifest: Pick<WorkspaceSnapshotManifest, "exclusions" | "submodules" | "lfsObjects">,
): WorkspaceSnapshotPartialReason[] {
	const reasons = new Set<WorkspaceSnapshotPartialReason>(manifest.exclusions.map((entry) => entry.reason));
	if (manifest.submodules.some((entry) => entry.status !== "clean")) reasons.add("dirty_submodule");
	if (manifest.lfsObjects.some((entry) => entry.status !== "available")) reasons.add("missing_lfs_object");
	return [...reasons].sort();
}

export function createWorkspaceSnapshotManifest(
	input: Omit<WorkspaceSnapshotManifest, "schemaVersion" | "completeness" | "partialReasons" | "manifestDigest">,
): ArtifactResult<WorkspaceSnapshotManifest> {
	const partialReasons = derivePartialReasons(input);
	const body = {
		schemaVersion: WORKSPACE_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		workspaceId: input.workspaceId,
		repositoryId: input.repositoryId,
		baseCommit: input.baseCommit,
		headCommit: input.headCommit,
		rawIndexArtifact: input.rawIndexArtifact,
		...(input.stagedDiffArtifact ? { stagedDiffArtifact: input.stagedDiffArtifact } : {}),
		...(input.unstagedDiffArtifact ? { unstagedDiffArtifact: input.unstagedDiffArtifact } : {}),
		tracked: input.tracked,
		untracked: input.untracked,
		conflicts: input.conflicts,
		submodules: input.submodules,
		lfsObjects: input.lfsObjects,
		exclusions: input.exclusions,
		completeness: partialReasons.length === 0 ? "complete" as const : "partial" as const,
		partialReasons,
		capturedAt: input.capturedAt,
	};
	const manifest: WorkspaceSnapshotManifest = { ...body, manifestDigest: canonicalDigest(body) };
	return isWorkspaceSnapshotManifest(manifest)
		? { ok: true, value: manifest }
		: failure("invalid_request", "workspace snapshot manifest is invalid");
}

function checkpointBody(checkpoint: CompositeCheckpoint): CompositeCheckpointBody {
	const { checkpointDigest: _checkpointDigest, ...body } = checkpoint;
	return body;
}

export function isCompositeCheckpoint(value: unknown): value is CompositeCheckpoint {
	if (!Check(CompositeCheckpointSchema, value)) return false;
	const checkpoint = value as unknown as CompositeCheckpoint;
	return (
		checkpoint.checkpointDigest === canonicalDigest(checkpointBody(checkpoint)) &&
		checkpoint.workspace.authorityId === checkpoint.authorityId &&
		checkpoint.workspace.tenantId === checkpoint.tenantId &&
		checkpoint.workspace.checkpointId === checkpoint.checkpointId &&
		sameRuntimeEventStream(checkpoint.workspace.eventCursor.stream, checkpoint.logical.cursor.stream) &&
		checkpoint.workspace.eventCursor.eventHash === checkpoint.logical.cursor.eventHash &&
		checkpoint.workspaceSnapshotManifestRef.artifactId === checkpoint.workspace.snapshotArtifactId &&
		[
			checkpoint.workspaceSnapshotManifestRef,
			...checkpoint.diffArtifacts,
			...checkpoint.untrackedArtifacts,
		].every((artifact) =>
			artifactScopeMatches(artifact, checkpoint.authorityId, checkpoint.tenantId, checkpoint.workspace.workspaceId),
		) &&
		(checkpoint.partialReasons.length === 0 ? checkpoint.completeness === "complete" : checkpoint.completeness === "partial")
	);
}

export function createCompositeCheckpoint(input: {
	authorityId: CompositeCheckpoint["authorityId"];
	tenantId: CompositeCheckpoint["tenantId"];
	logical: LogicalCheckpoint;
	workspace: CompositeCheckpoint["workspace"];
	workspaceSnapshotManifest: WorkspaceSnapshotManifest;
	workspaceSnapshotManifestRef: ArtifactRef;
	diffArtifacts?: readonly ArtifactRef[];
	untrackedArtifacts?: readonly ArtifactRef[];
	createdAt: string;
}): ArtifactResult<CompositeCheckpoint> {
	if (!isWorkspaceCheckpointDescriptor(input.workspace) || !isWorkspaceSnapshotManifest(input.workspaceSnapshotManifest)) {
		return failure("invalid_request", "composite checkpoint inputs are invalid");
	}
	if (
		input.logical.checkpointId !== input.workspace.checkpointId ||
		!sameRuntimeEventStream(input.logical.cursor.stream, input.workspace.eventCursor.stream) ||
		input.logical.cursor.sequence !== input.workspace.eventCursor.sequence ||
		input.logical.cursor.eventId !== input.workspace.eventCursor.eventId ||
		input.logical.cursor.eventHash !== input.workspace.eventCursor.eventHash ||
		input.workspaceSnapshotManifest.authorityId !== input.authorityId ||
		input.workspaceSnapshotManifest.tenantId !== input.tenantId ||
		input.workspaceSnapshotManifest.workspaceId !== input.workspace.workspaceId ||
		input.workspaceSnapshotManifest.baseCommit !== input.workspace.baseCommit ||
		input.workspaceSnapshotManifest.headCommit !== input.workspace.headCommit ||
		input.workspace.snapshotArtifactId !== input.workspaceSnapshotManifestRef.artifactId
	) return failure("invalid_request", "composite checkpoint inputs are not correlated");
	const partialReasons = [...input.workspaceSnapshotManifest.partialReasons];
	if (input.workspace.completeness !== "complete" && partialReasons.length === 0) partialReasons.push("unrepresentable_entry");
	const uniqueReasons = [...new Set(partialReasons)].sort();
	const body: CompositeCheckpointBody = {
		schemaVersion: COMPOSITE_CHECKPOINT_SCHEMA_VERSION,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		checkpointId: input.logical.checkpointId,
		logical: {
			cursor: input.logical.cursor,
			reducerDigest: input.logical.reducerDigest,
			activeLeafId: input.logical.activeLeafId,
		},
		workspace: input.workspace,
		workspaceSnapshotManifestRef: input.workspaceSnapshotManifestRef,
		diffArtifacts: input.diffArtifacts ?? [],
		untrackedArtifacts: input.untrackedArtifacts ?? [],
		completeness: uniqueReasons.length === 0 ? "complete" : "partial",
		partialReasons: uniqueReasons,
		createdAt: input.createdAt,
	};
	const checkpoint: CompositeCheckpoint = { ...body, checkpointDigest: canonicalDigest(body) };
	return isCompositeCheckpoint(checkpoint)
		? { ok: true, value: checkpoint }
		: failure("invalid_request", "composite checkpoint correlation is invalid");
}

export function compositeCheckpointRef(checkpoint: CompositeCheckpoint): ArtifactResult<CompositeCheckpointRef> {
	if (!isCompositeCheckpoint(checkpoint)) return failure("invalid_request", "composite checkpoint is invalid");
	return {
		ok: true,
		value: {
			authorityId: checkpoint.authorityId,
			tenantId: checkpoint.tenantId,
			checkpointId: checkpoint.checkpointId,
			checkpointDigest: checkpoint.checkpointDigest,
			workspaceId: checkpoint.workspace.workspaceId,
			completeness: checkpoint.completeness,
		},
	};
}

function episodeBody(manifest: EpisodeManifest): EpisodeManifestBody {
	const { manifestDigest: _manifestDigest, ...body } = manifest;
	return body;
}

export function isEpisodeManifest(value: unknown): value is EpisodeManifest {
	if (!Check(EpisodeManifestSchema, value)) return false;
	const manifest = value as unknown as EpisodeManifest;
	return (
		manifest.evidenceHead.stream.scope === "session" &&
		manifest.evidenceHead.stream.sessionId === manifest.sessionId &&
		manifest.artifacts.every((artifact) =>
			artifactScopeMatches(artifact, manifest.authorityId, manifest.tenantId, manifest.workspace.workspaceId),
		) &&
		manifest.externalDeliveries.every((delivery) =>
			artifactDeliveryMayEnterEpisodeEvidence(delivery) &&
			delivery.authorityId === manifest.authorityId &&
			delivery.tenantId === manifest.tenantId &&
			manifest.artifacts.some((artifact) =>
				artifact.artifactId === delivery.artifact.artifactId &&
				artifact.storedDigest === delivery.artifact.storedDigest,
			),
		) &&
		manifest.artifactSecurity.degraded === (manifest.artifactSecurity.keyState !== "available") &&
		manifest.manifestDigest === canonicalDigest(episodeBody(manifest))
	);
}

type EpisodeSealIdentityInput = Pick<
	EpisodeSealBody,
	"authorityId" | "tenantId" | "sessionId" | "manifestBodyDigest" | "evidenceHead" | "manifestCommitCursor" |
		"referenceClosureDigest" | "verificationReceiptDigests"
>;

export function episodeSealIdFor(input: EpisodeSealIdentityInput): EpisodeSealBody["sealId"] {
	const identity = {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		sessionId: input.sessionId,
		manifestBodyDigest: input.manifestBodyDigest,
		evidenceHead: input.evidenceHead,
		manifestCommitCursor: input.manifestCommitCursor,
		referenceClosureDigest: input.referenceClosureDigest,
		verificationReceiptDigests: input.verificationReceiptDigests,
	};
	return createRuntimeId("episodeSeal", `seal-${canonicalDigest(identity).slice(0, 48)}`);
}

export function episodeSealSignatureInputDigest(
	input: Omit<EpisodeSealBody, "signerAttestation"> & { signerAttestation: EpisodeSealSignerIdentity },
): string {
	return canonicalDigest(input);
}

function sealBody(seal: EpisodeSeal): EpisodeSealBody {
	const { sealDigest: _sealDigest, ...body } = seal;
	return body;
}

function sealSignerIdentity(seal: EpisodeSealBody): EpisodeSealSignerIdentity {
	const { signature: _signature, ...identity } = seal.signerAttestation;
	return identity;
}

export function isEpisodeSeal(value: unknown): value is EpisodeSeal {
	if (!Check(EpisodeSealSchema, value)) return false;
	const seal = value as unknown as EpisodeSeal;
	const sortedReceipts = [...seal.verificationReceiptDigests].sort();
	return (
		seal.evidenceHead.stream.scope === "session" &&
		seal.evidenceHead.stream.sessionId === seal.sessionId &&
		seal.manifestCommitCursor.stream.scope === "session" &&
		seal.manifestCommitCursor.stream.sessionId === seal.sessionId &&
		sameRuntimeEventStream(seal.evidenceHead.stream, seal.manifestCommitCursor.stream) &&
		seal.manifestCommitCursor.sequence === seal.evidenceHead.sequence + 1 &&
		seal.verificationReceiptDigests.length > 0 &&
		sortedReceipts.every((entry, index) => entry === seal.verificationReceiptDigests[index]) &&
		seal.sealId === episodeSealIdFor(seal) &&
		episodeSealSignatureInputDigest({
			...sealBody(seal),
			signerAttestation: sealSignerIdentity(seal),
		}).length === 64 &&
		seal.sealDigest === canonicalDigest(sealBody(seal))
	);
}

export function createEpisodeSeal(input: Omit<EpisodeSealBody, "schemaVersion">): ArtifactResult<EpisodeSeal> {
	const body: EpisodeSealBody = { ...input, schemaVersion: EPISODE_SEAL_SCHEMA_VERSION };
	const seal: EpisodeSeal = { ...body, sealDigest: canonicalDigest(body) };
	return isEpisodeSeal(seal)
		? { ok: true, value: seal }
		: failure("invalid_request", "episode seal is invalid");
}

export function createEpisodeManifest(input: Omit<
	EpisodeManifestBody,
	"schemaVersion" | "artifactSecurity" | "externalDeliveries"
> & {
	artifactKeyState: ArtifactKeyState;
	legacyUnverifiedCount: number;
	externalDeliveries?: EpisodeManifestBody["externalDeliveries"];
}): ArtifactResult<EpisodeManifest> {
	const { artifactKeyState, legacyUnverifiedCount, externalDeliveries = [], ...rest } = input;
	const body: EpisodeManifestBody = {
		...rest,
		schemaVersion: EPISODE_MANIFEST_SCHEMA_VERSION,
		externalDeliveries,
		artifactSecurity: {
			keyState: artifactKeyState,
			degraded: artifactKeyState !== "available",
			legacyUnverifiedCount,
		},
	};
	const manifest: EpisodeManifest = { ...body, manifestDigest: canonicalDigest(body) };
	return isEpisodeManifest(manifest)
		? { ok: true, value: manifest }
		: failure("invalid_request", "episode manifest is invalid");
}

function receiptBody<T extends { receiptDigest: string }>(receipt: T): Omit<T, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function validRewindReceipt(
	receipt: WorkspaceRewindReceipt,
	checkpoint: CompositeCheckpointRef,
	expectedLeaseRevision: number,
	targetLeafId: LeafId,
): boolean {
	return (
		receipt.authorityId === checkpoint.authorityId &&
		receipt.tenantId === checkpoint.tenantId &&
		receipt.checkpointId === checkpoint.checkpointId &&
		receipt.workspaceId === checkpoint.workspaceId &&
		receipt.expectedLeaseRevision === expectedLeaseRevision &&
		receipt.targetLeafId === targetLeafId &&
		receipt.receiptDigest === canonicalDigest(receiptBody(receipt))
	);
}

function validCleanupReceipt(
	receipt: WorkspaceCleanupReceipt,
	checkpoint: CompositeCheckpointRef,
	expectedLeaseRevision: number,
): boolean {
	return (
		receipt.authorityId === checkpoint.authorityId &&
		receipt.tenantId === checkpoint.tenantId &&
		receipt.checkpointId === checkpoint.checkpointId &&
		receipt.workspaceId === checkpoint.workspaceId &&
		receipt.expectedLeaseRevision === expectedLeaseRevision &&
		receipt.receiptDigest === canonicalDigest(receiptBody(receipt))
	);
}

export interface LeafActivationPort {
	activateAfterWorkspaceRewind(receipt: WorkspaceRewindReceipt): Promise<ArtifactResult<void>>;
}

export class WorkspaceCheckpointCoordinator {
	readonly #workspace: WorkspaceCheckpointPort;
	readonly #leafActivation: LeafActivationPort;

	public constructor(workspace: WorkspaceCheckpointPort, leafActivation: LeafActivationPort) {
		this.#workspace = workspace;
		this.#leafActivation = leafActivation;
	}

	public async rewind(request: Parameters<WorkspaceCheckpointPort["rewind"]>[0]): Promise<ArtifactResult<WorkspaceRewindReceipt>> {
		if (
			request.expectedLeaseRevision !== request.envelope.leaseRevision ||
			request.checkpoint.authorityId !== request.envelope.authorityId ||
			request.checkpoint.tenantId !== request.envelope.tenantId ||
			request.checkpoint.workspaceId !== request.envelope.workspaceId
		) return failure("fenced", "workspace rewind envelope or lease revision mismatch");
		const result = await this.#workspace.rewind(request);
		if (!result.ok) return result;
		if (!validRewindReceipt(result.value, request.checkpoint, request.expectedLeaseRevision, request.targetLeafId)) {
			return failure("corrupted_metadata", "workspace rewind receipt correlation failed");
		}
		if (result.value.outcome !== "applied") {
			return failure(result.value.outcome === "fenced" ? "fenced" : "durable_write_failed", `workspace rewind ${result.value.outcome}`);
		}
		const activated = await this.#leafActivation.activateAfterWorkspaceRewind(result.value);
		return activated.ok ? result : activated;
	}

	public async cleanup(request: Parameters<WorkspaceCheckpointPort["cleanup"]>[0]): Promise<ArtifactResult<WorkspaceCleanupReceipt>> {
		if (
			request.expectedLeaseRevision !== request.envelope.leaseRevision ||
			request.checkpoint.authorityId !== request.envelope.authorityId ||
			request.checkpoint.tenantId !== request.envelope.tenantId ||
			request.checkpoint.workspaceId !== request.envelope.workspaceId
		) return failure("fenced", "workspace cleanup envelope or lease revision mismatch");
		const result = await this.#workspace.cleanup(request);
		if (!result.ok) return result;
		return validCleanupReceipt(result.value, request.checkpoint, request.expectedLeaseRevision)
			? result
			: failure("corrupted_metadata", "workspace cleanup receipt correlation failed");
	}
}
