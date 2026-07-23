import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isModelCompatibilityManifest } from "./schema.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
	ModelProfileEvidence,
} from "./types.ts";
import {
	PI_AI_CATALOG_DIGEST,
	PI_AI_PARITY_MANIFEST_DIGEST,
	PI_AI_UPSTREAM_COMMIT,
	RUNLEDGER_PARITY_BASE_COMMIT,
} from "./types.ts";

export type ModelManifestErrorCode =
	| "invalid_manifest"
	| "manifest_digest_mismatch"
	| "profile_digest_mismatch"
	| "profile_evidence_mismatch"
	| "parity_binding_mismatch"
	| "duplicate_profile"
	| "ambiguous_model";

export class ModelManifestError extends Error {
	public readonly code: ModelManifestErrorCode;

	public constructor(code: ModelManifestErrorCode, message: string) {
		super(message);
		this.name = "ModelManifestError";
		this.code = code;
	}
}

function profileDigestInput(profile: ModelCapabilityProfile): Readonly<Record<string, unknown>> {
	const { manifestDigest: _manifestDigest, profileDigest: _profileDigest, ...content } = profile;
	return Object.fromEntries(Object.entries(content).filter(([, value]) => value !== undefined));
}

function manifestDigestInput(manifest: ModelCompatibilityManifest): Readonly<Record<string, unknown>> {
	return {
		schemaVersion: manifest.schemaVersion,
		authorityId: manifest.authorityId,
		tenantId: manifest.tenantId,
		manifestId: manifest.manifestId,
		revision: manifest.revision,
		generatedAt: manifest.generatedAt,
		piAiParityManifestDigest: manifest.piAiParityManifestDigest,
		catalogDigest: manifest.catalogDigest,
		upstreamCommit: manifest.upstreamCommit,
		runLedgerBaseCommit: manifest.runLedgerBaseCommit,
		profiles: manifest.profiles
			.map((profile) => ({
				...profileDigestInput(profile),
				profileId: profile.profileId,
				profileDigest: profile.profileDigest,
			}))
			.sort((left, right) => String(left.profileId).localeCompare(String(right.profileId))),
	};
}

function profileEvidenceDigestInput(
	evidence: ModelProfileEvidence,
): Omit<ModelProfileEvidence, "evidenceDigest"> {
	const { evidenceDigest: _evidenceDigest, ...body } = evidence;
	return body;
}

export function calculateModelProfileEvidenceDigest(evidence: ModelProfileEvidence): string {
	return canonicalDigest(profileEvidenceDigestInput(evidence));
}

export function calculateModelProfileDigest(profile: ModelCapabilityProfile): string {
	return canonicalDigest(profileDigestInput(profile));
}

export function calculateModelManifestDigest(manifest: ModelCompatibilityManifest): string {
	return canonicalDigest(manifestDigestInput(manifest));
}

function freezeProfile(profile: ModelCapabilityProfile): ModelCapabilityProfile {
	return Object.freeze({
		...profile,
		evidence: Object.freeze({ ...profile.evidence }),
		compatibilityHashes: Object.freeze({ ...profile.compatibilityHashes }),
		verifiedAliases: Object.freeze([...profile.verifiedAliases]),
		capabilityClaims: Object.freeze(profile.capabilityClaims.map((claim) => Object.freeze({ ...claim }))),
		regressionSuite: Object.freeze({ ...profile.regressionSuite }),
	});
}

function hasCurrentParityBinding(manifest: ModelCompatibilityManifest): boolean {
	return (
		manifest.piAiParityManifestDigest === PI_AI_PARITY_MANIFEST_DIGEST &&
		manifest.catalogDigest === PI_AI_CATALOG_DIGEST &&
		manifest.upstreamCommit === PI_AI_UPSTREAM_COMMIT &&
		manifest.runLedgerBaseCommit === RUNLEDGER_PARITY_BASE_COMMIT
	);
}

function profileMatchesManifestEvidence(
	manifest: ModelCompatibilityManifest,
	profile: ModelCapabilityProfile,
): boolean {
	return (
		profile.evidence.piAiParityManifestDigest === manifest.piAiParityManifestDigest &&
		profile.evidence.catalogDigest === manifest.catalogDigest &&
		profile.evidence.upstreamCommit === manifest.upstreamCommit &&
		profile.evidence.runLedgerBaseCommit === manifest.runLedgerBaseCommit &&
		profile.evidence.compatibilityEvidenceDigest === canonicalDigest(profile.compatibilityHashes) &&
		profile.evidence.evidenceDigest === calculateModelProfileEvidenceDigest(profile.evidence)
	);
}

/** 加载、校验并稳定排序 contract-owned manifest，不创建第二套协议。 */
export function loadModelCompatibilityManifest(input: unknown): ModelCompatibilityManifest {
	if (!isModelCompatibilityManifest(input)) {
		throw new ModelManifestError("invalid_manifest", "model compatibility manifest failed schema or scope validation");
	}
	if (!hasCurrentParityBinding(input)) {
		throw new ModelManifestError(
			"parity_binding_mismatch",
			"model compatibility manifest does not bind the current pi-ai parity and catalog baseline",
		);
	}

	const profileIds = new Set<string>();
	const modelIds = new Set<string>();
	for (const profile of input.profiles) {
		if (profileIds.has(profile.profileId)) {
			throw new ModelManifestError("duplicate_profile", `duplicate profile ${profile.profileId}`);
		}
		if (modelIds.has(profile.modelId)) {
			throw new ModelManifestError("ambiguous_model", `model ${profile.modelId} resolves to more than one profile`);
		}
		profileIds.add(profile.profileId);
		modelIds.add(profile.modelId);
		if (!profileMatchesManifestEvidence(input, profile)) {
			throw new ModelManifestError(
				"profile_evidence_mismatch",
				`profile ${profile.profileId} evidence does not match the manifest or compatibility hashes`,
			);
		}
		if (calculateModelProfileDigest(profile) !== profile.profileDigest) {
			throw new ModelManifestError("profile_digest_mismatch", `profile ${profile.profileId} digest mismatch`);
		}
	}
	if (calculateModelManifestDigest(input) !== input.manifestDigest) {
		throw new ModelManifestError("manifest_digest_mismatch", "manifest digest mismatch");
	}

	return Object.freeze({
		...input,
		profiles: Object.freeze(
			input.profiles
				.map(freezeProfile)
				.sort((left, right) => left.profileId.localeCompare(right.profileId)),
		),
	});
}
