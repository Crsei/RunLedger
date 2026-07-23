import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import {
	compositeCheckpointRef,
	createCompositeCheckpoint,
	createEpisodeManifest,
	createEpisodeSeal,
	createWorkspaceSnapshotManifest,
	episodeSealIdFor,
	isCompositeCheckpoint,
	isEpisodeManifest,
	isEpisodeSeal,
	isWorkspaceSnapshotManifest,
} from "../../../src/runtime/artifacts/episode-manifest.ts";
import type { LogicalCheckpoint } from "../../../src/runtime/session/checkpoint.ts";
import type { WorkspaceCheckpointDescriptor } from "../../../src/runtime/protocol/v3/workspace.ts";
import { DIGEST, NOW, valueOf } from "./helpers.ts";

const ALT_DIGEST = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function fixture() {
	const authorityId = createRuntimeId("authority", "manifest");
	const tenantId = createRuntimeId("tenant", "manifest");
	const workspaceId = createRuntimeId("workspace", "manifest");
	const repositoryId = createRuntimeId("repository", "manifest");
	const sessionId = createRuntimeId("session", "manifest");
	const eventStream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const artifact = (seed: string, kind: ArtifactRef["kind"] = "diff"): ArtifactRef => ({
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: DIGEST,
		kind,
		originalSize: 10,
		storedSize: 8,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", seed),
		workspaceId,
	});
	const snapshot = valueOf(createWorkspaceSnapshotManifest({
		authorityId,
		tenantId,
		workspaceId,
		repositoryId,
		baseCommit: "base-commit",
		headCommit: "head-commit",
		rawIndexArtifact: artifact("raw-index"),
		stagedDiffArtifact: artifact("staged"),
		unstagedDiffArtifact: artifact("unstaged"),
		tracked: [
			{ pathDigest: DIGEST, kind: "regular", mode: "100644", contentArtifact: artifact("tracked"), status: "modified" },
			{ pathDigest: ALT_DIGEST, kind: "symlink", mode: "120000", symlinkTarget: "../target", status: "added" },
		],
		untracked: [
			{ pathDigest: DIGEST, kind: "executable", mode: "100755", contentArtifact: artifact("untracked"), status: "added" },
		],
		conflicts: [{ pathDigest: ALT_DIGEST, base: artifact("base"), ours: artifact("ours"), theirs: artifact("theirs") }],
		submodules: [{ pathDigest: DIGEST, commit: "submodule-commit", status: "clean" }],
		lfsObjects: [{ pathDigest: ALT_DIGEST, oid: "sha256:object", size: 42, status: "available", contentArtifact: artifact("lfs") }],
		exclusions: [],
		capturedAt: NOW,
	}));
	const cursor = {
		stream: eventStream,
		sequence: 4,
		eventId: createRuntimeId("event", "manifest-head"),
		eventHash: DIGEST,
	};
	const checkpointId = createRuntimeId("checkpoint", "manifest");
	const logical: LogicalCheckpoint = {
		checkpointId,
		cursor,
		reducerDigest: ALT_DIGEST,
		activeLeafId: createRuntimeId("leaf", "manifest"),
	};
	const manifestRef = artifact("snapshot-manifest", "session_report");
	const workspace: WorkspaceCheckpointDescriptor = {
		authorityId,
		tenantId,
		checkpointId,
		workspaceId,
		eventCursor: cursor,
		baseCommit: "base-commit",
		headCommit: "head-commit",
		statusDigest: ALT_DIGEST,
		snapshotArtifactId: manifestRef.artifactId,
		completeness: "complete",
	};
	return { authorityId, tenantId, workspaceId, repositoryId, sessionId, artifact, snapshot, logical, workspace, manifestRef };
}

