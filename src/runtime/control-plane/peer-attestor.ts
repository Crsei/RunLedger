/** Listener peer identity attestation contract；OS credential/pipe ACL由外部adapter实现。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { PrincipalId, ReceiptId } from "../protocol/v3/ids.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import type { PeerConnectionEvidence } from "./local-peer.ts";
import type { ControlPlaneTransport } from "./types.ts";

export interface PeerCredentialAttestorDescriptorBody {
	contractId: "runledger.peer-credential-attestor";
	schemaVersion: 1;
	environment: "production" | "test";
	adapterId: string;
	implementationId: string;
	generation: number;
	generationDigest: string;
	principalId: PrincipalId;
}

export interface PeerCredentialAttestorDescriptor
	extends PeerCredentialAttestorDescriptorBody {
	descriptorDigest: string;
}

export interface PeerCredentialAttestationRequest {
	requestId: string;
	transport: Extract<ControlPlaneTransport, "sse" | "local_socket" | "named_pipe">;
	remoteAddress?: string;
	channelBindingDigest: string;
}

export interface PeerCredentialAttestationReceipt {
	receiptId: ReceiptId;
	requestId: string;
	requestDigest: string;
	descriptorDigest: string;
	generation: number;
	channelBindingDigest: string;
	principalId: PrincipalId;
	evidence: PeerConnectionEvidence;
	attestedAt: string;
	expiresAt: string;
	receiptDigest: string;
}

export interface PeerCredentialAttestorPort {
	readonly environment: "production" | "test";
	readonly descriptor: PeerCredentialAttestorDescriptor;
	preflight(): Promise<ControlPlaneResult<{
		descriptorDigest: string;
		recoveryEvidenceDigest: string;
	}>>;
	attest(
		request: PeerCredentialAttestationRequest,
		signal?: AbortSignal,
	): Promise<ControlPlaneResult<PeerCredentialAttestationReceipt>>;
}

export function peerCredentialAttestorDescriptorDigest(
	body: PeerCredentialAttestorDescriptorBody,
): string {
	return canonicalDigest(body);
}

export function isPeerCredentialAttestorDescriptor(
	value: PeerCredentialAttestorDescriptor,
): boolean {
	const { descriptorDigest, ...body } = value;
	return (
		value.contractId === "runledger.peer-credential-attestor" &&
		value.schemaVersion === 1 &&
		(value.environment === "production" || value.environment === "test") &&
		value.adapterId.length > 0 &&
		value.adapterId.length <= 512 &&
		value.implementationId.length > 0 &&
		value.implementationId.length <= 1_024 &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 1 &&
		/^[a-f0-9]{64}$/u.test(value.generationDigest) &&
		isRuntimeId(value.principalId, "principal") &&
		descriptorDigest === peerCredentialAttestorDescriptorDigest(body)
	);
}

export function peerCredentialAttestationRequestDigest(
	request: PeerCredentialAttestationRequest,
): string {
	return canonicalDigest(request);
}

export function isPeerCredentialAttestationReceipt(
	receipt: PeerCredentialAttestationReceipt,
	request: PeerCredentialAttestationRequest,
	descriptor: PeerCredentialAttestorDescriptor,
	at: Date,
): boolean {
	const { receiptDigest, ...body } = receipt;
	return (
		isRuntimeId(receipt.receiptId, "receipt") &&
		receipt.requestId === request.requestId &&
		receipt.requestDigest === peerCredentialAttestationRequestDigest(request) &&
		receipt.descriptorDigest === descriptor.descriptorDigest &&
		receipt.generation === descriptor.generation &&
		receipt.channelBindingDigest === request.channelBindingDigest &&
		receipt.principalId === descriptor.principalId &&
		receipt.evidence.transport === request.transport &&
		receipt.evidence.peerCredentialsVerified &&
		Date.parse(receipt.attestedAt) <= at.getTime() &&
		Date.parse(receipt.expiresAt) > at.getTime() &&
		receiptDigest === canonicalDigest(body)
	);
}
