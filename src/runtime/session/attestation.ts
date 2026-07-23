/** Session genesis/head 的可插拔 signer 与 anchor receipt；无 signer 时显式 unattested。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { AttestationStatus, EventCursor, IntegrityStatus } from "../protocol/v3/events.ts";
import type { AuthorityId, ReceiptId, SessionId, TenantId } from "../protocol/v3/ids.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { SessionResult } from "./types.ts";

export interface SessionHeadClaim {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	cursor: EventCursor;
	integrity: IntegrityStatus;
	issuedAt: string;
}

export interface SignedHeadProof {
	signerId: string;
	keyVersion: string;
	signature: string;
}

export interface SessionHeadAttestationReceipt extends SessionHeadClaim {
	receiptId: ReceiptId;
	claimDigest: string;
	attestation: AttestationStatus;
	anchorStatus: "not_requested" | "anchored" | "unavailable";
	proof?: SignedHeadProof;
	anchorReceiptId?: ReceiptId;
}

export interface SessionHeadSigner {
	sign(claimDigest: string, claim: SessionHeadClaim): Promise<SessionResult<SignedHeadProof>>;
}

export interface SessionHeadAnchor {
	anchor(receipt: SessionHeadAttestationReceipt): Promise<SessionResult<ReceiptId>>;
}

export async function createSessionHeadAttestation(
	claim: SessionHeadClaim,
	options: { signer?: SessionHeadSigner; anchor?: SessionHeadAnchor } = {},
): Promise<SessionResult<SessionHeadAttestationReceipt>> {
	const claimDigest = canonicalDigest(claim);
	const receiptId = createRuntimeId("receipt");
	if (!options.signer) {
		return {
			ok: true,
			value: { ...claim, receiptId, claimDigest, attestation: "unattested", anchorStatus: "not_requested" },
		};
	}
	let signed: SessionResult<SignedHeadProof>;
	try {
		signed = await options.signer.sign(claimDigest, claim);
	} catch {
		return {
			ok: true,
			value: { ...claim, receiptId, claimDigest, attestation: "unavailable", anchorStatus: "not_requested" },
		};
	}
	if (!signed.ok) {
		return {
			ok: true,
			value: { ...claim, receiptId, claimDigest, attestation: "unavailable", anchorStatus: "not_requested" },
		};
	}
	let receipt: SessionHeadAttestationReceipt = {
		...claim,
		receiptId,
		claimDigest,
		attestation: "attested",
		anchorStatus: "not_requested",
		proof: signed.value,
	};
	if (options.anchor) {
		try {
			const anchored = await options.anchor.anchor(receipt);
			if (!anchored.ok) return { ok: true, value: { ...receipt, anchorStatus: "unavailable" } };
			receipt = { ...receipt, anchorReceiptId: anchored.value, anchorStatus: "anchored" };
		} catch {
			return { ok: true, value: { ...receipt, anchorStatus: "unavailable" } };
		}
	}
	return { ok: true, value: receipt };
}
