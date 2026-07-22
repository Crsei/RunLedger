import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { CapabilityClaim } from "../protocol/v3/capability.ts";
import type {
	ModelCapabilityAlias,
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
} from "./types.ts";

function claimKey(claim: CapabilityClaim): string {
	return canonicalDigest(claim);
}

export function profileProvidesCapabilities(
	profile: ModelCapabilityProfile,
	required: readonly CapabilityClaim[],
): boolean {
	const available = new Set(profile.capabilityClaims.map(claimKey));
	return required.every((claim) => available.has(claimKey(claim)));
}

/** alias 解析严格只选择 verified + regression passed 的 profile，并稳定按 digest/ID 排序。 */
export function resolveModelProfiles(
	manifest: ModelCompatibilityManifest,
	alias: ModelCapabilityAlias,
): readonly ModelCapabilityProfile[] {
	return manifest.profiles
		.filter(
			(profile) =>
				profile.status === "verified" &&
				profile.regressionSuite.passed &&
				profile.verifiedAliases.includes(alias),
		)
		.slice()
		.sort((left, right) =>
			left.profileDigest.localeCompare(right.profileDigest) ||
			left.profileId.localeCompare(right.profileId) ||
			left.modelId.localeCompare(right.modelId),
		);
}
