/**
 * Resource contract 的最小纯校验函数。
 *
 * TODO(runtime-phase-5): 改为 TypeBox schema + unknown-version/unknown-field
 * fail-closed 校验，并加入 exact identity、receipt expiry 和 digest 绑定测试。
 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import type { ResourceIdentity, RuntimeToolInvocation } from "./types.ts";

export function resourceIdentityKey(identity: ResourceIdentity): string {
	return `${identity.kind}:${identity.qualifiedId}@${identity.version}:${identity.source}:${identity.digest}`;
}

export function resourceIdentityDigest(identity: ResourceIdentity): string {
	return canonicalDigest({
		kind: identity.kind,
		qualifiedId: identity.qualifiedId,
		version: identity.version,
		source: identity.source,
		digest: identity.digest,
	});
}

export function isResourceIdentity(value: unknown): value is ResourceIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return ["resourceId", "kind", "qualifiedId", "version", "source", "digest"].every(
		(field) => typeof candidate[field] === "string" && candidate[field] !== "",
	);
}

export function isRuntimeToolInvocation(value: unknown): value is RuntimeToolInvocation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.requestId === "string" &&
		isResourceIdentity(candidate.tool) &&
		typeof candidate.snapshotId === "string" &&
		typeof candidate.correlationId === "string" &&
		(candidate.decision === "allow" || candidate.decision === "ask" || candidate.decision === "deny") &&
		Array.isArray(candidate.requestedClaims)
	);
}
