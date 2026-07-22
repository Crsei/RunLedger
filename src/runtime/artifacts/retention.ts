/** Artifact TTL、pin、reference、legal hold 与 dry-run GC。 */

import type { ArtifactId, AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import type { ArtifactCasStore } from "./cas-store.ts";
import type { ArtifactMetadataStore } from "./metadata-store.ts";
import { finalizeArtifactMetadata } from "./metadata-store.ts";
import type { ArtifactReadLeaseRegistry } from "./access.ts";
import {
	artifactDeliveryAllowsLocalCleanup,
	isArtifactExternalDeliveryProjection,
} from "./external-delivery.ts";
import type {
	ArtifactError,
	ArtifactExternalDeliveryProjection,
	ArtifactLegalHold,
	ArtifactMetadata,
	ArtifactResult,
} from "./types.ts";

export interface ArtifactGcOptions {
	now?: Date;
	dryRun: boolean;
	/** production lifecycle adapter 可把一次删除严格限制到已审核的 Artifact refs。 */
	artifactIds?: readonly ArtifactId[];
	/** 出现外部投递记录时，只有 fully acknowledged 的投递允许本地副本进入 GC。 */
	externalDeliveries?: readonly ArtifactExternalDeliveryProjection[];
}

export interface ArtifactGcCandidate {
	artifactId: ArtifactId;
	storedDigest: string;
	action: "delete" | "retain";
	reason:
		| "expired_unreferenced"
		| "not_expired"
		| "pinned"
		| "referenced"
		| "legal_hold"
		| "active_read"
		| "external_delivery_pending"
		| "external_delivery_failed";
}

export interface ArtifactGcReport {
	dryRun: boolean;
	candidates: readonly ArtifactGcCandidate[];
	deletedArtifactIds: readonly ArtifactId[];
	deletedDigests: readonly string[];
	errors: readonly { artifactId: ArtifactId; error: ArtifactError }[];
}

export interface ArtifactRetentionServiceOptions {
	cas: ArtifactCasStore;
	metadata: ArtifactMetadataStore;
	readLeases: ArtifactReadLeaseRegistry;
}

function failure(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function updatedMetadata(metadata: ArtifactMetadata, patch: Partial<Pick<ArtifactMetadata, "expiresAt" | "pins" | "referenceCount" | "legalHold">>): ArtifactMetadata {
	const { metadataDigest: _metadataDigest, ...body } = metadata;
	return finalizeArtifactMetadata({ ...body, ...patch });
}

function classify(
	metadata: ArtifactMetadata,
	now: Date,
	activeReaders: number,
	deliveries: readonly ArtifactExternalDeliveryProjection[],
): ArtifactGcCandidate {
	if (metadata.legalHold.status === "active") {
		return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "retain", reason: "legal_hold" };
	}
	if (metadata.pins.length > 0) {
		return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "retain", reason: "pinned" };
	}
	if (metadata.referenceCount > 0) {
		return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "retain", reason: "referenced" };
	}
	if (activeReaders > 0) {
		return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "retain", reason: "active_read" };
	}
	if (deliveries.some((delivery) => !artifactDeliveryAllowsLocalCleanup(delivery))) {
		return {
			artifactId: metadata.artifactId,
			storedDigest: metadata.storedDigest,
			action: "retain",
			reason: deliveries.some((delivery) => delivery.state === "failed")
				? "external_delivery_failed"
				: "external_delivery_pending",
		};
	}
	if (!metadata.expiresAt || Date.parse(metadata.expiresAt) > now.getTime()) {
		return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "retain", reason: "not_expired" };
	}
	return { artifactId: metadata.artifactId, storedDigest: metadata.storedDigest, action: "delete", reason: "expired_unreferenced" };
}

export class ArtifactRetentionService {
	readonly #cas: ArtifactCasStore;
	readonly #metadata: ArtifactMetadataStore;
	readonly #readLeases: ArtifactReadLeaseRegistry;

	public constructor(options: ArtifactRetentionServiceOptions) {
		this.#cas = options.cas;
		this.#metadata = options.metadata;
		this.#readLeases = options.readLeases;
	}