describe("artifact-backed manifests", () => {
	it("losslessly expresses index, staged, unstaged, untracked, modes, symlinks, conflicts, submodules, and LFS", () => {
		const { snapshot } = fixture();
		expect(snapshot.completeness).toBe("complete");
		expect(snapshot.tracked).toEqual(expect.arrayContaining([
			expect.objectContaining({ mode: "100644", status: "modified" }),
			expect.objectContaining({ mode: "120000", symlinkTarget: "../target" }),
		]));
		expect(snapshot.conflicts[0]).toMatchObject({ base: expect.any(Object), ours: expect.any(Object), theirs: expect.any(Object) });
		expect(snapshot.untracked[0]?.mode).toBe("100755");
		expect(isWorkspaceSnapshotManifest(snapshot)).toBe(true);
		expect(isWorkspaceSnapshotManifest({ ...snapshot, unexpected: true })).toBe(false);
	});

	it("derives partial semantics for exclusions, dirty submodules, missing LFS, and size limits", () => {
		const base = fixture();
		const partial = valueOf(createWorkspaceSnapshotManifest({
			...base.snapshot,
			submodules: [{ pathDigest: DIGEST, commit: "dirty", status: "dirty" }],
			lfsObjects: [{ pathDigest: ALT_DIGEST, oid: "sha256:missing", size: 42, status: "missing" }],
			exclusions: [
				{ pathDigest: DIGEST, reason: "ignored_excluded", detailDigest: ALT_DIGEST },
				{ pathDigest: ALT_DIGEST, reason: "size_limit", detailDigest: DIGEST },
			],
		}));
		expect(partial.completeness).toBe("partial");
		expect(partial.partialReasons).toEqual([
			"dirty_submodule",
			"ignored_excluded",
			"missing_lfs_object",
			"size_limit",
		]);
		expect(isWorkspaceSnapshotManifest(partial)).toBe(true);
	});

	it("combines a logical checkpoint and workspace snapshot without claiming physical rewind", () => {
		const data = fixture();
		const checkpoint = valueOf(createCompositeCheckpoint({
			authorityId: data.authorityId,
			tenantId: data.tenantId,
			logical: data.logical,
			workspace: data.workspace,
			workspaceSnapshotManifest: data.snapshot,
			workspaceSnapshotManifestRef: data.manifestRef,
			diffArtifacts: [data.snapshot.stagedDiffArtifact as ArtifactRef],
			untrackedArtifacts: [data.snapshot.untracked[0]?.contentArtifact as ArtifactRef],
			createdAt: NOW,
		}));
		expect(checkpoint.completeness).toBe("complete");
		expect(isCompositeCheckpoint(checkpoint)).toBe(true);
		expect(valueOf(compositeCheckpointRef(checkpoint))).toMatchObject({
			checkpointId: data.logical.checkpointId,
			workspaceId: data.workspaceId,
			completeness: "complete",
		});

		expect(createCompositeCheckpoint({
			authorityId: data.authorityId,
			tenantId: data.tenantId,
			logical: data.logical,
			workspace: { ...data.workspace, headCommit: "different-head" },
			workspaceSnapshotManifest: data.snapshot,
			workspaceSnapshotManifestRef: data.manifestRef,
			createdAt: NOW,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("materializes an episode index with explicit integrity, attestation, cost, verification, and key degradation", () => {
		const data = fixture();
		const manifest = valueOf(createEpisodeManifest({
			authorityId: data.authorityId,
			tenantId: data.tenantId,
			sessionId: data.sessionId,
			principalId: createRuntimeId("principal", "manifest"),
			evidenceHead: data.logical.cursor,
			integrity: "valid",
			attestation: "unattested",
			workspace: {
				workspaceId: data.workspaceId,
				repositoryId: data.repositoryId,
				baseCommit: "base-commit",
				headCommit: "head-commit",
			},
			artifacts: [data.manifestRef],
			permissionReceiptIds: [createRuntimeId("receipt", "permission")],
			approvalIds: [createRuntimeId("approval", "manifest")],
			cost: { status: "partial", totalUsd: 0.25 },
			verification: { status: "not_run", verificationIds: [] },
			artifactKeyState: "unavailable",
			legacyUnverifiedCount: 1,
			createdAt: NOW,
		}));
		expect(manifest.artifactSecurity).toEqual({ keyState: "unavailable", degraded: true, legacyUnverifiedCount: 1 });
		expect(isEpisodeManifest(manifest)).toBe(true);
	});

	it("validates an exact EpisodeSeal identity, cursor sequence, and body digest", () => {
		const data = fixture();
		const manifestCommitCursor = {
			...data.logical.cursor,
			sequence: data.logical.cursor.sequence + 1,
			eventId: createRuntimeId("event", "manifest-commit"),
			eventHash: ALT_DIGEST,
		};
		const identity = {
			authorityId: data.authorityId,
			tenantId: data.tenantId,
			sessionId: data.sessionId,
			manifestBodyDigest: DIGEST,
			evidenceHead: data.logical.cursor,
			manifestCommitCursor,
			referenceClosureDigest: ALT_DIGEST,
			verificationReceiptDigests: [DIGEST],
		};
		const seal = valueOf(createEpisodeSeal({
			...identity,
			sealId: episodeSealIdFor(identity),
			signerAttestation: {
				issuerId: "production-verifier",
				schemaVersion: 1,
				algorithm: "hmac-sha256",
				keyId: "verification-key-v1",
				issuedAt: NOW,
				signature: DIGEST,
			},
		}));
		expect(isEpisodeSeal(seal)).toBe(true);
		expect(isEpisodeSeal({ ...seal, future: true })).toBe(false);
		expect(isEpisodeSeal({ ...seal, sealDigest: ALT_DIGEST })).toBe(false);
		expect(isEpisodeSeal({
			...seal,
			manifestCommitCursor: { ...seal.manifestCommitCursor, sequence: seal.evidenceHead.sequence + 2 },
		})).toBe(false);
		const invalidIdentity = {
			...identity,
			manifestCommitCursor: { ...manifestCommitCursor, sequence: data.logical.cursor.sequence + 2 },
		};
		expect(createEpisodeSeal({
			...invalidIdentity,
			sealId: episodeSealIdFor(invalidIdentity),
			signerAttestation: seal.signerAttestation,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});
