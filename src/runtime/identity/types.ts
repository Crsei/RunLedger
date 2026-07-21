/**
 * Runtime authority/tenant/principal 合同。
 *
 * TODO(runtime-phase-0): 接入受管 authority 与远程 principal 的生命周期，明确
 * OS-derived principal 的隐私边界；本地实现只用于 contract fixtures 和开发基线。
 */

import type { AuthorityId, PrincipalId, TenantId } from "../protocol/v3/ids.ts";

export type IdentitySource = "local-os" | "managed" | "remote";

export interface RuntimeIdentityContext {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	source: IdentitySource;
	issuedAt: string;
}
