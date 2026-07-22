/** 独立 tenant namespace 的高敏 forensic store；不复用 Artifact CAS 或 exporter spool。 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ArtifactKeyProvider } from "../artifacts/key-provider.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type PrincipalId,
	type ReceiptId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import {
	isForensicTracePermit,
	type ForensicTracePermit,
} from "./redaction.ts";
import {
	TELEMETRY_SCHEMA_VERSION,
	type TelemetryResult,
} from "./types.ts";

export const FORENSIC_STORE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_FORENSIC_MAX_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_FORENSIC_MAX_RECORD_BYTES = 16 * 1024 * 1024;

export interface ForensicStoreScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export type ForensicAccessOperation =
	| "write"
	| "read"
	| "metadata_read"
	| "legal_hold"
	| "release_hold"
	| "retention_delete"
	| "crypto_erase";

export interface ForensicAccessRequest extends ForensicStoreScope {
	operation: ForensicAccessOperation;
	principalId: PrincipalId;
	recordId: string;
	permitDigest?: string;
	purposeDigest: string;
	requestedAt: string;
}

export interface ForensicAccessDecision {
	allowed: boolean;
	requestDigest: string;
	receiptId: ReceiptId;
	policyDigest: string;
	decidedAt: string;
	expiresAt: string;
	receiptDigest: string;
}

export interface ForensicAccessControlPort {
	authorize(request: ForensicAccessRequest): Promise<ForensicAccessDecision>;
}

export interface ForensicLegalHold {
	holdId: string;
	policyDigest: string;
	placedBy: PrincipalId;
	placedAt: string;
}

export type ForensicRecordState = "active" | "erased" | "deleted";

export interface ForensicRecordMetadata extends ForensicStoreScope {
	schemaVersion: typeof FORENSIC_STORE_SCHEMA_VERSION;
	recordId: string;
	sessionId: SessionId;
	createdBy: PrincipalId;
	requestId: string;
	contentType: string;
	contentBytes: number;
	plaintextDigest: string;
	ciphertextDigest: string;
	contentEnvelopeDigest: string;
	keyEnvelopeDigest: string;
	keyVersion: string;
	permitDigest: string;
	sourceAuditReceiptId: ReceiptId;
	createdAt: string;
	retentionUntil: string;
	legalHold: ForensicLegalHold | null;
	state: ForensicRecordState;
	metadataDigest: string;
}

export interface ForensicRecordRef extends ForensicStoreScope {
	recordId: string;
	sessionId: SessionId;
	contentType: string;
	contentBytes: number;
	createdAt: string;
	retentionUntil: string;
	metadataDigest: string;
}

export interface ForensicWriteRequest {
	permit: ForensicTracePermit;
	content: Uint8Array;
	contentType: string;
	retentionUntil: string;
	purposeDigest: string;
}

export interface ForensicReadRequest extends ForensicStoreScope {
	recordId: string;
	principalId: PrincipalId;
	purposeDigest: string;
	at?: Date;
}

export interface ForensicLegalHoldRequest extends ForensicReadRequest {
	holdId: string;
	policyDigest: string;
	active: boolean;
}

export interface ForensicCryptoEraseRequest extends ForensicReadRequest {}

export interface ForensicRetentionRequest extends ForensicStoreScope {
	principalId: PrincipalId;
	purposeDigest: string;
	at?: Date;
}

export interface ForensicRetentionReceipt {
	deleted: readonly string[];
	held: readonly string[];
	denied: readonly string[];
}

export interface EncryptedForensicStoreOptions {
	rootDir: string;
	storeId: string;
	keyProvider: ArtifactKeyProvider;
	accessControl: ForensicAccessControlPort;
	maxRetentionMs?: number;
	maxRecordBytes?: number;
	clock?: () => Date;
}

interface AesGcmEnvelope {
	algorithm: "aes-256-gcm";
	iv: string;
	authTag: string;
	ciphertext: string;
	aadDigest: string;
	envelopeDigest: string;
}

interface WrappedKeyEnvelope extends AesGcmEnvelope {
	keyVersion: string;
}

interface ForensicAccessAuditEntry extends ForensicStoreScope {
	schemaVersion: typeof FORENSIC_STORE_SCHEMA_VERSION;
	auditId: string;
	recordId: string;
	operation: ForensicAccessOperation;
	principalId: PrincipalId;
	outcome: "allowed" | "denied" | "failed";
	requestDigest: string;
	accessReceiptId?: ReceiptId;
	accessReceiptDigest?: string;
	metadataDigest?: string;
	recordedAt: string;
	auditDigest: string;
}

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const recordId = Type.String({ pattern: "^forensic_[a-f0-9]{48}$", minLength: 57, maxLength: 57 });
const base64 = Type.String({ pattern: "^[A-Za-z0-9+/]*={0,2}$", maxLength: 32 * 1024 * 1024 });
const ForensicLegalHoldSchema = exact({
	holdId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minLength: 1, maxLength: 128 }),
	policyDigest: digest,
	placedBy: runtimeId("principal"),
	placedAt: timestamp,
});
const ForensicRecordMetadataSchema = exact({
	schemaVersion: Type.Literal(FORENSIC_STORE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	recordId,
	sessionId: runtimeId("session"),
	createdBy: runtimeId("principal"),
	requestId: runtimeId("command"),
	contentType: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9.+/-]*$", minLength: 1, maxLength: 128 }),
	contentBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	plaintextDigest: digest,
	ciphertextDigest: digest,
	contentEnvelopeDigest: digest,
	keyEnvelopeDigest: digest,
	keyVersion: Type.String({ minLength: 1, maxLength: 256 }),
	permitDigest: digest,
	sourceAuditReceiptId: runtimeId("receipt"),
	createdAt: timestamp,
	retentionUntil: timestamp,
	legalHold: Type.Union([Type.Null(), ForensicLegalHoldSchema]),
	state: Type.Union([Type.Literal("active"), Type.Literal("erased"), Type.Literal("deleted")]),
	metadataDigest: digest,
});
const AesGcmEnvelopeSchema = exact({
	algorithm: Type.Literal("aes-256-gcm"),
	iv: base64,
	authTag: base64,
	ciphertext: base64,
	aadDigest: digest,
	envelopeDigest: digest,
});
const WrappedKeyEnvelopeSchema = exact({
	algorithm: Type.Literal("aes-256-gcm"),
	iv: base64,
	authTag: base64,
	ciphertext: base64,
	aadDigest: digest,
	envelopeDigest: digest,
	keyVersion: Type.String({ minLength: 1, maxLength: 256 }),
});

function failure<T>(
	code:
		| "invalid_schema"
		| "scope_mismatch"
		| "forensic_denied"
		| "forensic_not_found"
		| "forensic_key_unavailable"
		| "forensic_retention_blocked"
		| "durable_write_failed",
	message: string,
	retryable = false,
): TelemetryResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function isDigest(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

function isCanonicalTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function metadataBody(metadata: ForensicRecordMetadata): Omit<ForensicRecordMetadata, "metadataDigest"> {
	const { metadataDigest: _metadataDigest, ...body } = metadata;
	return body;
}

function envelopeBody(envelope: AesGcmEnvelope): Omit<AesGcmEnvelope, "envelopeDigest"> {
	const { envelopeDigest: _envelopeDigest, ...body } = envelope;
	return body;
}

function wrappedKeyBody(envelope: WrappedKeyEnvelope): Omit<WrappedKeyEnvelope, "envelopeDigest"> {
	const { envelopeDigest: _envelopeDigest, ...body } = envelope;
	return body;
}

function decisionBody(decision: ForensicAccessDecision): Omit<ForensicAccessDecision, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = decision;
	return body;
}

function auditBody(entry: ForensicAccessAuditEntry): Omit<ForensicAccessAuditEntry, "auditDigest"> {
	const { auditDigest: _auditDigest, ...body } = entry;
	return body;
}

function encryptAesGcm(key: Uint8Array, plaintext: Uint8Array, aadDigest: string): AesGcmEnvelope {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aadDigest, "hex"));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const body: Omit<AesGcmEnvelope, "envelopeDigest"> = {
		algorithm: "aes-256-gcm",
		iv: iv.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		aadDigest,
	};
	return { ...body, envelopeDigest: canonicalDigest(body) };
}

function decryptAesGcm(key: Uint8Array, envelope: AesGcmEnvelope): Uint8Array {
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
	decipher.setAAD(Buffer.from(envelope.aadDigest, "hex"));
	decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
	return Uint8Array.from(Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, "base64")),
		decipher.final(),
	]));
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const parent = dirname(path);
	const temporary = join(parent, `.${randomUUID()}.partial`);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
		await syncDirectory(parent);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function appendDurable(path: string, content: string): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const handle = await open(path, "a", 0o600);
	try {
		await handle.writeFile(`${content}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(parent);
}

export class EncryptedForensicStore {
	readonly #rootDir: string;
	readonly #storeIdentityDigest: string;
	readonly #keyProvider: ArtifactKeyProvider;
	readonly #accessControl: ForensicAccessControlPort;
	readonly #maxRetentionMs: number;
	readonly #maxRecordBytes: number;
	readonly #clock: () => Date;

	public constructor(options: EncryptedForensicStoreOptions) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(options.storeId)) {
			throw new TypeError("forensic store id is invalid");
		}
		this.#rootDir = join(resolve(options.rootDir), "forensic-v1");
		this.#storeIdentityDigest = canonicalDigest({
			storeId: options.storeId,
			namespace: "forensic-v1",
			rootDigest: canonicalDigest(resolve(options.rootDir)),
		});
		this.#keyProvider = options.keyProvider;
		this.#accessControl = options.accessControl;
		this.#maxRetentionMs = Math.max(
			1,
			Math.min(3_650 * 24 * 60 * 60 * 1_000, Math.trunc(options.maxRetentionMs ?? DEFAULT_FORENSIC_MAX_RETENTION_MS)),
		);
		this.#maxRecordBytes = Math.max(
			1,
			Math.min(256 * 1024 * 1024, Math.trunc(options.maxRecordBytes ?? DEFAULT_FORENSIC_MAX_RECORD_BYTES)),
		);
		this.#clock = options.clock ?? (() => new Date());
	}

	public storeIdentityDigest(): string {
		return this.#storeIdentityDigest;
	}

	public async write(request: ForensicWriteRequest): Promise<TelemetryResult<ForensicRecordRef>> {
		const now = this.#clock();
		if (
			!isForensicTracePermit(request.permit) ||
			!Number.isFinite(now.getTime()) ||
			request.content.byteLength < 1 ||
			request.content.byteLength > this.#maxRecordBytes ||
			!/^[A-Za-z0-9][A-Za-z0-9.+/-]{0,127}$/.test(request.contentType) ||
			!isCanonicalTimestamp(request.retentionUntil) ||
			!isDigest(request.purposeDigest)
		) return failure("invalid_schema", "forensic write request is invalid");
		const validFrom = Date.parse(request.permit.validFrom);
		const validUntil = Date.parse(request.permit.validUntil);
		const retentionUntil = Date.parse(request.retentionUntil);
		if (
			now.getTime() < validFrom ||
			now.getTime() >= validUntil ||
			retentionUntil <= now.getTime() ||
			retentionUntil - now.getTime() > this.#maxRetentionMs
		) return failure("forensic_denied", "forensic permit or retention window is not active");

		const recordIdValue = `forensic_${canonicalDigest({
			permitDigest: request.permit.permitDigest,
			nonce: randomUUID(),
		}).slice(0, 48)}`;
		const access = await this.#authorize({
			operation: "write",
			authorityId: request.permit.authorityId,
			tenantId: request.permit.tenantId,
			principalId: request.permit.principalId,
			recordId: recordIdValue,
			permitDigest: request.permit.permitDigest,
			purposeDigest: request.purposeDigest,
			requestedAt: now.toISOString(),
		});
		if (!access.ok) return access;

		const scope = { authorityId: request.permit.authorityId, tenantId: request.permit.tenantId };
		const recordDirectory = this.#recordDirectory(scope, recordIdValue);
		const plaintextDigest = sha256(request.content);
		const contentAadDigest = canonicalDigest({
			...scope,
			recordId: recordIdValue,
			sessionId: request.permit.sessionId,
			contentType: request.contentType,
			contentBytes: request.content.byteLength,
			permitDigest: request.permit.permitDigest,
			createdAt: now.toISOString(),
			retentionUntil: request.retentionUntil,
		});
		const dataKey = randomBytes(32);
		let contentEnvelope: AesGcmEnvelope;
		try {
			contentEnvelope = encryptAesGcm(dataKey, request.content, contentAadDigest);
		} catch {
			dataKey.fill(0);
			return failure("forensic_key_unavailable", "forensic content encryption failed");
		}
		const wrapped = await this.#keyProvider.withKey(
			{ purpose: "forensic_encrypt" },
			(descriptor) => {
				const keyAadDigest = canonicalDigest({
					...scope,
					recordId: recordIdValue,
					contentEnvelopeDigest: contentEnvelope.envelopeDigest,
					keyVersion: descriptor.version,
				});
				const encrypted = encryptAesGcm(descriptor.key, dataKey, keyAadDigest);
				const body = { ...envelopeBody(encrypted), keyVersion: descriptor.version };
				return { ...body, envelopeDigest: canonicalDigest(body) } satisfies WrappedKeyEnvelope;
			},
		);
		dataKey.fill(0);
		if (!wrapped.ok) return failure("forensic_key_unavailable", "forensic key provider is unavailable", wrapped.error.retryable);

		const metadataWithoutDigest: Omit<ForensicRecordMetadata, "metadataDigest"> = {
			schemaVersion: FORENSIC_STORE_SCHEMA_VERSION,
			...scope,
			recordId: recordIdValue,
			sessionId: request.permit.sessionId,
			createdBy: request.permit.principalId,
			requestId: request.permit.requestId,
			contentType: request.contentType,
			contentBytes: request.content.byteLength,
			plaintextDigest,
			ciphertextDigest: sha256(Buffer.from(contentEnvelope.ciphertext, "base64")),
			contentEnvelopeDigest: contentEnvelope.envelopeDigest,
			keyEnvelopeDigest: wrapped.value.envelopeDigest,
			keyVersion: wrapped.value.keyVersion,
			permitDigest: request.permit.permitDigest,
			sourceAuditReceiptId: request.permit.auditReceiptId,
			createdAt: now.toISOString(),
			retentionUntil: request.retentionUntil,
			legalHold: null,
			state: "active",
		};
		const metadata: ForensicRecordMetadata = {
			...metadataWithoutDigest,
			metadataDigest: canonicalDigest(metadataWithoutDigest),
		};
		try {
			await writeAtomic(join(recordDirectory, "content.enc.json"), JSON.stringify(contentEnvelope));
			await writeAtomic(join(recordDirectory, "key.enc.json"), JSON.stringify(wrapped.value));
			await writeAtomic(join(recordDirectory, "metadata.json"), JSON.stringify(metadata));
			await this.#recordAudit(scope, recordIdValue, "write", request.permit.principalId, "allowed", access.value, metadata.metadataDigest, now);
		} catch {
			await rm(recordDirectory, { recursive: true, force: true }).catch(() => undefined);
			return failure("durable_write_failed", "forensic record or audit write failed", true);
		}
		return { ok: true, value: this.#recordRef(metadata) };
	}

	public async read(request: ForensicReadRequest): Promise<TelemetryResult<Uint8Array>> {
		const now = request.at ?? this.#clock();
		const loaded = await this.#loadMetadata(request, request.recordId);
		if (!loaded.ok) return loaded;
		const metadata = loaded.value;
		if (metadata.state !== "active") return failure("forensic_not_found", "forensic content is unavailable");
		const access = await this.#authorize({
			operation: "read",
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			recordId: request.recordId,
			permitDigest: metadata.permitDigest,
			purposeDigest: request.purposeDigest,
			requestedAt: now.toISOString(),
		});
		if (!access.ok) return access;
		const content = await this.#loadEnvelope<AesGcmEnvelope>(request, request.recordId, "content.enc.json", AesGcmEnvelopeSchema);
		const wrapped = await this.#loadEnvelope<WrappedKeyEnvelope>(request, request.recordId, "key.enc.json", WrappedKeyEnvelopeSchema);
		if (!content.ok || !wrapped.ok) return failure("forensic_not_found", "forensic encrypted envelope is unavailable");
		if (
			content.value.envelopeDigest !== metadata.contentEnvelopeDigest ||
			wrapped.value.envelopeDigest !== metadata.keyEnvelopeDigest ||
			wrapped.value.keyVersion !== metadata.keyVersion ||
			sha256(Buffer.from(content.value.ciphertext, "base64")) !== metadata.ciphertextDigest
		) return failure("invalid_schema", "forensic encrypted envelope does not match metadata");

		const decrypted = await this.#keyProvider.withKey(
			{ purpose: "forensic_decrypt", version: metadata.keyVersion },
			(descriptor) => {
				if (descriptor.version !== metadata.keyVersion) throw new Error("forensic key version mismatch");
				const dataKey = decryptAesGcm(descriptor.key, wrapped.value);
				try {
					return decryptAesGcm(dataKey, content.value);
				} finally {
					dataKey.fill(0);
				}
			},
		);
		if (!decrypted.ok || sha256(decrypted.value) !== metadata.plaintextDigest) {
			if (decrypted.ok) decrypted.value.fill(0);
			return failure("forensic_key_unavailable", "forensic content cannot be decrypted", !decrypted.ok && decrypted.error.retryable);
		}
		try {
			await this.#recordAudit(request, request.recordId, "read", request.principalId, "allowed", access.value, metadata.metadataDigest, now);
		} catch {
			decrypted.value.fill(0);
			return failure("durable_write_failed", "forensic read audit failed", true);
		}
		return { ok: true, value: decrypted.value };
	}

	public async inspect(request: ForensicReadRequest): Promise<TelemetryResult<ForensicRecordMetadata>> {
		const now = request.at ?? this.#clock();
		const loaded = await this.#loadMetadata(request, request.recordId);
		if (!loaded.ok) return loaded;
		const access = await this.#authorize({
			operation: "metadata_read",
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			recordId: request.recordId,
			purposeDigest: request.purposeDigest,
			permitDigest: loaded.value.permitDigest,
			requestedAt: now.toISOString(),
		});
		if (!access.ok) return access;
		try {
			await this.#recordAudit(request, request.recordId, "metadata_read", request.principalId, "allowed", access.value, loaded.value.metadataDigest, now);
		} catch {
			return failure("durable_write_failed", "forensic metadata audit failed", true);
		}
		return { ok: true, value: structuredClone(loaded.value) };
	}

	public async setLegalHold(request: ForensicLegalHoldRequest): Promise<TelemetryResult<ForensicRecordMetadata>> {
		const now = request.at ?? this.#clock();
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.holdId) || !isDigest(request.policyDigest)) {
			return failure("invalid_schema", "forensic legal hold request is invalid");
		}
		const loaded = await this.#loadMetadata(request, request.recordId);
		if (!loaded.ok) return loaded;
		if (loaded.value.state !== "active") return failure("forensic_not_found", "forensic record is not active");
		const operation = request.active ? "legal_hold" : "release_hold";
		if (!request.active && loaded.value.legalHold?.holdId !== request.holdId) {
			return failure("forensic_retention_blocked", "legal hold id does not match the active hold");
		}
		const access = await this.#authorize({
			operation,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			recordId: request.recordId,
			permitDigest: loaded.value.permitDigest,
			purposeDigest: request.purposeDigest,
			requestedAt: now.toISOString(),
		});
		if (!access.ok) return access;
		const withoutDigest: Omit<ForensicRecordMetadata, "metadataDigest"> = {
			...metadataBody(loaded.value),
			legalHold: request.active ? {
				holdId: request.holdId,
				policyDigest: request.policyDigest,
				placedBy: request.principalId,
				placedAt: now.toISOString(),
			} : null,
		};
		const updated = { ...withoutDigest, metadataDigest: canonicalDigest(withoutDigest) };
		try {
			await writeAtomic(join(this.#recordDirectory(request, request.recordId), "metadata.json"), JSON.stringify(updated));
			await this.#recordAudit(request, request.recordId, operation, request.principalId, "allowed", access.value, updated.metadataDigest, now);
		} catch {
			return failure("durable_write_failed", "forensic legal hold update failed", true);
		}
		return { ok: true, value: updated };
	}

	public async cryptoErase(request: ForensicCryptoEraseRequest): Promise<TelemetryResult<ForensicRecordMetadata>> {
		const now = request.at ?? this.#clock();
		const loaded = await this.#loadMetadata(request, request.recordId);
		if (!loaded.ok) return loaded;
		if (loaded.value.legalHold) return failure("forensic_retention_blocked", "active legal hold blocks crypto erase");
		if (loaded.value.state !== "active") return failure("forensic_not_found", "forensic record is not active");
		const access = await this.#authorize({
			operation: "crypto_erase",
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			recordId: request.recordId,
			permitDigest: loaded.value.permitDigest,
			purposeDigest: request.purposeDigest,
			requestedAt: now.toISOString(),
		});
		if (!access.ok) return access;
		const withoutDigest: Omit<ForensicRecordMetadata, "metadataDigest"> = {
			...metadataBody(loaded.value),
			state: "erased",
		};
		const updated = { ...withoutDigest, metadataDigest: canonicalDigest(withoutDigest) };
		try {
			await rm(join(this.#recordDirectory(request, request.recordId), "key.enc.json"), { force: true });
			await writeAtomic(join(this.#recordDirectory(request, request.recordId), "metadata.json"), JSON.stringify(updated));
			await this.#recordAudit(request, request.recordId, "crypto_erase", request.principalId, "allowed", access.value, updated.metadataDigest, now);
		} catch {
			return failure("durable_write_failed", "forensic crypto erase failed", true);
		}
		return { ok: true, value: updated };
	}

	public async purgeExpired(request: ForensicRetentionRequest): Promise<TelemetryResult<ForensicRetentionReceipt>> {
		const now = request.at ?? this.#clock();
		if (!this.#validScope(request) || !isRuntimeId(request.principalId, "principal") || !isDigest(request.purposeDigest)) {
			return failure("invalid_schema", "forensic retention request is invalid");
		}
		let recordIds: string[];
		try {
			recordIds = await readdir(join(this.#tenantRoot(request), "records"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: { deleted: [], held: [], denied: [] } };
			return failure("durable_write_failed", "forensic retention scan failed", true);
		}
		const deleted: string[] = [];
		const held: string[] = [];
		const denied: string[] = [];
		for (const candidate of recordIds.sort()) {
			if (!/^forensic_[a-f0-9]{48}$/.test(candidate)) continue;
			const loaded = await this.#loadMetadata(request, candidate);
			if (!loaded.ok || loaded.value.state !== "active" || Date.parse(loaded.value.retentionUntil) > now.getTime()) continue;
			if (loaded.value.legalHold) {
				held.push(candidate);
				continue;
			}
			const access = await this.#authorize({
				operation: "retention_delete",
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				recordId: candidate,
				permitDigest: loaded.value.permitDigest,
				purposeDigest: request.purposeDigest,
				requestedAt: now.toISOString(),
			});
			if (!access.ok) {
				denied.push(candidate);
				continue;
			}
			const withoutDigest: Omit<ForensicRecordMetadata, "metadataDigest"> = {
				...metadataBody(loaded.value),
				state: "deleted",
			};
			const updated = { ...withoutDigest, metadataDigest: canonicalDigest(withoutDigest) };
			try {
				const directory = this.#recordDirectory(request, candidate);
				await rm(join(directory, "key.enc.json"), { force: true });
				await rm(join(directory, "content.enc.json"), { force: true });
				await writeAtomic(join(directory, "metadata.json"), JSON.stringify(updated));
				await this.#recordAudit(request, candidate, "retention_delete", request.principalId, "allowed", access.value, updated.metadataDigest, now);
				deleted.push(candidate);
			} catch {
				return failure("durable_write_failed", "forensic retention delete failed", true);
			}
		}
		return { ok: true, value: { deleted, held, denied } };
	}

	async #authorize(request: ForensicAccessRequest): Promise<TelemetryResult<ForensicAccessDecision>> {
		if (!this.#validScope(request) || !isRuntimeId(request.principalId, "principal") || !isDigest(request.purposeDigest)) {
			return failure("invalid_schema", "forensic access request is invalid");
		}
		let decision: ForensicAccessDecision;
		try {
			decision = await this.#accessControl.authorize(request);
		} catch {
			try {
				await this.#recordAudit(request, request.recordId, request.operation, request.principalId, "failed", undefined, undefined, new Date(request.requestedAt));
			} catch {
				return failure("durable_write_failed", "forensic ACL failure audit could not be persisted", true);
			}
			return failure("forensic_denied", "forensic ACL is unavailable", true);
		}
		const requestedAt = Date.parse(request.requestedAt);
		if (
			!isRuntimeId(decision.receiptId, "receipt") ||
			!isDigest(decision.requestDigest) ||
			!isDigest(decision.policyDigest) ||
			!isCanonicalTimestamp(decision.decidedAt) ||
			!isCanonicalTimestamp(decision.expiresAt) ||
			decision.requestDigest !== canonicalDigest(request) ||
			decision.receiptDigest !== canonicalDigest(decisionBody(decision)) ||
			Date.parse(decision.decidedAt) > requestedAt ||
			Date.parse(decision.expiresAt) <= requestedAt
		) {
			try {
				await this.#recordAudit(request, request.recordId, request.operation, request.principalId, "failed", undefined, undefined, new Date(request.requestedAt));
			} catch {
				return failure("durable_write_failed", "invalid forensic ACL receipt audit could not be persisted", true);
			}
			return failure("forensic_denied", "forensic ACL receipt is invalid");
		}
		if (!decision.allowed) {
			try {
				await this.#recordAudit(request, request.recordId, request.operation, request.principalId, "denied", decision, undefined, new Date(request.requestedAt));
			} catch {
				return failure("durable_write_failed", "forensic ACL denial audit could not be persisted", true);
			}
			return failure("forensic_denied", "forensic ACL denied the operation");
		}
		return { ok: true, value: decision };
	}

	async #loadMetadata(
		scope: ForensicStoreScope,
		recordIdValue: string,
	): Promise<TelemetryResult<ForensicRecordMetadata>> {
		if (!this.#validScope(scope) || !/^forensic_[a-f0-9]{48}$/.test(recordIdValue)) {
			return failure("invalid_schema", "forensic record identity is invalid");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(join(this.#recordDirectory(scope, recordIdValue), "metadata.json"), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure("forensic_not_found", "forensic record was not found");
			return failure("durable_write_failed", "forensic metadata read failed", true);
		}
		if (!Check(ForensicRecordMetadataSchema, parsed)) return failure("invalid_schema", "forensic metadata schema is invalid");
		const metadata = parsed as unknown as ForensicRecordMetadata;
		if (
			metadata.authorityId !== scope.authorityId ||
			metadata.tenantId !== scope.tenantId ||
			metadata.recordId !== recordIdValue ||
			metadata.metadataDigest !== canonicalDigest(metadataBody(metadata))
		) return failure("scope_mismatch", "forensic metadata scope or digest does not match");
		return { ok: true, value: metadata };
	}

	async #loadEnvelope<T extends AesGcmEnvelope>(
		scope: ForensicStoreScope,
		recordIdValue: string,
		fileName: string,
		schema: TSchema,
	): Promise<TelemetryResult<T>> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(join(this.#recordDirectory(scope, recordIdValue), fileName), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure("forensic_not_found", "forensic encrypted envelope was not found");
			return failure("durable_write_failed", "forensic encrypted envelope read failed", true);
		}
		if (!Check(schema, parsed)) return failure("invalid_schema", "forensic encrypted envelope schema is invalid");
		const envelope = parsed as T;
		const expectedDigest = "keyVersion" in envelope
			? canonicalDigest(wrappedKeyBody(envelope as unknown as WrappedKeyEnvelope))
			: canonicalDigest(envelopeBody(envelope));
		if (envelope.envelopeDigest !== expectedDigest) return failure("invalid_schema", "forensic encrypted envelope digest is invalid");
		return { ok: true, value: envelope };
	}

	async #recordAudit(
		scope: ForensicStoreScope,
		recordIdValue: string,
		operation: ForensicAccessOperation,
		principalId: PrincipalId,
		outcome: "allowed" | "denied" | "failed",
		decision: ForensicAccessDecision | undefined,
		metadataDigest: string | undefined,
		at: Date,
	): Promise<void> {
		const withoutDigest: Omit<ForensicAccessAuditEntry, "auditDigest"> = {
			schemaVersion: FORENSIC_STORE_SCHEMA_VERSION,
			authorityId: scope.authorityId,
			tenantId: scope.tenantId,
			auditId: `forensic-audit-${canonicalDigest({ recordId: recordIdValue, operation, at: at.toISOString(), nonce: randomUUID() }).slice(0, 40)}`,
			recordId: recordIdValue,
			operation,
			principalId,
			outcome,
			requestDigest: decision?.requestDigest ?? canonicalDigest({ recordId: recordIdValue, operation, at: at.toISOString() }),
			...(decision ? { accessReceiptId: decision.receiptId, accessReceiptDigest: decision.receiptDigest } : {}),
			...(metadataDigest ? { metadataDigest } : {}),
			recordedAt: at.toISOString(),
		};
		const entry = { ...withoutDigest, auditDigest: canonicalDigest(withoutDigest) };
		await appendDurable(join(this.#tenantRoot(scope), "audit", "access.jsonl"), JSON.stringify(entry));
	}

	#recordRef(metadata: ForensicRecordMetadata): ForensicRecordRef {
		return {
			authorityId: metadata.authorityId,
			tenantId: metadata.tenantId,
			recordId: metadata.recordId,
			sessionId: metadata.sessionId,
			contentType: metadata.contentType,
			contentBytes: metadata.contentBytes,
			createdAt: metadata.createdAt,
			retentionUntil: metadata.retentionUntil,
			metadataDigest: metadata.metadataDigest,
		};
	}

	#validScope(scope: ForensicStoreScope): boolean {
		return isRuntimeId(scope.authorityId, "authority") && isRuntimeId(scope.tenantId, "tenant");
	}

	#tenantRoot(scope: ForensicStoreScope): string {
		return join(this.#rootDir, scope.authorityId, scope.tenantId);
	}

	#recordDirectory(scope: ForensicStoreScope, recordIdValue: string): string {
		return join(this.#tenantRoot(scope), "records", recordIdValue);
	}
}

export function createForensicAccessDecision(
	request: ForensicAccessRequest,
	input: {
		allowed: boolean;
		receiptId: ReceiptId;
		policyDigest: string;
		decidedAt: string;
		expiresAt: string;
	},
): ForensicAccessDecision {
	const body: Omit<ForensicAccessDecision, "receiptDigest"> = {
		allowed: input.allowed,
		requestDigest: canonicalDigest(request),
		receiptId: input.receiptId,
		policyDigest: input.policyDigest,
		decidedAt: input.decidedAt,
		expiresAt: input.expiresAt,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}
