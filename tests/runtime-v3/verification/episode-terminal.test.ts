import { describe, expect, it, vi } from "vitest";
import { createEpisodeManifest } from "../../../src/runtime/artifacts/episode-manifest.ts";
import type { EpisodeManifest } from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	EpisodeSealCompletionTrustAdapter,
	sealEpisode,
	resolveEpisodeLifecycleReadiness,
	toEpisodeSealCompletionRef,
	type DurableEpisodeSealResolverPort,
	type EpisodeLifecycleWriterPort,
	type EpisodeReferenceResolution,
	type EpisodeReferenceResolverPort,
	type EpisodeSealSignerPort,
} from "../../../src/runtime/verification/report.ts";
import { EPISODE_MANIFEST_BODY_MEDIA_TYPE } from "../../../src/runtime/verification/manifest-store.ts";
import type { VerificationCoreResult, VerificationReport } from "../../../src/runtime/verification/types.ts";
import {
	AUTHORITY_ID,
	BASE_COMMIT,
	CANDIDATE_COMMIT,
	ISSUER_ID,
	KEY_ID,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	SESSION_ID,
	SESSION_STREAM,
	TENANT_ID,
	VERIFICATION_ID,
	WORKSPACE_ID,
	candidate,
	registry,
	reportFor,
	verificationResult,
} from "./helpers.ts";

