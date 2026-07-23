/** Artifact 写入前的默认脱敏、keyed source receipt 与 forensic 加密。 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
import type { ArtifactRedactionClass } from "../protocol/v3/capability.ts";
import type { ApprovalId, ArtifactId, AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import type { ArtifactKeyProvider } from "./key-provider.ts";
import type {
	ArtifactEncryptionMetadata,
	ArtifactError,
	ArtifactKeyState,
	ArtifactRedactionPolicyRef,
	ArtifactResult,
	ArtifactSourceReceipt,
	ArtifactTransformReceipt,
} from "./types.ts";

export const DEFAULT_ARTIFACT_REDACTION_POLICY: ArtifactRedactionPolicyRef = {
	policyId: "runledger-default-redaction",
	version: 1,
};

const TEXT_MEDIA_TYPES = ["text/", "application/json", "application/xml", "application/javascript", "application/x-ndjson"];

interface ReplacementRule {
	pattern: RegExp;
	replacement: string;
}

const DEFAULT_REPLACEMENT_RULES: readonly ReplacementRule[] = [
	{
		pattern: /\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s\r\n]+/giu,
		replacement: "$1[REDACTED_CREDENTIAL]",
	},
	{
		pattern: /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*(["']?)[^\s,;"']+\2/giu,
		replacement: "$1=[REDACTED_CREDENTIAL]",
	},
	{
		pattern: /\b(?:sk|rk|pk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/gu,
		replacement: "[REDACTED_SECRET]",
	},
	{
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
		replacement: "[REDACTED_PRIVATE_KEY]",
	},
	{
		pattern: /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)(?:[\\/][^\s"'<>]*)?/gu,
		replacement: "[REDACTED_PATH]",
	},
	{
		pattern: /<system_prompt>[\s\S]*?<\/system_prompt>/giu,
		replacement: "[REDACTED_PROMPT]",
	},
	{
		pattern: /-----BEGIN PRIVATE PROMPT-----[\s\S]*?-----END PRIVATE PROMPT-----/giu,
		replacement: "[REDACTED_PROMPT]",
	},
];

export interface ArtifactTransformRequest {
	authorityId: AuthorityId;
	tenantId: TenantId;
	artifactId: ArtifactId;
	content: string | Uint8Array;
	mediaType: string;
	mode: "default" | "metadata_only" | "forensic";
	keyProvider: ArtifactKeyProvider;
	policy?: ArtifactRedactionPolicyRef;
	forensicAuthorization?: {
		approvalId: ApprovalId;
		purpose: string;
	};
}

export interface ArtifactTransformResult {
	storedContent: Uint8Array;
	originalSize: number;
	storedSize: number;
	storedDigest: string;
	redaction: ArtifactRedactionClass;
	sourceReceipt: ArtifactSourceReceipt;
	transformReceipt: ArtifactTransformReceipt;
	encryption?: ArtifactEncryptionMetadata;
}

interface ForensicEnvelopeV1 {
	envelopeVersion: 1;
	algorithm: "aes-256-gcm";
	keyVersion: string;
	iv: string;
	tag: string;
	ciphertext: string;
	aadDigest: string;
}

function error(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function bytesOf(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content);
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function isText(mediaType: string, original: string | Uint8Array): boolean {
	return typeof original === "string" || TEXT_MEDIA_TYPES.some((prefix) => mediaType.toLowerCase().startsWith(prefix));
}

function unavailableReceipt(state: ArtifactKeyState): ArtifactSourceReceipt {
	if (state === "lost") return { status: "unavailable", reason: "key_lost" };
	if (state === "rotating") return { status: "unavailable", reason: "key_rotating" };
	return { status: "unavailable", reason: "key_provider_unavailable" };
}

async function protectedSourceReceipt(
	content: Uint8Array,
	keyProvider: ArtifactKeyProvider,
): Promise<{ receipt: ArtifactSourceReceipt; keyState: ArtifactKeyState }> {
	let status: Awaited<ReturnType<ArtifactKeyProvider["status"]>>;
	try {
		status = await keyProvider.status();
	} catch {
		return { receipt: unavailableReceipt("unavailable"), keyState: "unavailable" };
	}
	if (status.state !== "available") return { receipt: unavailableReceipt(status.state), keyState: status.state };
	const keyed = await keyProvider.withKey({ purpose: "source_receipt", version: status.activeVersion }, (descriptor) => ({
		status: "protected" as const,
		scheme: "hmac-sha256" as const,
		keyVersion: descriptor.version,
		digest: createHmac("sha256", descriptor.key).update("runledger-artifact-source-v1\0").update(content).digest("hex"),
	}));
	if (!keyed.ok) return { receipt: unavailableReceipt(status.state), keyState: status.state };
	return { receipt: keyed.value, keyState: "available" };
}

function redactText(value: string): { text: string; replacementCount: number } {
	let text = value;
	let replacementCount = 0;
	for (const rule of DEFAULT_REPLACEMENT_RULES) {
		text = text.replace(rule.pattern, (...args: readonly unknown[]) => {
			replacementCount += 1;
			const match = args[0];
			if (typeof match !== "string") return rule.replacement;
			return match.replace(rule.pattern, rule.replacement);
		});
	}
	return { text, replacementCount };
}

function transformReceipt(
	policy: ArtifactRedactionPolicyRef,
	redaction: ArtifactRedactionClass,
	replacementCount: number,
	sourceReceipt: ArtifactSourceReceipt,
	keyState: ArtifactKeyState,
	storedDigest: string,
): ArtifactTransformReceipt {
	const receiptBody = { policy, redaction, replacementCount, sourceReceipt, keyState, storedDigest };
	const receiptDigest = canonicalDigest(receiptBody);
	return {
		receiptId: createRuntimeId("receipt", `artifact-${receiptDigest.slice(0, 32)}`),
		receiptDigest,
		policy,
		redaction,
		replacementCount,
		sourceReceipt,
		keyState,
	};
}

function aadFor(request: Pick<ArtifactTransformRequest, "authorityId" | "tenantId" | "artifactId">): Uint8Array {
	return Buffer.from(
		canonicalJson({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: request.artifactId,
			envelopeVersion: 1,
		}),
		"utf8",
	);
}

async function encryptForensic(
	request: ArtifactTransformRequest,
	content: Uint8Array,
): Promise<ArtifactResult<{ stored: Uint8Array; keyVersion: string }>> {
	if (
		!request.forensicAuthorization ||
		!isRuntimeId(request.forensicAuthorization.approvalId, "approval") ||
		request.forensicAuthorization.purpose.trim().length < 1
	) return error("authorization_denied", "forensic raw storage requires an explicit approval and purpose");

	const encrypted = await request.keyProvider.withKey({ purpose: "forensic_encrypt" }, (descriptor) => {
		const iv = randomBytes(12);
		const aad = aadFor(request);
		const cipher = createCipheriv("aes-256-gcm", descriptor.key, iv);
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
		const envelope: ForensicEnvelopeV1 = {
			envelopeVersion: 1,
			algorithm: "aes-256-gcm",
			keyVersion: descriptor.version,
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			aadDigest: sha256(aad),
		};
		return { stored: Buffer.from(canonicalJson(envelope), "utf8"), keyVersion: descriptor.version };
	});
	if (!encrypted.ok) return error("key_unavailable", encrypted.error.message, encrypted.error.retryable);
	return encrypted;
}

async function finishTransform(
	request: ArtifactTransformRequest,
	options: {
		storedContent: Uint8Array;
		redaction: ArtifactRedactionClass;
		replacementCount: number;
		sourceReceipt: ArtifactSourceReceipt;
		keyState: ArtifactKeyState;
		encryption?: ArtifactEncryptionMetadata;
	},
): Promise<ArtifactResult<ArtifactTransformResult>> {
	const original = bytesOf(request.content);
	const storedDigest = sha256(options.storedContent);
	const receipt = transformReceipt(
		request.policy ?? DEFAULT_ARTIFACT_REDACTION_POLICY,
		options.redaction,
		options.replacementCount,
		options.sourceReceipt,
		options.keyState,
		storedDigest,
	);
	return {
		ok: true,
		value: {
			storedContent: options.storedContent,
			originalSize: original.byteLength,
			storedSize: options.storedContent.byteLength,
			storedDigest,
			redaction: options.redaction,
			sourceReceipt: options.sourceReceipt,
			transformReceipt: receipt,
			...(options.encryption ? { encryption: options.encryption } : {}),
		},
	};
}

export async function transformArtifactContent(
	request: ArtifactTransformRequest,
): Promise<ArtifactResult<ArtifactTransformResult>> {
	const original = bytesOf(request.content);
	const source = await protectedSourceReceipt(original, request.keyProvider);

	try {
		if (request.mode === "forensic") {
			const encrypted = await encryptForensic(request, original);
			if (!encrypted.ok) return encrypted;
			return finishTransform(request, {
				storedContent: encrypted.value.stored,
				redaction: "encrypted_forensic",
				replacementCount: 0,
				sourceReceipt: source.receipt,
				keyState: "available",
				encryption: { algorithm: "aes-256-gcm", keyVersion: encrypted.value.keyVersion, envelopeVersion: 1 },
			});
		}
		if (request.mode === "metadata_only" || !isText(request.mediaType, request.content)) {
			return finishTransform(request, {
				storedContent: new Uint8Array(),
				redaction: "metadata_only",
				replacementCount: 0,
				sourceReceipt: source.receipt,
				keyState: source.keyState,
			});
		}
		const redacted = redactText(Buffer.from(original).toString("utf8"));
		return finishTransform(request, {
			storedContent: Buffer.from(redacted.text, "utf8"),
			redaction: "redacted",
			replacementCount: redacted.replacementCount,
			sourceReceipt: source.receipt,
			keyState: source.keyState,
		});
	} catch (cause) {
		return error("redaction_failed", cause instanceof Error ? cause.message : "artifact redaction failed");
	}
}

export async function transformLegacyArtifactContent(
	request: Omit<ArtifactTransformRequest, "mode" | "forensicAuthorization">,
): Promise<ArtifactResult<ArtifactTransformResult>> {
	try {
		const original = bytesOf(request.content);
		const redacted = isText(request.mediaType, request.content)
			? redactText(Buffer.from(original).toString("utf8"))
			: { text: "", replacementCount: 0 };
		return finishTransform(
			{ ...request, mode: "default" },
			{
				storedContent: Buffer.from(redacted.text, "utf8"),
				redaction: isText(request.mediaType, request.content) ? "redacted" : "metadata_only",
				replacementCount: redacted.replacementCount,
				sourceReceipt: { status: "legacy_unverified", reason: "legacy_tmp_import" },
				keyState: (await request.keyProvider.status()).state,
			},
		);
	} catch (cause) {
		return error("redaction_failed", cause instanceof Error ? cause.message : "legacy artifact redaction failed");
	}
}

function parseForensicEnvelope(content: Uint8Array): ForensicEnvelopeV1 | undefined {
	try {
		const value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (
			record.envelopeVersion !== 1 ||
			record.algorithm !== "aes-256-gcm" ||
			typeof record.keyVersion !== "string" ||
			typeof record.iv !== "string" ||
			typeof record.tag !== "string" ||
			typeof record.ciphertext !== "string" ||
			typeof record.aadDigest !== "string"
		) return undefined;
		return record as unknown as ForensicEnvelopeV1;
	} catch {
		return undefined;
	}
}

export async function decryptForensicArtifact(
	request: Pick<ArtifactTransformRequest, "authorityId" | "tenantId" | "artifactId" | "keyProvider">,
	storedContent: Uint8Array,
): Promise<ArtifactResult<Uint8Array>> {
	const envelope = parseForensicEnvelope(storedContent);
	if (!envelope) return error("digest_mismatch", "invalid forensic encryption envelope");
	const aad = aadFor(request);
	if (sha256(aad) !== envelope.aadDigest) return error("digest_mismatch", "forensic envelope scope mismatch");
	const decrypted = await request.keyProvider.withKey(
		{ purpose: "forensic_decrypt", version: envelope.keyVersion },
		(descriptor) => {
			const decipher = createDecipheriv("aes-256-gcm", descriptor.key, Buffer.from(envelope.iv, "base64"));
			decipher.setAAD(aad);
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
			return Uint8Array.from(
				Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]),
			);
		},
	);
	if (!decrypted.ok) return error("key_unavailable", decrypted.error.message, decrypted.error.retryable);
	return decrypted;
}
