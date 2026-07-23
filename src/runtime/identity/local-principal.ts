/** 本地 authority/tenant 与 OS-derived principal 基线。 */

import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { createRuntimeId, type AuthorityId, type PrincipalId, type TenantId } from "../protocol/v3/ids.ts";
import type { RuntimeIdentityContext } from "./types.ts";

export const LOCAL_AUTHORITY_ID = createRuntimeId("authority", "local") as AuthorityId;
export const LOCAL_TENANT_ID = createRuntimeId("tenant", "local") as TenantId;

function localPrincipalSeed(): string {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
	return `${process.platform}:${uid}:${hostname()}`;
}

export function createLocalIdentityContext(now = new Date()): RuntimeIdentityContext {
	if (!Number.isFinite(now.getTime())) throw new RangeError("local identity issuedAt must be a valid date");
	const principalDigest = createHash("sha256").update(localPrincipalSeed(), "utf8").digest("hex").slice(0, 32);
	return {
		authorityId: LOCAL_AUTHORITY_ID,
		tenantId: LOCAL_TENANT_ID,
		principalId: createRuntimeId("principal", principalDigest) as PrincipalId,
		source: "local-os",
		issuedAt: now.toISOString(),
	};
}
