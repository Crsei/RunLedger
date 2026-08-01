/**
 * 本地开发 authority/tenant/principal 生成器。
 *
 * TODO(runtime-phase-0): 生产环境应由受信配置/身份服务提供 authority 和 tenant，
 * 并把 principal 的重启、撤销和审计策略纳入 Runtime contract；这里不签发权限。
 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createRuntimeId, type AuthorityId, type PrincipalId, type TenantId } from "../protocol/ids.ts";
import type { RuntimeIdentityContext } from "./types.ts";

function localPrincipalSeed(): string {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
	return `${process.platform}:${uid}:${hostname()}`;
}

export function createLocalIdentityContext(now = new Date()): RuntimeIdentityContext {
	const principalDigest = createHash("sha256").update(localPrincipalSeed(), "utf8").digest("hex").slice(0, 32);
	return {
		authorityId: createRuntimeId("authority", "local") as AuthorityId,
		tenantId: createRuntimeId("tenant", "local") as TenantId,
		principalId: createRuntimeId("principal", principalDigest) as PrincipalId,
		source: "local-os",
		issuedAt: now.toISOString(),
	};
}
