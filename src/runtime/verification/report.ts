/** Episode evidence closure、Manifest commit、Seal 与 completion trust 合同。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { sameRuntimeEventStream, type EventCursor } from "../protocol/v3/events.ts";
import { isEventCursor } from "../protocol/v3/schemas.ts";
import type {
	ApprovalId,
	ReceiptId,
	VerificationId,
} from "../protocol/v3/ids.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	createEpisodeSeal,
	episodeSealIdFor,
	episodeSealSignatureInputDigest,
	isEpisodeManifest,
	isEpisodeSeal,
} from "../artifacts/episode-manifest.ts";
import type {
	EpisodeManifest,
	EpisodeSeal,
	EpisodeSealBody,
	EpisodeSealSignerIdentity,
} from "../artifacts/types.ts";
import { TrustedVerifierIssuerRegistry, isVerificationReport } from "./security.ts";
import type { EpisodeSealCompletionRef, VerificationCoreResult, VerificationReport } from "./types.ts";

export interface EpisodeReferenceResolution {
	status: "available" | "missing" | "digest_mismatch" | "revoked" | "unavailable";
	referenceDigest: string;
}

export interface EpisodeReferenceResolverPort {
	resolveEventHead(cursor: EventCursor): Promise<EpisodeReferenceResolution>;
	resolveWorkspace(input: EpisodeManifest["workspace"]): Promise<EpisodeReferenceResolution>;
	resolveArtifact(artifact: ArtifactRef): Promise<EpisodeReferenceResolution>;
	resolvePermissionReceipt(receiptId: ReceiptId): Promise<EpisodeReferenceResolution>;
	resolveApproval(approvalId: ApprovalId): Promise<EpisodeReferenceResolution>;
	resolveVerification(verificationId: VerificationId): Promise<VerificationCoreResult<VerificationReport>>;
}

export interface EpisodeLifecycleReadiness {
	status: "ready" | "blocked";
	manifestBodyDigest: string;
	referenceDigests: readonly string[];
	verificationReceiptDigests: readonly string[];
	referenceClosureDigest: string;
	reasonCodes: readonly string[];
}

export interface EpisodeManifestCommitRequest {
	manifest: EpisodeManifest;
}

/** Manifest body store 必须独立于 session event append，避免 body digest/head 自引用。 */
export interface EpisodeManifestStorePort {
	commit(manifest: EpisodeManifest): Promise<VerificationCoreResult<ArtifactRef>>;
	resolve(reference: ArtifactRef): Promise<VerificationCoreResult<EpisodeManifest>>;
}

export interface EpisodeManifestCommitReceipt {
	receiptId: ReceiptId;
	manifestBodyDigest: string;
	manifestArtifact: ArtifactRef;
	evidenceHead: EventCursor;
	manifestCommitCursor: EventCursor;
	committedAt: string;
	receiptDigest: string;
}

export interface EpisodeSealRecordRequest {
	seal: EpisodeSeal;
}

export interface EpisodeSealRecordReceipt {
	receiptId: ReceiptId;
	sealId: EpisodeSeal["sealId"];
	sealDigest: string;
	manifestCommitCursor: EventCursor;
	sealEventCursor: EventCursor;
	recordedAt: string;
	receiptDigest: string;
}

/** 两个 append 均须 durable、幂等；冲突或中间插入事件必须 pause，不能补写第二个 seal。 */
export interface EpisodeLifecycleWriterPort {
	commitManifest(request: EpisodeManifestCommitRequest): Promise<VerificationCoreResult<EpisodeManifestCommitReceipt>>;
	recordSeal(request: EpisodeSealRecordRequest): Promise<VerificationCoreResult<EpisodeSealRecordReceipt>>;
}

export interface EpisodeSealSignerDescriptor extends Omit<EpisodeSealSignerIdentity, "issuedAt"> {}

/** signer 只接收 canonical input digest，不接收可变 workspace 或 caller 自述。 */
export interface EpisodeSealSignerPort {
	readonly descriptor: EpisodeSealSignerDescriptor;
	sign(signatureInputDigest: string): Promise<VerificationCoreResult<string>>;
}