function manifestFor(report: VerificationReport): EpisodeManifest {
	const created = createEpisodeManifest({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		principalId: PRINCIPAL_ID,
		evidenceHead: {
			stream: SESSION_STREAM,
			sequence: 42,
			eventId: createRuntimeId("event", "episode-head"),
			eventHash: canonicalDigest("episode-head"),
		},
		integrity: "valid",
		attestation: "attested",
		workspace: {
			workspaceId: WORKSPACE_ID,
			repositoryId: REPOSITORY_ID,
			baseCommit: BASE_COMMIT,
			headCommit: CANDIDATE_COMMIT,
		},
		artifacts: report.result.artifacts.map((entry) => entry.artifact),
		permissionReceiptIds: [createRuntimeId("receipt", "episode-permission")],
		approvalIds: [createRuntimeId("approval", "episode-approval")],
		cost: { status: "complete", totalUsd: 1.25 },
		verification: { status: "complete", verificationIds: [VERIFICATION_ID] },
		createdAt: "2026-07-22T08:00:04.000Z",
		artifactKeyState: "available",
		legacyUnverifiedCount: 0,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function resolution(status: EpisodeReferenceResolution["status"] = "available"): EpisodeReferenceResolution {
	return { status, referenceDigest: canonicalDigest(status) };
}

class Resolver implements EpisodeReferenceResolverPort {
	report: VerificationReport;
	artifactStatus: EpisodeReferenceResolution["status"] = "available";

	public constructor(report: VerificationReport) {
		this.report = report;
	}

	public async resolveEventHead() { return resolution(); }
	public async resolveWorkspace() { return resolution(); }
	public async resolveArtifact() { return resolution(this.artifactStatus); }
	public async resolvePermissionReceipt() { return resolution(); }
	public async resolveApproval() { return resolution(); }
	public async resolveVerification(): Promise<VerificationCoreResult<VerificationReport>> {
		return { ok: true, value: this.report };
	}
}

const signer: EpisodeSealSignerPort = {
	descriptor: { issuerId: ISSUER_ID, schemaVersion: 1, algorithm: "hmac-sha256", keyId: KEY_ID },
	sign: async (inputDigest) => ({ ok: true, value: canonicalDigest({ key: "test-secret", inputDigest }) }),
};

function lifecycleWriter(manifest: EpisodeManifest) {
	const manifestCommitCursor = {
		stream: SESSION_STREAM,
		sequence: manifest.evidenceHead.sequence + 1,
		eventId: createRuntimeId("event", "manifest-commit"),
		eventHash: canonicalDigest("manifest-commit"),
	};
	const commitManifest = vi.fn<EpisodeLifecycleWriterPort["commitManifest"]>(async () => {
		const body = {
			receiptId: createRuntimeId("receipt", "manifest-commit"),
			manifestBodyDigest: manifest.manifestDigest,
			manifestArtifact: {
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				artifactId: createRuntimeId("artifact", "episode-manifest"),
				storedDigest: manifest.manifestDigest,
				kind: "episode_manifest" as const,
				originalSize: 128,
				storedSize: 128,
				mediaType: EPISODE_MANIFEST_BODY_MEDIA_TYPE,
				redaction: "metadata_only" as const,
				transformReceipt: createRuntimeId("receipt", "episode-manifest-transform"),
				workspaceId: WORKSPACE_ID,
			},
			evidenceHead: manifest.evidenceHead,
			manifestCommitCursor,
			committedAt: "2026-07-22T08:00:05.000Z",
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
	});
	const recordSeal = vi.fn<EpisodeLifecycleWriterPort["recordSeal"]>(async ({ seal }) => {
		const body = {
			receiptId: createRuntimeId("receipt", "seal-record"),
			sealId: seal.sealId,
			sealDigest: seal.sealDigest,
			manifestCommitCursor,
			sealEventCursor: {
				stream: SESSION_STREAM,
				sequence: manifestCommitCursor.sequence + 1,
				eventId: createRuntimeId("event", "seal-record"),
				eventHash: canonicalDigest("seal-record"),
			},
			recordedAt: "2026-07-22T08:00:06.000Z",
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
	});
	return { commitManifest, recordSeal };
}

describe("Episode manifest and seal lifecycle", () => {
	it("resolves every reference before committing a manifest and recording one signed seal", async () => {
		const report = reportFor(verificationResult());
		const manifest = manifestFor(report);
		const resolver = new Resolver(report);
		const readiness = await resolveEpisodeLifecycleReadiness(manifest, resolver, registry());
		expect(readiness.ok && readiness.value.status).toBe("ready");
		const writer = lifecycleWriter(manifest);
		const sealed = await sealEpisode(manifest, resolver, registry(), signer, writer);
		expect(sealed.ok).toBe(true);
		expect(writer.commitManifest).toHaveBeenCalledTimes(1);
		expect(writer.recordSeal).toHaveBeenCalledTimes(1);
		if (sealed.ok) {
			expect(sealed.value.seal.manifestCommitCursor.sequence).toBe(manifest.evidenceHead.sequence + 1);
			expect(sealed.value.sealRecord.sealEventCursor.sequence).toBe(manifest.evidenceHead.sequence + 2);
		}
	});

	it("blocks sealing for missing Artifacts or a verification from another commit", async () => {
		const current = reportFor(verificationResult());
		const manifest = manifestFor(current);
		const missing = new Resolver(current);
		missing.artifactStatus = "missing";
		const writer = lifecycleWriter(manifest);
		const missingResult = await sealEpisode(manifest, missing, registry(), signer, writer);
		expect(missingResult.ok).toBe(false);
		expect(writer.commitManifest).not.toHaveBeenCalled();

		const oldReport = reportFor(verificationResult({ candidate: candidate("0".repeat(40)) }));
		const stale = await resolveEpisodeLifecycleReadiness(manifest, new Resolver(oldReport), registry());
		expect(stale.ok && stale.value.status).toBe("blocked");
		if (stale.ok) expect(stale.value.reasonCodes).toContain("verification_identity_mismatch");
	});

	it("rejects a forged manifest commit receipt before signing", async () => {
		const report = reportFor(verificationResult());
		const manifest = manifestFor(report);
		const writer = lifecycleWriter(manifest);
		const valid = await writer.commitManifest({ manifest });
		if (!valid.ok) throw new Error(valid.error.message);
		writer.commitManifest.mockClear();
		writer.commitManifest.mockResolvedValueOnce({
			ok: true,
			value: {
				receiptId: createRuntimeId("receipt", "forged-manifest"),
				manifestBodyDigest: manifest.manifestDigest,
				manifestArtifact: valid.value.manifestArtifact,
				evidenceHead: manifest.evidenceHead,
				manifestCommitCursor: {
					stream: SESSION_STREAM,
					sequence: manifest.evidenceHead.sequence + 2,
					eventId: createRuntimeId("event", "forged-manifest"),
					eventHash: canonicalDigest("forged-manifest"),
				},
				committedAt: "2026-07-22T08:00:05.000Z",
				receiptDigest: canonicalDigest("forged"),
			},
		});
		const sealed = await sealEpisode(manifest, new Resolver(report), registry(), signer, writer);
		expect(sealed).toMatchObject({ ok: false, error: { code: "invalid_digest" } });
		expect(writer.recordSeal).not.toHaveBeenCalled();
	});

	it("verifies completion only through the durable seal record", async () => {
		const report = reportFor(verificationResult());
		const manifest = manifestFor(report);
		const sealed = await sealEpisode(manifest, new Resolver(report), registry(), signer, lifecycleWriter(manifest));
		if (!sealed.ok) throw new Error(sealed.error.message);
		const durable: DurableEpisodeSealResolverPort = {
			resolveBySealDigest: async () => ({ ok: true, value: { seal: sealed.value.seal, record: sealed.value.sealRecord } }),
		};
		const reference = toEpisodeSealCompletionRef(sealed.value);
		if (!reference) throw new Error("completion reference failed");
		const trust = new EpisodeSealCompletionTrustAdapter(durable, registry());
		expect(await trust.verify(reference)).toBe(true);
		expect(await trust.verify({ ...reference, sealRecordDigest: canonicalDigest("forged") })).toBe(false);
	});
});
