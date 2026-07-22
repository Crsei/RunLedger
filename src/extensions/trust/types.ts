import type { ResourceApprovalReceipt, ResourceApprovalScope, ResourceIdentity, ResourceManifestDigest } from "../../runtime/resources/types.ts";
import type { PrincipalId, ReceiptId } from "../../runtime/protocol/v3/ids.ts";

export interface TrustRecord {
	schemaVersion: 1;
	receiptId: ReceiptId;
	identity: ResourceIdentity;
	canonicalPath: string;
	binding: ResourceManifestDigest;
	principalId: PrincipalId;
	scope: ResourceApprovalScope;
	scopeBindingDigest: string;
	issuedAt: string;
	expiresAt: string | null;
	revocationRevision: number;
	revokedAt?: string;
	receiptDigest: string;
}

export interface TrustDocument {
	schemaVersion: 1;
	revision: number;
	records: readonly TrustRecord[];
}

export type TrustEvaluation =
	| { state: "trusted"; record: TrustRecord; receipt: ResourceApprovalReceipt }
	| { state: "untrusted"; reason: string }
	| { state: "stale"; reason: string; record: TrustRecord }
	| { state: "revoked"; reason: string; record: TrustRecord };