export interface EpisodeLifecycleReceipt {
	manifestCommit: EpisodeManifestCommitReceipt;
	seal: EpisodeSeal;
	sealRecord: EpisodeSealRecordReceipt;
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validCursor(value: unknown): value is EventCursor {
	return isEventCursor(value);
}

function validManifestArtifact(value: unknown, manifestBodyDigest: string): value is ArtifactRef {
	if (typeof value !== "object" || value === null) return false;
	const artifact = value as Partial<ArtifactRef>;
	return (
		isRuntimeId(artifact.authorityId, "authority") &&
		isRuntimeId(artifact.tenantId, "tenant") &&
		isRuntimeId(artifact.artifactId, "artifact") &&
		artifact.storedDigest === manifestBodyDigest &&
		artifact.kind === "episode_manifest" &&
		typeof artifact.originalSize === "number" && artifact.originalSize >= 0 &&
		typeof artifact.storedSize === "number" && artifact.storedSize >= 0 &&
		artifact.mediaType === "application/vnd.runledger.episode-manifest-body+json" &&
		(artifact.redaction === "metadata_only" || artifact.redaction === "redacted" || artifact.redaction === "encrypted_forensic") &&
		isRuntimeId(artifact.transformReceipt, "receipt") &&
		(artifact.workspaceId === undefined || isRuntimeId(artifact.workspaceId, "workspace"))
	);
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash
	);
}

function manifestCommitReceiptBody(receipt: EpisodeManifestCommitReceipt): Omit<EpisodeManifestCommitReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function sealRecordReceiptBody(receipt: EpisodeSealRecordReceipt): Omit<EpisodeSealRecordReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isEpisodeManifestCommitReceipt(value: unknown): value is EpisodeManifestCommitReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<EpisodeManifestCommitReceipt>;
	if (
		!isRuntimeId(receipt.receiptId, "receipt") ||
		!validDigest(receipt.manifestBodyDigest) ||
		!validManifestArtifact(receipt.manifestArtifact, receipt.manifestBodyDigest ?? "") ||
		!validCursor(receipt.evidenceHead) ||
		!validCursor(receipt.manifestCommitCursor) ||
		typeof receipt.committedAt !== "string" ||
		!validDigest(receipt.receiptDigest)
	) return false;
	return (
		sameRuntimeEventStream(receipt.evidenceHead.stream, receipt.manifestCommitCursor.stream) &&
		receipt.manifestCommitCursor.sequence === receipt.evidenceHead.sequence + 1 &&
		receipt.receiptDigest === canonicalDigest(manifestCommitReceiptBody(receipt as EpisodeManifestCommitReceipt))
	);
}

export function isEpisodeSealRecordReceipt(value: unknown): value is EpisodeSealRecordReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<EpisodeSealRecordReceipt>;
	if (
		!isRuntimeId(receipt.receiptId, "receipt") ||
		!isRuntimeId(receipt.sealId, "episodeSeal") ||
		!validDigest(receipt.sealDigest) ||
		!validCursor(receipt.manifestCommitCursor) ||
		!validCursor(receipt.sealEventCursor) ||
		typeof receipt.recordedAt !== "string" ||
		!validDigest(receipt.receiptDigest)
	) return false;
	return (
		sameRuntimeEventStream(receipt.manifestCommitCursor.stream, receipt.sealEventCursor.stream) &&
		receipt.sealEventCursor.sequence === receipt.manifestCommitCursor.sequence + 1 &&
		receipt.receiptDigest === canonicalDigest(sealRecordReceiptBody(receipt as EpisodeSealRecordReceipt))
	);
}

function available(result: EpisodeReferenceResolution): boolean {
	return result.status === "available";
}

