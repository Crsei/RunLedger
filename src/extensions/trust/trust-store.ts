/** exact identity + path + digest 绑定的本地信任记录。 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { isAbsolute } from "node:path";
import { createRuntimeId, isRuntimeId, type PrincipalId } from "../../runtime/protocol/ids.ts";
import { isCanonicalUtcTimestamp, isRuntimeDigest } from "../../runtime/protocol/foundation-schemas.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { isResourceIdentity } from "../../runtime/resources/schemas.ts";
import type { ResourceApprovalReceipt, ResourceIdentity } from "../../runtime/resources/types.ts";
import type { ExtensionManifestDigest } from "./digest.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { ExtensionTrustScope, TrustDocument, TrustEvaluation, TrustRecord } from "./types.ts";

const emptyDocument = (): TrustDocument => ({ revision: 0, records: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TRUST_RECORD_KEYS = [
	"receiptId", "identity", "canonicalPath", "binding", "principalId", "scope", "issuedAt", "expiresAt", "revocationRevision",
	"locatorDigest", "publisherDigest", "policyRevision", "hookRevision", "adapterGeneration", "adapterGenerationDigest", "revokedAt", "receiptDigest",
] as const;

function isSha256(value: unknown): value is string {
	return isRuntimeDigest({ algorithm: "sha256", digest: value });
}

function isExtensionBinding(value: unknown): value is ExtensionManifestDigest {
	if (!isRecord(value)) return false;
	const fields = ["rootDigest", "manifestDigest", "configDigest", "commandDigest", "assetsDigest", "capabilityDigest", "combinedDigest"] as const;
	if (!isExactObject(value, fields) || !fields.every((field) => isSha256(value[field]))) return false;
	const { combinedDigest: _combinedDigest, ...body } = value as Record<string, string>;
	return canonicalDigest(body) === value.combinedDigest;
}

function isExactObject(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const optional = new Set(["revokedAt"]);
	return Object.keys(value).every((key) => keys.includes(key)) && keys.filter((key) => !optional.has(key)).every((key) => Object.hasOwn(value, key));
}

function isTrustRecord(value: unknown): value is TrustRecord {
	if (!isRecord(value)) return false;
	if (!isExactObject(value, TRUST_RECORD_KEYS)) return false;
	if (!(
			isRuntimeId(value.receiptId, "receipt") && isResourceIdentity(value.identity) && typeof value.canonicalPath === "string" && isAbsolute(value.canonicalPath) && isExtensionBinding(value.binding) && isRuntimeId(value.principalId, "principal") &&
		(value.scope === "session" || value.scope === "project" || value.scope === "user") &&
		isCanonicalUtcTimestamp(value.issuedAt) &&
		(value.expiresAt === null || (isCanonicalUtcTimestamp(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.issuedAt))) &&
		nonNegativeInteger(value.revocationRevision) && isSha256(value.locatorDigest) && (value.publisherDigest === null || isSha256(value.publisherDigest)) &&
		nonNegativeInteger(value.policyRevision) && nonNegativeInteger(value.hookRevision) && nonNegativeInteger(value.adapterGeneration) && isSha256(value.adapterGenerationDigest) &&
		(value.revokedAt === undefined || isCanonicalUtcTimestamp(value.revokedAt)) && isSha256(value.receiptDigest)
	)) return false;
	return true;
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function expectedLocatorDigest(record: TrustRecord): string {
	return canonicalDigest(record.canonicalPath);
}

function expectedReceiptDigest(record: TrustRecord): string {
	return canonicalDigest({ receiptId: record.receiptId, identity: record.identity, binding: record.binding, canonicalPath: record.canonicalPath, principalId: record.principalId, scope: record.scope });
}

function identityBindingKey(identity: ResourceIdentity): string {
	return `${identity.kind}\u0000${identity.qualifiedId}\u0000${identity.version}\u0000${identity.source}`;
}

function sameIdentity(left: ResourceIdentity, right: ResourceIdentity): boolean {
	return identityBindingKey(left) === identityBindingKey(right) &&
		left.resourceId === right.resourceId &&
		left.digest.algorithm === right.digest.algorithm &&
		left.digest.digest === right.digest.digest;
}

function sameBinding(left: ExtensionManifestDigest, right: ExtensionManifestDigest): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function runtimeDigest(value: string): RuntimeDigest {
	return { algorithm: "sha256", digest: value as RuntimeDigest["digest"] };
}

export function trustRecordToApprovalReceipt(record: TrustRecord): ResourceApprovalReceipt {
	return {
		receiptId: record.receiptId,
		identity: record.identity,
		manifestDigest: runtimeDigest(record.binding.manifestDigest),
		configDigest: runtimeDigest(record.binding.configDigest),
		commandDigest: runtimeDigest(record.binding.commandDigest),
		assetsDigest: runtimeDigest(record.binding.assetsDigest),
		capabilityDigest: runtimeDigest(record.binding.capabilityDigest),
		principalId: record.principalId,
		scope: record.scope,
		approvedAt: record.issuedAt,
		...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
		revocationRevision: record.revocationRevision,
	};
}

export class TrustStore {
	readonly #path: string;
	readonly #storage: ExtensionStoragePort;
	#loadError: string | undefined;

	public constructor(path: string, storage: ExtensionStoragePort) {
		this.#path = path;
		this.#storage = storage;
	}

	public async load(): Promise<TrustDocument> {
		const read = await this.#storage.readFile(this.#path, 1024 * 1024);
		if (!read.ok) {
			this.#loadError = read.code === "missing" ? undefined : read.message;
			return emptyDocument();
		}
		try {
			const parsed: unknown = JSON.parse(Buffer.from(read.value).toString("utf8"));
			const revision = isRecord(parsed) ? parsed.revision : undefined;
			if (!isRecord(parsed) || !isExactObject(parsed, ["revision", "records"]) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(parsed.records) || !parsed.records.every(isTrustRecord) || parsed.records.some((record) => !isTrustRecord(record) || record.locatorDigest !== expectedLocatorDigest(record) || record.receiptDigest !== expectedReceiptDigest(record))) {
				this.#loadError = "trust.json failed schema validation";
				return emptyDocument();
			}
			this.#loadError = undefined;
			return { revision, records: parsed.records };
		} catch {
			this.#loadError = "trust.json is invalid JSON";
			return emptyDocument();
		}
	}

	public loadError(): string | undefined {
		return this.#loadError;
	}

	public async grant(input: {
		readonly identity: ResourceIdentity;
		readonly canonicalPath: string;
		readonly binding: ExtensionManifestDigest;
		readonly principalId: PrincipalId;
		readonly scope: ExtensionTrustScope;
		readonly issuedAt?: string;
		readonly expiresAt?: string;
	}): Promise<TrustRecord> {
		const current = await this.load();
		const issuedAt = input.issuedAt ?? new Date().toISOString();
		const receiptId = createRuntimeId("receipt", canonicalDigest({ identity: input.identity, path: input.canonicalPath, binding: input.binding, principalId: input.principalId, scope: input.scope, issuedAt }).slice(0, 32));
		const record: TrustRecord = {
			receiptId,
			identity: input.identity,
			canonicalPath: input.canonicalPath,
			binding: input.binding,
			principalId: input.principalId,
			scope: input.scope,
			issuedAt,
			expiresAt: input.expiresAt ?? null,
			revocationRevision: 0,
			locatorDigest: canonicalDigest(input.canonicalPath),
			publisherDigest: null,
			policyRevision: 0,
			hookRevision: 0,
			adapterGeneration: 0,
			adapterGenerationDigest: canonicalDigest("extension-adapter-generation-0"),
			receiptDigest: canonicalDigest({ receiptId, identity: input.identity, binding: input.binding, canonicalPath: input.canonicalPath, principalId: input.principalId, scope: input.scope }),
		};
		const records = current.records.filter((item) => identityBindingKey(item.identity) !== identityBindingKey(input.identity));
		await this.save({ revision: current.revision + 1, records: [...records, record] });
		return record;
	}

	public async evaluate(input: {
		readonly identity: ResourceIdentity;
		readonly canonicalPath: string;
		readonly binding: ExtensionManifestDigest;
		readonly principalId: PrincipalId;
		readonly scope?: ExtensionTrustScope;
		readonly at?: Date;
	}): Promise<TrustEvaluation> {
		const document = await this.load();
		const record = document.records.find((item) => identityBindingKey(item.identity) === identityBindingKey(input.identity));
		if (!record) return { state: "untrusted", reason: "trust record is missing" };
		if (record.revokedAt) return { state: "revoked", reason: "trust record is revoked", record };
		if (!sameIdentity(record.identity, input.identity)) return { state: "stale", reason: "resource identity or digest changed", record };
		if (record.canonicalPath !== input.canonicalPath) return { state: "stale", reason: "resource canonical path changed", record };
		if (record.principalId !== input.principalId) return { state: "stale", reason: "trust principal changed", record };
		if (input.scope && record.scope !== input.scope) return { state: "stale", reason: "trust scope changed", record };
		if (!sameBinding(record.binding, input.binding)) return { state: "stale", reason: "resource content or capability digest changed", record };
		if (record.expiresAt && Date.parse(record.expiresAt) <= (input.at ?? new Date()).getTime()) return { state: "stale", reason: "trust record expired", record };
		return { state: "trusted", record, receipt: trustRecordToApprovalReceipt(record) };
	}

	public async revoke(identityOrQualifiedId: ResourceIdentity | string, at = new Date()): Promise<void> {
		const current = await this.load();
		const match = current.records.find((item) => typeof identityOrQualifiedId === "string" ? item.identity.qualifiedId === identityOrQualifiedId : identityBindingKey(item.identity) === identityBindingKey(identityOrQualifiedId));
		if (!match) return;
		const revision = match.revocationRevision + 1;
		const records = current.records.map((item) => item.receiptId === match.receiptId ? { ...item, revocationRevision: revision, revokedAt: at.toISOString() } : item);
		await this.save({ revision: current.revision + 1, records });
	}

	private async save(document: TrustDocument): Promise<void> {
		const written = await this.#storage.writeFileAtomic(this.#path, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"), { fileMode: 0o600, directoryMode: 0o700 });
		if (!written.ok) throw new Error(written.message);
	}
}
