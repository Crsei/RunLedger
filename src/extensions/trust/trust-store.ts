/** exact identity/content/capability 绑定的显式 TrustStore。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import { createResourceApprovalReceipt } from "../../runtime/resources/schemas.ts";
import type { ResourceApprovalReceipt, ResourceApprovalScope, ResourceIdentity, ResourceManifestDigest } from "../../runtime/resources/types.ts";
import type { PrincipalId } from "../../runtime/protocol/v3/ids.ts";
import type { TrustDocument, TrustEvaluation, TrustRecord } from "./types.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

const emptyDocument = (): TrustDocument => ({ schemaVersion: 1, revision: 0, records: [] });

function recordDigest(record: Omit<TrustRecord, "receiptDigest">): string {
	return canonicalDigest(record);
}

function parseDocument(value: unknown): TrustDocument | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const document = value as Record<string, unknown>;
	if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || !Array.isArray(document.records)) return undefined;
	const records: TrustRecord[] = [];
	for (const valueRecord of document.records) {
		if (typeof valueRecord !== "object" || valueRecord === null || Array.isArray(valueRecord)) return undefined;
		const record = valueRecord as TrustRecord;
		if (record.schemaVersion !== 1 || typeof record.receiptDigest !== "string") return undefined;
		const { receiptDigest, ...body } = record;
		if (recordDigest(body) !== receiptDigest) return undefined;
		records.push(record);
	}
	return { schemaVersion: 1, revision: document.revision as number, records };
}

export function trustRecordToApprovalReceipt(record: TrustRecord): ResourceApprovalReceipt {
	return createResourceApprovalReceipt({
		authorityId: record.identity.authorityId,
		tenantId: record.identity.tenantId,
		principalId: record.principalId,
		receiptId: record.receiptId,
		identity: record.identity,
		binding: record.binding,
		scope: record.scope,
		scopeBindingDigest: record.scopeBindingDigest,
		issuedAt: record.issuedAt,
		expiresAt: record.expiresAt,
		revocationRevision: record.revocationRevision,
		locatorDigest: record.locatorDigest,
		publisherDigest: record.publisherDigest,
		policyRevision: record.policyRevision,
		hookRevision: record.hookRevision,
		adapterGeneration: record.adapterGeneration,
		adapterGenerationDigest: record.adapterGenerationDigest,
		approvalState: "approved",
	});
}

export class TrustStore {
	readonly #path: string;
	readonly #storage: ExtensionStoragePort;
	#loadError?: string;

	public constructor(path: string, storage: ExtensionStoragePort) {
		this.#path = path;
		this.#storage = storage;
	}

	public async load(): Promise<TrustDocument> {
		try {
			const read = await this.#storage.readFile(this.#path, 1024 * 1024);
			if (!read.ok) {
				this.#loadError = read.code === "missing" ? undefined : read.message;
				return emptyDocument();
			}
			const parsed = parseDocument(JSON.parse(Buffer.from(read.value).toString("utf8")));
			if (!parsed) {
				this.#loadError = "trust.json failed schema or receipt integrity validation";
				return emptyDocument();
			}
			this.#loadError = undefined;
			return parsed;
		} catch {
			this.#loadError = "trust.json is invalid JSON";
			return emptyDocument();
		}
	}

	public loadError(): string | undefined {
		return this.#loadError;
	}

	async #save(document: TrustDocument): Promise<void> {
		const written = await this.#storage.writeFileAtomic(this.#path, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), { fileMode: 0o600, directoryMode: 0o700 });
		if (!written.ok) throw new Error(written.message);
	}

	public async grant(input: {
		identity: ResourceIdentity;
		canonicalPath: string;
		binding: ResourceManifestDigest;
		principalId: PrincipalId;
		scope: ResourceApprovalScope;
		expiresAt?: string | null;
		issuedAt?: string;
		publisherDigest?: string | null;
		policyRevision?: number;
		hookRevision?: number;
		adapterGeneration?: number;
		adapterGenerationDigest?: string;
	}): Promise<TrustRecord> {
		const current = await this.load();
		const issuedAt = input.issuedAt ?? new Date().toISOString();
		const bodyWithoutId = {
			schemaVersion: 1 as const,
			identity: input.identity,
			canonicalPath: input.canonicalPath,
			binding: input.binding,
			principalId: input.principalId,
			scope: input.scope,
			scopeBindingDigest: canonicalDigest({ scope: input.scope, canonicalPath: input.canonicalPath }),
			issuedAt,
			expiresAt: input.expiresAt ?? null,
			revocationRevision: current.revision + 1,
			locatorDigest: canonicalDigest(input.canonicalPath),
			publisherDigest: input.publisherDigest ?? null,
			policyRevision: input.policyRevision ?? 0,
			hookRevision: input.hookRevision ?? 0,
			adapterGeneration: input.adapterGeneration ?? 0,
			adapterGenerationDigest: input.adapterGenerationDigest ?? canonicalDigest({
				generation: input.adapterGeneration ?? 0,
				identity: input.identity,
			}),
		};
		const receiptId = createRuntimeId("receipt", canonicalDigest(bodyWithoutId).slice(0, 32));
		const body: Omit<TrustRecord, "receiptDigest"> = { ...bodyWithoutId, receiptId };
		const record: TrustRecord = { ...body, receiptDigest: recordDigest(body) };
		const records = current.records.filter((item) => item.identity.qualifiedId !== input.identity.qualifiedId);
		await this.#save({ schemaVersion: 1, revision: current.revision + 1, records: [...records, record] });
		return record;
	}

	public async revoke(qualifiedId: string, at = new Date()): Promise<TrustRecord | undefined> {
		const current = await this.load();
		const existing = current.records.find((record) => record.identity.qualifiedId === qualifiedId);
		if (!existing) return undefined;
		const { receiptDigest: _receiptDigest, ...oldBody } = existing;
		const body: Omit<TrustRecord, "receiptDigest"> = {
			...oldBody,
			revocationRevision: current.revision + 1,
			revokedAt: at.toISOString(),
		};
		const revoked: TrustRecord = { ...body, receiptDigest: recordDigest(body) };
		await this.#save({
			schemaVersion: 1,
			revision: current.revision + 1,
			records: current.records.map((record) => record.identity.qualifiedId === qualifiedId ? revoked : record),
		});
		return revoked;
	}

	public async evaluate(input: {
		identity: ResourceIdentity;
		canonicalPath: string;
		binding: ResourceManifestDigest;
		principalId: PrincipalId;
		at?: Date;
		publisherDigest?: string | null;
		policyRevision?: number;
		hookRevision?: number;
		adapterGeneration?: number;
		adapterGenerationDigest?: string;
	}): Promise<TrustEvaluation> {
		const current = await this.load();
		const record = current.records.find((item) => item.identity.qualifiedId === input.identity.qualifiedId);
		if (!record) return { state: "untrusted", reason: "no exact trust record" };
		if (record.revokedAt) return { state: "revoked", reason: "trust record was revoked", record };
		if (record.principalId !== input.principalId) return { state: "stale", reason: "principal binding changed", record };
		if (record.canonicalPath !== input.canonicalPath || canonicalDigest(record.identity) !== canonicalDigest(input.identity)) {
			return { state: "stale", reason: "resource identity or path changed", record };
		}
		if (record.binding.combinedDigest !== input.binding.combinedDigest || canonicalDigest(record.binding) !== canonicalDigest(input.binding)) {
			return { state: "stale", reason: "resource content or capability binding changed", record };
		}
		if (
			record.publisherDigest !== (input.publisherDigest ?? null) ||
			record.policyRevision !== (input.policyRevision ?? 0) ||
			record.hookRevision !== (input.hookRevision ?? 0) ||
			record.adapterGeneration !== (input.adapterGeneration ?? 0) ||
			record.adapterGenerationDigest !== (input.adapterGenerationDigest ?? canonicalDigest({
				generation: input.adapterGeneration ?? 0,
				identity: input.identity,
			}))
		) {
			return { state: "stale", reason: "policy, Hook, or adapter generation changed", record };
		}
		const at = input.at ?? new Date();
		if (record.expiresAt && new Date(record.expiresAt).getTime() <= at.getTime()) {
			return { state: "stale", reason: "trust record expired", record };
		}
		return { state: "trusted", record, receipt: trustRecordToApprovalReceipt(record) };
	}
}