export async function resolveEpisodeLifecycleReadiness(
	manifest: EpisodeManifest,
	resolver: EpisodeReferenceResolverPort,
	registry: TrustedVerifierIssuerRegistry,
): Promise<VerificationCoreResult<EpisodeLifecycleReadiness>> {
	if (!isEpisodeManifest(manifest)) {
		return { ok: false, error: { code: "invalid_schema", message: "Episode Manifest is invalid", retryable: false } };
	}
	const reasons: string[] = [];
	const referenceDigests: string[] = [];
	const verificationReceiptDigests: string[] = [];
	if (manifest.integrity !== "valid") reasons.push("episode_integrity_not_valid");
	if (manifest.attestation !== "attested") reasons.push("episode_not_attested");
	if (manifest.artifactSecurity.degraded || manifest.artifactSecurity.legacyUnverifiedCount > 0) {
		reasons.push("artifact_security_degraded");
	}
	if (manifest.verification.status !== "complete" || manifest.verification.verificationIds.length === 0) {
		reasons.push("verification_incomplete");
	}
	if (!manifest.workspace.headCommit) reasons.push("final_commit_missing");

	try {
		const event = await resolver.resolveEventHead(manifest.evidenceHead);
		referenceDigests.push(event.referenceDigest);
		if (!available(event)) reasons.push(`event_head_${event.status}`);
		const workspace = await resolver.resolveWorkspace(manifest.workspace);
		referenceDigests.push(workspace.referenceDigest);
		if (!available(workspace)) reasons.push(`workspace_${workspace.status}`);
		for (const artifact of manifest.artifacts) {
			const resolution = await resolver.resolveArtifact(artifact);
			referenceDigests.push(resolution.referenceDigest);
			if (!available(resolution)) reasons.push(`artifact_${resolution.status}`);
		}
		for (const receiptId of manifest.permissionReceiptIds) {
			const resolution = await resolver.resolvePermissionReceipt(receiptId);
			referenceDigests.push(resolution.referenceDigest);
			if (!available(resolution)) reasons.push(`permission_${resolution.status}`);
		}
		for (const approvalId of manifest.approvalIds) {
			const resolution = await resolver.resolveApproval(approvalId);
			referenceDigests.push(resolution.referenceDigest);
			if (!available(resolution)) reasons.push(`approval_${resolution.status}`);
		}
		for (const verificationId of manifest.verification.verificationIds) {
			const reportResult = await resolver.resolveVerification(verificationId);
			if (!reportResult.ok || !isVerificationReport(reportResult.value)) {
				reasons.push("verification_reference_unavailable");
				continue;
			}
			const report = reportResult.value;
			verificationReceiptDigests.push(report.receipt.receiptDigest);
			referenceDigests.push(report.reportDigest);
			if (
				report.result.verificationId !== verificationId ||
				report.result.authorityId !== manifest.authorityId ||
				report.result.tenantId !== manifest.tenantId ||
				report.result.candidate.repositoryId !== manifest.workspace.repositoryId ||
				report.result.candidate.workspaceId !== manifest.workspace.workspaceId ||
				report.result.candidate.baseCommit !== manifest.workspace.baseCommit ||
				report.result.candidate.candidateCommit !== manifest.workspace.headCommit
			) {
				reasons.push("verification_identity_mismatch");
				continue;
			}
			if (!(await registry.verifyForCompletion(report))) reasons.push("verification_not_trusted_pass");
			for (const artifactReceipt of report.result.artifacts) {
				const resolution = await resolver.resolveArtifact(artifactReceipt.artifact);
				referenceDigests.push(resolution.referenceDigest);
				if (!available(resolution)) reasons.push(`verification_artifact_${resolution.status}`);
			}
		}
	} catch {
		reasons.push("reference_resolver_unavailable");
	}
	const uniqueReasons = [...new Set(reasons)].sort();
	const uniqueReferences = [...new Set(referenceDigests)].sort();
	const uniqueVerificationReceipts = [...new Set(verificationReceiptDigests)].sort();
	const referenceClosureDigest = canonicalDigest({
		manifestBodyDigest: manifest.manifestDigest,
		evidenceHead: manifest.evidenceHead,
		references: uniqueReferences,
		verificationReceipts: uniqueVerificationReceipts,
	});
	return {
		ok: true,
		value: {
			status: uniqueReasons.length === 0 ? "ready" : "blocked",
			manifestBodyDigest: manifest.manifestDigest,
			referenceDigests: uniqueReferences,
			verificationReceiptDigests: uniqueVerificationReceipts,
			referenceClosureDigest,
			reasonCodes: uniqueReasons,
		},
	};
}

