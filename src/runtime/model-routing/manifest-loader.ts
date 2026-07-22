import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isModelCompatibilityManifest } from "./schema.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
} from "./types.ts";

export type ModelManifestErrorCode =
	| "invalid_manifest"
	| "manifest_digest_mismatch"
	| "profile_digest_mismatch"
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
		profiles: manifest.profiles
			.map((profile) => ({
				...profileDigestInput(profile),
				profileId: profile.profileId,
				profileDigest: profile.profileDigest,
			}))
			.sort((left, right) => String(left.profileId).localeCompare(String(right.profileId))),
	};
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
		compatibilityHashes: Object.freeze({ ...profile.compatibilityHashes }),
		verifiedAliases: Object.freeze([...profile.verifiedAliases]),
		capabilityClaims: Object.freeze(profile.capabilityClaims.map((claim) => Object.freeze({ ...claim }))),
		regressionSuite: Object.freeze({ ...profile.regressionSuite }),
	});
}

/** 加载、校验并稳定排序 contract-owned manifest，不创建第二套协议。 */
export function loadModelCompatibilityManifest(input: unknown): ModelCompatibilityManifest {
	if (!isModelCompatibilityManifest(input)) {
		throw new ModelManifestError("invalid_manifest", "model compatibility manifest failed schema or scope validation");
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
