/**
 * Resource v1 的显式只读导入面。
 *
 * 当前无后缀 public contract 始终是 v2。这里不生成可执行 descriptor、snapshot、
 * cache ticket 或 approval；旧 approval 只能导入为重新批准要求。
 */

export const LEGACY_RESOURCE_SCHEMA_VERSION = 1 as const;
export const LEGACY_RESOURCE_PROTOCOL_VERSION = 1 as const;

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^(authority|tenant|resource|receipt)_[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

export interface LegacyResourceIdentityV1 {
	schemaVersion: 1;
	authorityId: string;
	tenantId: string;
	resourceId: string;
	kind: string;
	qualifiedId: string;
	version: string;
	source: string;
	digest: string;
}

export interface LegacyResourceManifestDigestV1 {
	schemaVersion: 1;
	rootDigest: string;
	manifestDigest: string;
	configDigest: string;
	commandDigest: string;
	assetsDigest: string;
	capabilityDigest: string;
	combinedDigest: string;
}

export interface LegacyResourceApprovalImportV1 {
	legacySchemaVersion: 1;
	receiptId: string;
	identityDigest: string;
	receiptDigest: string;
	state: "reapproval_required";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export function parseLegacyResourceIdentityV1(value: unknown): LegacyResourceIdentityV1 | undefined {
	const candidate = record(value);
	if (
		!candidate ||
		!exactKeys(candidate, [
			"schemaVersion",
			"authorityId",
			"tenantId",
			"resourceId",
			"kind",
			"qualifiedId",
			"version",
			"source",
			"digest",
		]) ||
		candidate.schemaVersion !== 1 ||
		typeof candidate.authorityId !== "string" ||
		typeof candidate.tenantId !== "string" ||
		typeof candidate.resourceId !== "string" ||
		typeof candidate.kind !== "string" ||
		typeof candidate.qualifiedId !== "string" ||
		typeof candidate.version !== "string" ||
		typeof candidate.source !== "string" ||
		typeof candidate.digest !== "string" ||
		!ID.test(candidate.authorityId) ||
		!ID.test(candidate.tenantId) ||
		!ID.test(candidate.resourceId) ||
		!DIGEST.test(candidate.digest)
	) return undefined;
	return candidate as unknown as LegacyResourceIdentityV1;
}

export function parseLegacyResourceManifestDigestV1(
	value: unknown,
): LegacyResourceManifestDigestV1 | undefined {
	const candidate = record(value);
	const keys = [
		"schemaVersion",
		"rootDigest",
		"manifestDigest",
		"configDigest",
		"commandDigest",
		"assetsDigest",
		"capabilityDigest",
		"combinedDigest",
	] as const;
	if (
		!candidate ||
		!exactKeys(candidate, keys) ||
		candidate.schemaVersion !== 1 ||
		keys.slice(1).some((key) => typeof candidate[key] !== "string" || !DIGEST.test(candidate[key]))
	) return undefined;
	return candidate as unknown as LegacyResourceManifestDigestV1;
}

export function importLegacyResourceApprovalV1(
	value: unknown,
): LegacyResourceApprovalImportV1 | undefined {
	const candidate = record(value);
	if (
		!candidate ||
		candidate.schemaVersion !== 1 ||
		typeof candidate.receiptId !== "string" ||
		typeof candidate.receiptDigest !== "string" ||
		!ID.test(candidate.receiptId) ||
		!DIGEST.test(candidate.receiptDigest)
	) return undefined;
	const identityDigest = typeof candidate.identityDigest === "string"
		? candidate.identityDigest
		: record(candidate.identity)?.digest;
	if (typeof identityDigest !== "string" || !DIGEST.test(identityDigest)) return undefined;
	return {
		legacySchemaVersion: 1,
		receiptId: candidate.receiptId,
		identityDigest,
		receiptDigest: candidate.receiptDigest,
		state: "reapproval_required",
	};
}