function signerIdentity(
	descriptor: EpisodeSealSignerDescriptor,
	issuedAt: string,
): EpisodeSealSignerIdentity {
	return { ...descriptor, issuedAt };
}

export async function sealEpisode(
	manifest: EpisodeManifest,
	resolver: EpisodeReferenceResolverPort,
	registry: TrustedVerifierIssuerRegistry,
	signer: EpisodeSealSignerPort,
	writer: EpisodeLifecycleWriterPort,
): Promise<VerificationCoreResult<EpisodeLifecycleReceipt>> {
	const readiness = await resolveEpisodeLifecycleReadiness(manifest, resolver, registry);
	if (!readiness.ok) return readiness;
	if (readiness.value.status !== "ready") {
		return {
			ok: false,
			error: {
				code: "terminal_not_ready",
				message: `Episode references are not ready: ${readiness.value.reasonCodes.join(",")}`,
				retryable: true,
			},
		};
	}

	let committed: Awaited<ReturnType<EpisodeLifecycleWriterPort["commitManifest"]>>;
	try {
		committed = await writer.commitManifest({ manifest });
	} catch {
		return { ok: false, error: { code: "lifecycle_paused", message: "Manifest commit outcome is uncertain", retryable: false } };
	}
	if (!committed.ok) return committed;
	if (
		!isEpisodeManifestCommitReceipt(committed.value) ||
		committed.value.manifestBodyDigest !== manifest.manifestDigest ||
		committed.value.manifestArtifact.authorityId !== manifest.authorityId ||
		committed.value.manifestArtifact.tenantId !== manifest.tenantId ||
		committed.value.manifestArtifact.workspaceId !== manifest.workspace.workspaceId ||
		!sameCursor(committed.value.evidenceHead, manifest.evidenceHead)
	) {
		return { ok: false, error: { code: "invalid_digest", message: "Manifest commit receipt is invalid", retryable: false } };
	}

	const sealIdentity = {
		authorityId: manifest.authorityId,
		tenantId: manifest.tenantId,
		sessionId: manifest.sessionId,
		manifestBodyDigest: manifest.manifestDigest,
		evidenceHead: manifest.evidenceHead,
		manifestCommitCursor: committed.value.manifestCommitCursor,
		referenceClosureDigest: readiness.value.referenceClosureDigest,
		verificationReceiptDigests: readiness.value.verificationReceiptDigests,
	};
	const sealId = episodeSealIdFor(sealIdentity);
	const unsigned: Omit<EpisodeSealBody, "signerAttestation"> & { signerAttestation: EpisodeSealSignerIdentity } = {
		...sealIdentity,
		schemaVersion: 1,
		sealId,
		signerAttestation: signerIdentity(signer.descriptor, committed.value.committedAt),
	};
	const signatureInputDigest = episodeSealSignatureInputDigest(unsigned);
	let signature: Awaited<ReturnType<EpisodeSealSignerPort["sign"]>>;
	try {
		signature = await signer.sign(signatureInputDigest);
	} catch {
		return { ok: false, error: { code: "lifecycle_paused", message: "Episode seal signer is unavailable", retryable: false } };
	}
	if (!signature.ok) return signature;
	const created = createEpisodeSeal({
		...unsigned,
		signerAttestation: { ...unsigned.signerAttestation, signature: signature.value },
	});
	if (!created.ok) {
		return { ok: false, error: { code: "invalid_schema", message: created.error.message, retryable: false } };
	}
	const trusted = await registry.verifyEpisodeSeal(created.value);
	if (!trusted.ok) return trusted;

	let recorded: Awaited<ReturnType<EpisodeLifecycleWriterPort["recordSeal"]>>;
	try {
		recorded = await writer.recordSeal({ seal: created.value });
	} catch {
		return { ok: false, error: { code: "lifecycle_paused", message: "Episode seal append outcome is uncertain", retryable: false } };
	}
	if (!recorded.ok) return recorded;
	if (
		!isEpisodeSealRecordReceipt(recorded.value) ||
		recorded.value.sealId !== created.value.sealId ||
		recorded.value.sealDigest !== created.value.sealDigest ||
		!sameCursor(recorded.value.manifestCommitCursor, committed.value.manifestCommitCursor)
	) {
		return { ok: false, error: { code: "invalid_digest", message: "Episode seal record receipt is invalid", retryable: false } };
	}
	return { ok: true, value: { manifestCommit: committed.value, seal: created.value, sealRecord: recorded.value } };
}

