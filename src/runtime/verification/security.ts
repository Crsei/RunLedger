/** 受信 verifier issuer registry、签名输入与 terminal receipt 校验。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	episodeSealSignatureInputDigest,
	isEpisodeSeal,
} from "../artifacts/episode-manifest.ts";
import type { EpisodeSeal, EpisodeSealBody, EpisodeSealSignerIdentity } from "../artifacts/types.ts";
import { isVerificationResult } from "./evidence.ts";
import {
	VERIFICATION_OUTCOMES,
	VERIFIER_RECEIPT_SCHEMA_VERSION,
	type TrustedVerifierIssuerDescriptor,
	type VerificationCoreResult,
	type VerificationReport,
	type VerificationResult,
	type VerifierReceipt,
	type VerifierReceiptBody,
	type VerifierSignature,
} from "./types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const VerifierSignatureSchema = exact({
	algorithm: Type.Union([Type.Literal("ed25519"), Type.Literal("hmac-sha256")]),
	keyId: token,
	value: Type.String({ minLength: 1, maxLength: 16_384 }),
});

const VerifierReceiptBodySchema = exact({
	schemaVersion: Type.Literal(VERIFIER_RECEIPT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	verificationId: runtimeId("verification"),
	issuerId: token,
	resultDigest: digest,
	gateDigest: digest,
	baselineReceiptDigest: digest,
	candidateCommit: token,
	outcome: Type.Union(VERIFICATION_OUTCOMES.map((outcome) => Type.Literal(outcome))),
	issuedAt: timestamp,
});

export const VerifierReceiptSchema = exact({
	...VerifierReceiptBodySchema.properties,
	signature: VerifierSignatureSchema,
	receiptDigest: digest,
});

function failure(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "untrusted_issuer" | "invalid_signature" | "stale_evidence",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function receiptBody(receipt: VerifierReceipt): VerifierReceiptBody {
	const { signature: _signature, receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function episodeSealSignerIdentity(seal: EpisodeSeal): EpisodeSealSignerIdentity {
	const { signature: _signature, ...identity } = seal.signerAttestation;
	return identity;
}

function episodeSealSignatureInput(seal: EpisodeSeal): string {
	const { sealDigest: _sealDigest, signerAttestation: _attestation, ...body } = seal;
	const unsigned: Omit<EpisodeSealBody, "signerAttestation"> & { signerAttestation: EpisodeSealSignerIdentity } = {
		...body,
		signerAttestation: episodeSealSignerIdentity(seal),
	};
	return episodeSealSignatureInputDigest(unsigned);
}

export function verifierSignatureInputDigest(body: VerifierReceiptBody): string {
	return canonicalDigest(body);
}

export function verifierReceiptDigest(body: VerifierReceiptBody, signature: VerifierSignature): string {
	return canonicalDigest({ ...body, signature });
}

export function createVerifierReceipt(
	body: VerifierReceiptBody,
	signature: VerifierSignature,
): VerificationCoreResult<VerifierReceipt> {
	const receipt: VerifierReceipt = { ...body, signature, receiptDigest: verifierReceiptDigest(body, signature) };
	return isVerifierReceipt(receipt)
		? { ok: true, value: receipt }
		: failure("invalid_schema", "verifier receipt construction failed");
}

export function isVerifierReceipt(value: unknown): value is VerifierReceipt {
	if (!Check(VerifierReceiptSchema, value)) return false;
	const { signature, receiptDigest, ...body } = value;
	return receiptDigest === canonicalDigest({ ...body, signature });
}

export function isVerificationReport(value: unknown): value is VerificationReport {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<VerificationReport>;
	if (!candidate.result || !candidate.receipt || typeof candidate.reportDigest !== "string") return false;
	return (
		isVerificationResult(candidate.result) &&
		isVerifierReceipt(candidate.receipt) &&
		candidate.reportDigest === canonicalDigest({
			resultDigest: candidate.result.resultDigest,
			receiptDigest: candidate.receipt.receiptDigest,
		})
	);
}

export function createVerificationReport(
	result: VerificationResult,
	receipt: VerifierReceipt,
): VerificationCoreResult<VerificationReport> {
	if (!isVerificationResult(result) || !isVerifierReceipt(receipt)) {
		return failure("invalid_schema", "verification report inputs are invalid");
	}
	if (
		receipt.authorityId !== result.authorityId ||
		receipt.tenantId !== result.tenantId ||
		receipt.verificationId !== result.verificationId ||
		receipt.issuerId !== result.runner.issuerId ||
		receipt.resultDigest !== result.resultDigest ||
		receipt.gateDigest !== result.gateDigest ||
		receipt.baselineReceiptDigest !== result.baseline.receiptDigest ||
		receipt.candidateCommit !== result.candidate.candidateCommit ||
		receipt.outcome !== result.outcome
	) return failure("scope_mismatch", "verifier receipt is not correlated with result");
	return {
		ok: true,
		value: {
			result,
			receipt,
			reportDigest: canonicalDigest({ resultDigest: result.resultDigest, receiptDigest: receipt.receiptDigest }),
		},
	};
}

export interface TrustedVerifierIssuerRegistryOptions {
	environment: "production" | "test";
	clock?: () => Date;
	maxFutureSkewMs?: number;
}

export class TrustedVerifierIssuerRegistry {
	readonly #issuers = new Map<string, TrustedVerifierIssuerDescriptor>();
	readonly #environment: "production" | "test";
	readonly #clock: () => Date;
	readonly #maxFutureSkewMs: number;

	public constructor(options: TrustedVerifierIssuerRegistryOptions) {
		this.#environment = options.environment;
		this.#clock = options.clock ?? (() => new Date());
		this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 60_000;
	}

	public register(issuer: TrustedVerifierIssuerDescriptor): VerificationCoreResult<void> {
		if (!issuer.issuerId || issuer.schemaVersions.length === 0 || issuer.algorithms.length === 0 || issuer.keyIds.length === 0) {
			return failure("invalid_schema", "trusted verifier issuer descriptor is incomplete");
		}
		if (this.#environment === "production" && issuer.environment !== "production") {
			return failure("untrusted_issuer", "test-only verifier issuer cannot be registered in production");
		}
		if (this.#issuers.has(issuer.issuerId)) {
			return failure("untrusted_issuer", "verifier issuer id is already registered");
		}
		this.#issuers.set(issuer.issuerId, issuer);
		return { ok: true, value: undefined };
	}

	public async verify(report: VerificationReport): Promise<VerificationCoreResult<void>> {
		if (!isVerificationReport(report)) return failure("invalid_schema", "verification report is invalid");
		const { receipt, result } = report;
		const issuer = this.#issuers.get(receipt.issuerId);
		if (!issuer) return failure("untrusted_issuer", "verifier issuer is not registered");
		if (
			!issuer.schemaVersions.includes(receipt.schemaVersion) ||
			!issuer.algorithms.includes(receipt.signature.algorithm) ||
			!issuer.keyIds.includes(receipt.signature.keyId)
		) return failure("untrusted_issuer", "verifier receipt uses an unregistered schema, algorithm, or key");
		if (Date.parse(receipt.issuedAt) < Date.parse(result.finishedAt)) {
			return failure("stale_evidence", "verifier receipt predates execution completion");
		}
		if (Date.parse(receipt.issuedAt) > this.#clock().getTime() + this.#maxFutureSkewMs) {
			return failure("stale_evidence", "verifier receipt is unreasonably far in the future");
		}
		let valid = false;
		try {
			valid = await issuer.verify(verifierSignatureInputDigest(receiptBody(receipt)), receipt.signature);
		} catch {
			valid = false;
		}
		return valid ? { ok: true, value: undefined } : failure("invalid_signature", "verifier signature is invalid");
	}

	/** EpisodeSeal 使用相同受信 issuer registry，但签名输入与 verification receipt 分域。 */
	public async verifyEpisodeSeal(seal: EpisodeSeal): Promise<VerificationCoreResult<void>> {
		if (!isEpisodeSeal(seal)) return failure("invalid_schema", "Episode seal is invalid");
		const attestation = seal.signerAttestation;
		const issuer = this.#issuers.get(attestation.issuerId);
		if (!issuer) return failure("untrusted_issuer", "Episode seal issuer is not registered");
		if (
			!issuer.schemaVersions.includes(attestation.schemaVersion) ||
			!issuer.algorithms.includes(attestation.algorithm) ||
			!issuer.keyIds.includes(attestation.keyId)
		) return failure("untrusted_issuer", "Episode seal uses an unregistered schema, algorithm, or key");
		if (Date.parse(attestation.issuedAt) > this.#clock().getTime() + this.#maxFutureSkewMs) {
			return failure("stale_evidence", "Episode seal is unreasonably far in the future");
		}
		let valid = false;
		try {
			valid = await issuer.verify(episodeSealSignatureInput(seal), {
				algorithm: attestation.algorithm,
				keyId: attestation.keyId,
				value: attestation.signature,
			});
		} catch {
			valid = false;
		}
		return valid ? { ok: true, value: undefined } : failure("invalid_signature", "Episode seal signature is invalid");
	}

	/** 只有受信 issuer 签发的 passed terminal report 可以解锁 completed。 */
	public async verifyForCompletion(report: VerificationReport): Promise<boolean> {
		if (report.result.outcome !== "passed" || report.receipt.outcome !== "passed") return false;
		return (await this.verify(report)).ok;
	}
}