	async #load(authorityId: AuthorityId, tenantId: TenantId, artifactId: ArtifactId): Promise<ArtifactResult<ArtifactMetadata>> {
		return this.#metadata.readCommitted(authorityId, tenantId, artifactId);
	}

	public async pin(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
		pin: string,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		if (pin.length < 1 || pin.length > 128) return failure("invalid_request", "artifact pin is invalid");
		const metadata = await this.#load(authorityId, tenantId, artifactId);
		if (!metadata.ok) return metadata;
		return this.#metadata.updateCommitted(updatedMetadata(metadata.value, { pins: [...new Set([...metadata.value.pins, pin])] }));
	}

	public async unpin(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
		pin: string,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		const metadata = await this.#load(authorityId, tenantId, artifactId);
		if (!metadata.ok) return metadata;
		return this.#metadata.updateCommitted(updatedMetadata(metadata.value, { pins: metadata.value.pins.filter((value) => value !== pin) }));
	}

	public async addReference(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		const metadata = await this.#load(authorityId, tenantId, artifactId);
		if (!metadata.ok) return metadata;
		return this.#metadata.updateCommitted(
			updatedMetadata(metadata.value, { referenceCount: metadata.value.referenceCount + 1 }),
		);
	}

	public async releaseReference(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		const metadata = await this.#load(authorityId, tenantId, artifactId);
		if (!metadata.ok) return metadata;
		if (metadata.value.referenceCount === 0) return failure("invalid_request", "artifact reference count is already zero");
		return this.#metadata.updateCommitted(
			updatedMetadata(metadata.value, { referenceCount: metadata.value.referenceCount - 1 }),
		);
	}

	public async setLegalHold(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
		legalHold: ArtifactLegalHold,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		if (legalHold.status === "active" && !legalHold.reasonDigest) {
			return failure("invalid_request", "active legal hold requires a reason digest");
		}
		const metadata = await this.#load(authorityId, tenantId, artifactId);
		if (!metadata.ok) return metadata;
		return this.#metadata.updateCommitted(updatedMetadata(metadata.value, { legalHold }));
	}

	public async collect(
		authorityId: AuthorityId,
		tenantId: TenantId,
		options: ArtifactGcOptions,
	): Promise<ArtifactResult<ArtifactGcReport>> {
		const listed = await this.#metadata.listCommitted(authorityId, tenantId);
		if (!listed.ok) return listed;
		const now = options.now ?? new Date();
		if (options.externalDeliveries?.some((delivery) =>
			!isArtifactExternalDeliveryProjection(delivery) ||
			delivery.authorityId !== authorityId ||
			delivery.tenantId !== tenantId
		)) return failure("invalid_request", "external Artifact delivery projection is invalid or out of scope");
		const requestedIds = options.artifactIds ? new Set(options.artifactIds) : undefined;
		const selected = requestedIds
			? listed.value.filter((metadata) => requestedIds.has(metadata.artifactId))
			: listed.value;
		const candidates = selected.map((metadata) =>
			classify(
				metadata,
				now,
				this.#readLeases.activeReaders(metadata.storedDigest),
				(options.externalDeliveries ?? []).filter((delivery) =>
					delivery.artifact.artifactId === metadata.artifactId &&
					delivery.artifact.storedDigest === metadata.storedDigest,
				),
			),
		);
		if (options.dryRun) {
			return { ok: true, value: { dryRun: true, candidates, deletedArtifactIds: [], deletedDigests: [], errors: [] } };
		}

		const deletingIds = new Set(candidates.filter((entry) => entry.action === "delete").map((entry) => entry.artifactId));
		const retainedDigests = new Set(
			listed.value.filter((metadata) => !deletingIds.has(metadata.artifactId)).map((metadata) => metadata.storedDigest),
		);
		const deletedArtifactIds: ArtifactId[] = [];
		const deletedDigests: string[] = [];
		const errors: { artifactId: ArtifactId; error: ArtifactError }[] = [];
		const reservations = new Map<string, () => void>();
		try {
			for (const candidate of candidates) {
				if (candidate.action !== "delete") continue;
				if (!reservations.has(candidate.storedDigest)) {
					const release = this.#readLeases.reserveDeletion(candidate.storedDigest);
					if (!release) {
						errors.push({
							artifactId: candidate.artifactId,
							error: { code: "durable_write_failed", message: "artifact gained an active reader during GC", retryable: true },
						});
						continue;
					}
					reservations.set(candidate.storedDigest, release);
				}
				const removed = await this.#metadata.removeCommitted(authorityId, tenantId, candidate.artifactId);
				if (!removed.ok) {
					errors.push({ artifactId: candidate.artifactId, error: removed.error });
					continue;
				}
				deletedArtifactIds.push(candidate.artifactId);
			}
			for (const digest of reservations.keys()) {
				if (retainedDigests.has(digest)) continue;
				const allDigestIds = listed.value.filter((metadata) => metadata.storedDigest === digest).map((metadata) => metadata.artifactId);
				if (!allDigestIds.every((artifactId) => deletedArtifactIds.includes(artifactId))) continue;
				const removed = await this.#cas.remove(digest);
				if (removed.ok) deletedDigests.push(digest);
				else errors.push({ artifactId: allDigestIds[0] as ArtifactId, error: removed.error });
			}
		} finally {
			for (const release of reservations.values()) release();
		}
		return { ok: true, value: { dryRun: false, candidates, deletedArtifactIds, deletedDigests, errors } };
	}
}
