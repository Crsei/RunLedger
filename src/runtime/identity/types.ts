/**
 * Runtime authority/tenant/principal 合同。
 *
 * TODO(runtime-phase-0): 接入受管 authority 与远程 principal 的生命周期，明确
 * OS-derived principal 的隐私边界；本地实现只用于 contract fixtures 和开发基线。
 */

import type { RuntimeContentRef } from "../protocol/foundation.ts";
import type { AuthorityId, PrincipalId, TenantId } from "../protocol/ids.ts";

interface IdentityContextBase {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly issuedAt: string;
}

export interface LocalIdentityContext extends IdentityContextBase {
	readonly principalKind: "local";
	readonly authenticationRef?: RuntimeContentRef;
	readonly attestationRef?: RuntimeContentRef;
}

export interface ServiceIdentityContext extends IdentityContextBase {
	readonly principalKind: "service";
	readonly authenticationRef: RuntimeContentRef;
	readonly attestationRef?: RuntimeContentRef;
}

export interface RemoteIdentityContext extends IdentityContextBase {
	readonly principalKind: "remote";
	readonly authenticationRef: RuntimeContentRef;
	readonly attestationRef: RuntimeContentRef;
}

export type IdentityContext = LocalIdentityContext | ServiceIdentityContext | RemoteIdentityContext;
