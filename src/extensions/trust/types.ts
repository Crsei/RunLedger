import type { ResourceIdentity } from "../../runtime/resources/types.ts";
import type { PrincipalId, ReceiptId } from "../../runtime/protocol/ids.ts";
import type { ExtensionManifestDigest } from "./digest.ts";

export type ExtensionTrustScope = "session" | "project" | "user";

export interface TrustRecord {
	readonly receiptId: ReceiptId;
	readonly identity: ResourceIdentity;
	readonly canonicalPath: string;
	readonly binding: ExtensionManifestDigest;
	readonly principalId: PrincipalId;
	readonly scope: ExtensionTrustScope;
	readonly issuedAt: string;
	readonly expiresAt: string | null;
	readonly revocationRevision: number;
	readonly locatorDigest: string;
	readonly publisherDigest: string | null;
	readonly policyRevision: number;
	readonly hookRevision: number;
	readonly adapterGeneration: number;
	readonly adapterGenerationDigest: string;
	readonly revokedAt?: string;
	readonly receiptDigest: string;
}

export interface TrustDocument {
	readonly revision: number;
	readonly records: readonly TrustRecord[];
}

export type TrustEvaluation =
	| { readonly state: "trusted"; readonly record: TrustRecord; readonly receipt: import("../../runtime/resources/types.ts").ResourceApprovalReceipt }
	| { readonly state: "untrusted"; readonly reason: string }
	| { readonly state: "stale"; readonly reason: string; readonly record: TrustRecord }
	| { readonly state: "revoked"; readonly reason: string; readonly record: TrustRecord };
