/** 本地进程 identity adapter；不属于可持久化 contract。 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createRuntimeId, type AuthorityId, type PrincipalId, type TenantId } from "./protocol/ids.ts";
import type { LocalIdentityContext } from "./identity/types.ts";

function localPrincipalSeed(): string {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
	return `${process.platform}:${uid}:${hostname()}`;
}

export function createLocalIdentityContext(now = new Date()): LocalIdentityContext {
	const principalDigest = createHash("sha256").update(localPrincipalSeed(), "utf8").digest("hex").slice(0, 32);
	return {
		authorityId: createRuntimeId("authority", "local") as AuthorityId,
		tenantId: createRuntimeId("tenant", "local") as TenantId,
		principalId: createRuntimeId("principal", principalDigest) as PrincipalId,
		principalKind: "local",
		issuedAt: now.toISOString(),
	};
}
