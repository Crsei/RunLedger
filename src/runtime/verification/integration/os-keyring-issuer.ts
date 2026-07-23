/** OS keyring-backed verifier issuer；不从文件、环境变量或固定常量读取签名密钥。 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../protocol/v3/ids.ts";
import {
	OsKeyringArtifactKeyProvider,
	type ArtifactKeyProviderStatus,
} from "../../artifacts/key-provider.ts";
import { isVerificationResult } from "../evidence.ts";
import type { EpisodeSealSignerPort } from "../report.ts";
import {
	createVerifierReceipt,
	verifierSignatureInputDigest,
} from "../security.ts";
import type {
	TrustedVerifierIssuerDescriptor,
	VerificationCoreResult,
	VerificationResult,
	VerifierIssuerPort,
	VerifierReceipt,
	VerifierReceiptBody,
	VerifierSignature,
} from "../types.ts";

const SIGNATURE_DOMAIN = "runledger.verification-receipt.hmac-sha256.v1";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

function failure<T>(
	code: "invalid_schema" | "scope_mismatch" | "evidence_unavailable" | "stale_evidence" | "untrusted_issuer",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function versionKeyId(version: string): string {
	return `os-keyring-${canonicalDigest({ domain: SIGNATURE_DOMAIN, version }).slice(0, 32)}`;
}

function signaturePayload(issuerId: string, keyId: string, inputDigest: string): string {
	return `${SIGNATURE_DOMAIN}\0${issuerId}\0${keyId}\0${inputDigest}`;
}

function signWithKey(key: Uint8Array, issuerId: string, keyId: string, inputDigest: string): string {
	return createHmac("sha256", key).update(signaturePayload(issuerId, keyId, inputDigest), "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
	if (!HEX_SHA256.test(left) || !HEX_SHA256.test(right)) return false;
	const leftBytes = Buffer.from(left, "hex");
	const rightBytes = Buffer.from(right, "hex");
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function usableVersions(status: ArtifactKeyProviderStatus): readonly string[] | undefined {
	if (
		status.backend !== "os_keyring" ||
		status.state !== "available" ||
		!status.activeVersion ||
		status.activeVersion.length > 256 ||
		status.activeVersion.includes("\0")
	) return undefined;
	const versions = [...new Set([status.activeVersion, ...status.availableVersions])];
	if (versions.some((version) => !version || version.length > 256 || version.includes("\0"))) return undefined;
	return versions;
}

export interface OsKeyringVerifierComposition {
	issuer: VerifierIssuerPort;
	descriptor: TrustedVerifierIssuerDescriptor;
	episodeSealSigner: EpisodeSealSignerPort;
	activeKeyId: string;
	keyIds: readonly string[];
}

interface OsKeyringVerifierIssuerOptions {
	issuerId: string;
	keyProvider: OsKeyringArtifactKeyProvider;
	activeVersion: string;
	clock: () => Date;
}

class OsKeyringVerifierIssuer implements VerifierIssuerPort {
	readonly #issuerId: string;
	readonly #keyProvider: OsKeyringArtifactKeyProvider;
	readonly #activeVersion: string;
	readonly #activeKeyId: string;
	readonly #clock: () => Date;

	public constructor(options: OsKeyringVerifierIssuerOptions) {
		this.#issuerId = options.issuerId;
		this.#keyProvider = options.keyProvider;
		this.#activeVersion = options.activeVersion;
		this.#activeKeyId = versionKeyId(options.activeVersion);
		this.#clock = options.clock;
	}

	public async issue(result: VerificationResult): Promise<VerificationCoreResult<VerifierReceipt>> {
		if (!isVerificationResult(result)) return failure("invalid_schema", "verification result is invalid");
		if (result.runner.issuerId !== this.#issuerId) {
			return failure("scope_mismatch", "verification runner identity does not match the production issuer");
		}
		const issuedAt = this.#clock().toISOString();
		if (!Number.isFinite(Date.parse(issuedAt)) || Date.parse(issuedAt) < Date.parse(result.finishedAt)) {
			return failure("stale_evidence", "production verifier clock predates execution completion");
		}
		const body: VerifierReceiptBody = {
			schemaVersion: 1,
			authorityId: result.authorityId,
			tenantId: result.tenantId,
			receiptId: createRuntimeId(
				"receipt",
				`production-verifier-${canonicalDigest({ issuerId: this.#issuerId, keyId: this.#activeKeyId, resultDigest: result.resultDigest, issuedAt }).slice(0, 48)}`,
			),
			verificationId: result.verificationId,
			issuerId: this.#issuerId,
			resultDigest: result.resultDigest,
			gateDigest: result.gateDigest,
			baselineReceiptDigest: result.baseline.receiptDigest,
			candidateCommit: result.candidate.candidateCommit,
			outcome: result.outcome,
			issuedAt,
		};
		const inputDigest = verifierSignatureInputDigest(body);
		const signed = await this.#keyProvider.withKey(
			{ purpose: "source_receipt", version: this.#activeVersion },
			(descriptor) => descriptor.version === this.#activeVersion
				? signWithKey(descriptor.key, this.#issuerId, this.#activeKeyId, inputDigest)
				: undefined,
		);
		if (!signed.ok || signed.value === undefined) {
			return failure("evidence_unavailable", "OS keyring verifier key is unavailable", signed.ok ? false : signed.error.retryable);
		}
		return createVerifierReceipt(body, {
			algorithm: "hmac-sha256",
			keyId: this.#activeKeyId,
			value: signed.value,
		});
	}
}

export async function createOsKeyringVerifierComposition(options: {
	issuerId: string;
	keyProvider: OsKeyringArtifactKeyProvider;
	clock?: () => Date;
}): Promise<VerificationCoreResult<OsKeyringVerifierComposition>> {
	if (!options.issuerId || options.issuerId.length > 512 || options.issuerId.includes("\0")) {
		return failure("invalid_schema", "production verifier issuer id is invalid");
	}
	if (!(options.keyProvider instanceof OsKeyringArtifactKeyProvider)) {
		return failure("untrusted_issuer", "production verifier requires the OS keyring key provider");
	}
	let status: ArtifactKeyProviderStatus;
	try {
		status = await options.keyProvider.status();
	} catch {
		return failure("evidence_unavailable", "OS keyring verifier status is unavailable", true);
	}
	const versions = usableVersions(status);
	if (!versions || !status.activeVersion) {
		return failure("evidence_unavailable", "OS keyring verifier has no active production key", status.state !== "lost");
	}
	const activeVersion = status.activeVersion;
	const versionsByKeyId = new Map(versions.map((version) => [versionKeyId(version), version] as const));
	if (versionsByKeyId.size !== versions.length) {
		return failure("untrusted_issuer", "OS keyring verifier key identities are ambiguous");
	}
	const preflight = await options.keyProvider.withKey(
		{ purpose: "source_receipt", version: activeVersion },
		(descriptor) => descriptor.version === activeVersion && descriptor.key.byteLength === 32,
	);
	if (!preflight.ok || !preflight.value) {
		return failure("evidence_unavailable", "OS keyring verifier preflight failed", preflight.ok ? false : preflight.error.retryable);
	}
	const clock = options.clock ?? (() => new Date());
	const issuer = new OsKeyringVerifierIssuer({
		issuerId: options.issuerId,
		keyProvider: options.keyProvider,
		activeVersion,
		clock,
	});
	const descriptor: TrustedVerifierIssuerDescriptor = {
		issuerId: options.issuerId,
		environment: "production",
		schemaVersions: [1],
		algorithms: ["hmac-sha256"],
		keyIds: [...versionsByKeyId.keys()].sort(),
		verify: async (inputDigest: string, signature: VerifierSignature): Promise<boolean> => {
			if (signature.algorithm !== "hmac-sha256" || !HEX_SHA256.test(inputDigest)) return false;
			const version = versionsByKeyId.get(signature.keyId);
			if (!version) return false;
			const verified = await options.keyProvider.withKey(
				{ purpose: "source_receipt", version },
				(key) => key.version === version && constantTimeHexEqual(
					signWithKey(key.key, options.issuerId, signature.keyId, inputDigest),
					signature.value,
				),
			);
			return verified.ok && verified.value;
		},
	};
	const episodeSealSigner: EpisodeSealSignerPort = {
		descriptor: {
			issuerId: options.issuerId,
			schemaVersion: 1,
			algorithm: "hmac-sha256",
			keyId: versionKeyId(activeVersion),
		},
		sign: async (inputDigest) => {
			if (!HEX_SHA256.test(inputDigest)) {
				return failure("invalid_schema", "Episode seal signature input digest is invalid");
			}
			const keyId = versionKeyId(activeVersion);
			const signed = await options.keyProvider.withKey(
				{ purpose: "source_receipt", version: activeVersion },
				(key) => key.version === activeVersion
					? signWithKey(key.key, options.issuerId, keyId, inputDigest)
					: undefined,
			);
			return signed.ok && signed.value !== undefined
				? { ok: true, value: signed.value }
				: failure(
					"evidence_unavailable",
					"OS keyring Episode seal key is unavailable",
					signed.ok ? false : signed.error.retryable,
				);
		},
	};
	return {
		ok: true,
		value: {
			issuer,
			descriptor,
			episodeSealSigner,
			activeKeyId: versionKeyId(activeVersion),
			keyIds: descriptor.keyIds,
		},
	};
}
