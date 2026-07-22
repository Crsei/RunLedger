/** Artifact 读取必须经 Capability Gateway 重检，并对 forensic 读取做审计。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type { ArtifactKeyProvider } from "./key-provider.ts";
import { artifactLineageAllowsSink } from "./lineage.ts";
import type { ArtifactCasStore } from "./cas-store.ts";
import type { ArtifactMetadataStore } from "./metadata-store.ts";
import { decryptForensicArtifact } from "./redaction.ts";
import type {
	ArtifactAccessLogPort,
	ArtifactCapabilityDecision,
	ArtifactError,
	ArtifactMetadata,
	ArtifactReadRequest,
	ArtifactReadResult,
	ArtifactResult,
	ArtifactCapabilityGatewayPort,
} from "./types.ts";

export class ArtifactReadLeaseRegistry {
	readonly #activeByDigest = new Map<string, number>();
	readonly #deleting = new Set<string>();

	public acquire(digest: string): (() => void) | undefined {
		if (this.#deleting.has(digest)) return undefined;
		this.#activeByDigest.set(digest, (this.#activeByDigest.get(digest) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const active = this.#activeByDigest.get(digest) ?? 0;
			if (active <= 1) this.#activeByDigest.delete(digest);
			else this.#activeByDigest.set(digest, active - 1);
		};
	}

	public activeReaders(digest: string): number {
		return this.#activeByDigest.get(digest) ?? 0;
	}

	public reserveDeletion(digest: string): (() => void) | undefined {
		if (this.#deleting.has(digest) || this.activeReaders(digest) > 0) return undefined;
		this.#deleting.add(digest);
		return () => this.#deleting.delete(digest);
	}
}

export interface ArtifactAccessServiceOptions {
	cas: ArtifactCasStore;
	metadata: ArtifactMetadataStore;
	gateway: ArtifactCapabilityGatewayPort;
	accessLog: ArtifactAccessLogPort;
	keyProvider: ArtifactKeyProvider;
	readLeases?: ArtifactReadLeaseRegistry;
	clock?: () => Date;
}

function failure(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function referenceFor(metadata: ArtifactMetadata): ArtifactRef {
	return {
		authorityId: metadata.authorityId,
		tenantId: metadata.tenantId,
		artifactId: metadata.artifactId,
		storedDigest: metadata.storedDigest,
		kind: metadata.kind,
		originalSize: metadata.originalSize,
		storedSize: metadata.storedSize,
		mediaType: metadata.mediaType,
		redaction: metadata.redaction,
		transformReceipt: metadata.transformReceipt.receiptId,
		...(metadata.source.workspaceId ? { workspaceId: metadata.source.workspaceId } : {}),
	};
}

function validDecisionScope(request: ArtifactReadRequest, decision: ArtifactCapabilityDecision): boolean {
	return decision.authorityId === request.authorityId && decision.tenantId === request.tenantId;
}

export class ArtifactAccessService {
	readonly #cas: ArtifactCasStore;
	readonly #metadata: ArtifactMetadataStore;
	readonly #gateway: ArtifactCapabilityGatewayPort;
	readonly #accessLog: ArtifactAccessLogPort;
	readonly #keyProvider: ArtifactKeyProvider;
	readonly #readLeases: ArtifactReadLeaseRegistry;
	readonly #clock: () => Date;

	public constructor(options: ArtifactAccessServiceOptions) {
		this.#cas = options.cas;
		this.#metadata = options.metadata;
		this.#gateway = options.gateway;
		this.#accessLog = options.accessLog;
		this.#keyProvider = options.keyProvider;
		this.#readLeases = options.readLeases ?? new ArtifactReadLeaseRegistry();
		this.#clock = options.clock ?? (() => new Date());
	}

	public async read(request: ArtifactReadRequest): Promise<ArtifactResult<ArtifactReadResult>> {
		const metadata = await this.#metadata.readCommitted(request.authorityId, request.tenantId, request.artifactId);
		if (!metadata.ok) return metadata;
		if (metadata.value.source.sessionId !== request.sessionId) {
			return failure("authorization_denied", "artifact session scope mismatch");
		}
		if (metadata.value.source.workspaceId && metadata.value.source.workspaceId !== request.workspaceId) {
			return failure("authorization_denied", "artifact workspace scope mismatch");
		}
		const operation = metadata.value.redaction === "encrypted_forensic" ? "read_forensic" : "read";
		const targetSink = request.targetSink ?? "context";
		const declassificationReceipts = request.declassificationReceipts ?? [];
		if (operation === "read_forensic" && (!request.forensicPurpose || request.forensicPurpose.trim().length < 1)) {
			return failure("authorization_denied", "forensic artifact read requires an explicit purpose");
		}
		if (!artifactLineageAllowsSink(metadata.value.lineage, targetSink, declassificationReceipts, this.#clock())) {
			const logged = await this.#accessLog.append({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				artifactId: request.artifactId,
				principalId: request.principalId,
				sessionId: request.sessionId,
				...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
				operation,
				decision: "denied",
				timestamp: this.#clock().toISOString(),
			});
			if (!logged.ok) return failure("durable_write_failed", "artifact taint denial could not be audited", true);
			return failure("authorization_denied", `artifact lineage is not allowed at ${targetSink} sink`);
		}
		const artifact = referenceFor(metadata.value);
		const requestDigest = canonicalDigest({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			workspaceId: request.workspaceId ?? null,
			artifactId: request.artifactId,
			storedDigest: artifact.storedDigest,
			capability: request.capability,
			operation,
			targetSink,
			lineageDigest: metadata.value.lineage.lineageDigest,
			declassificationReceiptDigests: declassificationReceipts.map((receipt) => receipt.receiptDigest).sort(),
		});
		let decisionResult: Awaited<ReturnType<ArtifactCapabilityGatewayPort["recheckArtifactAccess"]>>;
		try {
			decisionResult = await this.#gateway.recheckArtifactAccess({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				sessionId: request.sessionId,
				...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
				artifact,
				capability: request.capability,
				operation,
				inputSources: metadata.value.lineage.inputSources,
				targetSink,
				declassificationReceipts,
				requestDigest,
			});
		} catch (cause) {
			decisionResult = failure(
				"authorization_unavailable",
				cause instanceof Error ? cause.message : "artifact capability gateway failed",
				true,
			);
		}
		const decision = decisionResult.ok && validDecisionScope(request, decisionResult.value)
			? decisionResult.value
			: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				decision: "unavailable" as const,
			};
		const allowed = decision.decision === "allow";
		const logResult = await this.#accessLog.append({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: request.artifactId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
			operation,
			decision: allowed ? "allowed" : decision.decision === "unavailable" ? "unavailable" : "denied",
			...(request.forensicPurpose ? { purposeDigest: canonicalDigest(request.forensicPurpose) } : {}),
			timestamp: this.#clock().toISOString(),
		});
		if (!logResult.ok) return failure("durable_write_failed", "artifact access audit log is unavailable", true);
		if (!allowed) {
			return decision.decision === "unavailable"
				? failure("authorization_unavailable", "artifact capability gateway is unavailable", true)
				: failure("authorization_denied", `artifact access requires an allow decision, received ${decision.decision}`);
		}

		const release = this.#readLeases.acquire(metadata.value.storedDigest);
		if (!release) return failure("not_found", "artifact is pending garbage collection", true);
		try {
			const stored = await this.#cas.read(metadata.value.storedDigest);
			if (!stored.ok) return stored;
			const content = operation === "read_forensic"
				? await decryptForensicArtifact(
					{
						authorityId: request.authorityId,
						tenantId: request.tenantId,
						artifactId: request.artifactId,
						keyProvider: this.#keyProvider,
					},
					stored.value,
				)
				: stored;
			if (!content.ok) return content;
			return {
				ok: true,
				value: {
					metadata: metadata.value,
					content: content.value,
					...(decision.receiptId ? { authorizationReceiptId: decision.receiptId } : {}),
				},
			};
		} finally {
			release();
		}
	}
}
