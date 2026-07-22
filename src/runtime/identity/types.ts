/** Runtime authority/tenant/principal、签名与授权上下文合同。 */

import type {
	AuthorityId,
	PrincipalId,
	ReceiptId,
	RuntimeScope,
	SessionId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";

export type IdentitySource = "local-os" | "managed" | "remote";

export interface RuntimeIdentityContext extends RuntimeScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	source: IdentitySource;
	issuedAt: string;
}

/** 所有授权检查都必须绑定租户、主体、session 与 trace。 */
export interface RuntimeAuthorizationContext extends RuntimeIdentityContext {
	sessionId: SessionId;
	traceId: TraceId;
	credentialReceiptId?: ReceiptId;
}

/** 签名输入始终携带 authority/tenant，签名值本身由 Phase 1 signer port 产生。 */
export interface RuntimeSigningContext extends RuntimeScope {
	principalId: PrincipalId;
	signerId: string;
	keyVersion: string;
}