export interface VerificationReportResolverPort {
	resolveByReceiptDigest(receiptDigest: string): Promise<VerificationCoreResult<VerificationReport>>;
}

/** Phase 7 旧命名仅保留为 source-compatible port 别名；completion 不再信任它。 */
export type Phase7VerificationReportResolverPort = VerificationReportResolverPort;

export interface DurableEpisodeSealResolverPort {
	resolveBySealDigest(sealDigest: string): Promise<VerificationCoreResult<{
		seal: EpisodeSeal;
		record: EpisodeSealRecordReceipt;
	}>>;
}

export function episodeSealRecordDigest(seal: EpisodeSeal, record: EpisodeSealRecordReceipt): string | undefined {
	if (
		!isEpisodeSeal(seal) ||
		!isEpisodeSealRecordReceipt(record) ||
		seal.sealId !== record.sealId ||
		seal.sealDigest !== record.sealDigest ||
		!sameCursor(seal.manifestCommitCursor, record.manifestCommitCursor)
	) return undefined;
	return canonicalDigest({ sealDigest: seal.sealDigest, sealEventCursor: record.sealEventCursor });
}

export function toEpisodeSealCompletionRef(receipt: EpisodeLifecycleReceipt): EpisodeSealCompletionRef | undefined {
	const sealRecordDigest = episodeSealRecordDigest(receipt.seal, receipt.sealRecord);
	if (!sealRecordDigest) return undefined;
	return {
		authorityId: receipt.seal.authorityId,
		tenantId: receipt.seal.tenantId,
		sealId: receipt.seal.sealId,
		sealDigest: receipt.seal.sealDigest,
		sealRecordDigest,
		manifestBodyDigest: receipt.seal.manifestBodyDigest,
	};
}

/** Orchestrator adapter:只接受 durable seal record + 受信 signer，不接受 caller 自述。 */
export class EpisodeSealCompletionTrustAdapter {
	readonly #resolver: DurableEpisodeSealResolverPort;
	readonly #registry: TrustedVerifierIssuerRegistry;

	public constructor(resolver: DurableEpisodeSealResolverPort, registry: TrustedVerifierIssuerRegistry) {
		this.#resolver = resolver;
		this.#registry = registry;
	}

	public async verify(reference: EpisodeSealCompletionRef): Promise<boolean> {
		let resolved: Awaited<ReturnType<DurableEpisodeSealResolverPort["resolveBySealDigest"]>>;
		try {
			resolved = await this.#resolver.resolveBySealDigest(reference.sealDigest);
		} catch {
			return false;
		}
		if (!resolved.ok) return false;
		const { seal, record } = resolved.value;
		return (
			seal.authorityId === reference.authorityId &&
			seal.tenantId === reference.tenantId &&
			seal.sealId === reference.sealId &&
			seal.sealDigest === reference.sealDigest &&
			seal.manifestBodyDigest === reference.manifestBodyDigest &&
			episodeSealRecordDigest(seal, record) === reference.sealRecordDigest &&
			(await this.#registry.verifyEpisodeSeal(seal)).ok
		);
	}
}
