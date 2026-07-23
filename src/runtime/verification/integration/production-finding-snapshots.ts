/** Verification Finding immutable Artifact snapshot 的 production adapter。 */

import { canonicalDigest, canonicalJson } from "../../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type PrincipalId,
	type SessionId,
	type TenantId,
} from "../../protocol/v3/ids.ts";
import type { ArtifactCasStore, ArtifactRepository } from "../../artifacts/cas-store.ts";
import type { ArtifactMetadataStore } from "../../artifacts/metadata-store.ts";
import type {
	FindingSnapshotArtifactPort,
} from "../session-finding-repository.ts";
import type {
	VerificationCoreResult,
	VerificationFinding,
} from "../types.ts";

export const FINDING_SNAPSHOT_MEDIA_TYPE =
	"application/vnd.runledger.verification-finding+json";

export interface ProductionFindingSnapshotArtifactPortOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	principalId: PrincipalId;
	artifacts: ArtifactRepository;
	metadata: ArtifactMetadataStore;
	cas: ArtifactCasStore;
}

function failure<T>(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

export class ProductionFindingSnapshotArtifactPort
	implements FindingSnapshotArtifactPort
{
	readonly #options: ProductionFindingSnapshotArtifactPortOptions;

	public constructor(options: ProductionFindingSnapshotArtifactPortOptions) {
		this.#options = options;
	}

	public async write(
		finding: VerificationFinding,
	): Promise<VerificationCoreResult<ArtifactRef>> {
		if (
			finding.authorityId !== this.#options.authorityId ||
			finding.tenantId !== this.#options.tenantId
		) return failure("scope_mismatch", "Finding snapshot scope does not match the production session");
		const content = canonicalJson(finding);
		const findingDigest = canonicalDigest(finding);
		const artifactId = createRuntimeId("artifact", `finding-${findingDigest.slice(0, 48)}`);
		const intentId = createRuntimeId("command", `finding-${findingDigest.slice(0, 48)}`);
		const written = await this.#options.artifacts.write({
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			artifactId,
			intentId,
			principalId: this.#options.principalId,
			source: {
				sessionId: this.#options.sessionId,
				producerId: this.#options.principalId,
			},
			kind: "session_report",
			mediaType: FINDING_SNAPSHOT_MEDIA_TYPE,
			content,
			redaction: "default",
			lineage: {
				origin: "internal",
				inputSources: [],
				declassificationReceipts: [],
			},
		});
		if (!written.ok) {
			return failure("evidence_unavailable", "Finding snapshot Artifact write failed", written.error.retryable);
		}
		return written.value.state === "committed" && written.value.reference
			? { ok: true as const, value: written.value.reference }
			: failure("evidence_unavailable", "Finding snapshot Artifact did not commit");
	}

	public async read(
		artifactId: Parameters<FindingSnapshotArtifactPort["read"]>[0],
	): Promise<VerificationCoreResult<VerificationFinding | undefined>> {
		const reconciled = await this.#options.artifacts.reconcile({
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
		});
		if (!reconciled.ok) {
			return failure("evidence_unavailable", "Finding snapshot reconciliation failed", reconciled.error.retryable);
		}
		const metadata = await this.#options.metadata.readCommitted(
			this.#options.authorityId,
			this.#options.tenantId,
			artifactId,
		);
		if (!metadata.ok) {
			return metadata.error.code === "not_found"
				? { ok: true as const, value: undefined }
				: failure("invalid_digest", "Finding snapshot metadata is invalid");
		}
		if (
			metadata.value.kind !== "session_report" ||
			metadata.value.mediaType !== FINDING_SNAPSHOT_MEDIA_TYPE ||
			metadata.value.source.sessionId !== this.#options.sessionId
		) return failure("scope_mismatch", "Finding snapshot Artifact belongs to another scope");
		const stored = await this.#options.cas.read(metadata.value.storedDigest);
		if (!stored.ok) return failure("invalid_digest", "Finding snapshot blob is unavailable");
		let text: string;
		let parsed: unknown;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(stored.value);
			parsed = JSON.parse(text) as unknown;
		} catch {
			return failure("invalid_schema", "Finding snapshot is not canonical UTF-8 JSON");
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			canonicalJson(parsed) !== text ||
			canonicalDigest(parsed) !== metadata.value.storedDigest ||
			createRuntimeId("artifact", `finding-${canonicalDigest(parsed).slice(0, 48)}`) !== artifactId
		) return failure("invalid_digest", "Finding snapshot content does not match its Artifact identity");
		return { ok: true as const, value: parsed as VerificationFinding };
	}
}
