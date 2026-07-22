/** Credential Broker 仅传 opaque material handle；secret 不进入 Runtime refs/events/普通环境对象。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type ResourceId, type RuntimeInstanceId } from "../../runtime/protocol/v3/ids.ts";
import type { SessionCredentialGrantRef } from "../../runtime/identity/enterprise-types.ts";
import type { SecurityResult } from "../types.ts";

export interface CredentialGrantRequest {
	authorityId: SessionCredentialGrantRef["authorityId"];
	tenantId: SessionCredentialGrantRef["tenantId"];
	principalId: SessionCredentialGrantRef["principalId"];
	sessionId: SessionCredentialGrantRef["sessionId"];
	credentialKind: string;
	audienceDigest: string;
	scopeDigest: string;
	requestedTtlMs: number;
	requestId: ReturnType<typeof createRuntimeId<"command">>;
}

/** handleId 可引用 keyring/KMS entry，但绝不包含 key/token/value。 */
export interface CredentialMaterialHandle {
	handleId: ResourceId;
	keyRefId: ResourceId;
	credentialKind: string;
	audienceDigest: string;
	providerRevision: number;
	expiresAt?: string;
}

export interface CredentialMaterialPort {
	resolve(request: CredentialGrantRequest, signal?: AbortSignal): Promise<SecurityResult<CredentialMaterialHandle>>;
	revoke(handle: CredentialMaterialHandle, signal?: AbortSignal): Promise<SecurityResult<void>>;
}

export interface CredentialInjectionRequest {
	targetRuntimeId: RuntimeInstanceId;
	targetExecutorId: ResourceId;
	executorAudienceDigest: string;
	grant: SessionCredentialGrantRef;
	material: CredentialMaterialHandle;
}

export interface CredentialInjectionReceipt {
	receiptId: ReturnType<typeof createRuntimeId<"receipt">>;
	grantId: SessionCredentialGrantRef["grantId"];
	targetRuntimeId: RuntimeInstanceId;
	targetExecutorId: ResourceId;
	audienceDigest: string;
	injectedAt: string;
	expiresAt: string;
	receiptDigest: string;
}

export interface CredentialExecutorInjectionPort {
	inject(request: CredentialInjectionRequest, signal?: AbortSignal): Promise<SecurityResult<Omit<CredentialInjectionReceipt, "receiptDigest">>>;
	revoke(receipt: CredentialInjectionReceipt, signal?: AbortSignal): Promise<SecurityResult<void>>;
}

interface ActiveCredentialGrant {
	grant: SessionCredentialGrantRef;
	material: CredentialMaterialHandle;
	revokedAt?: string;
}

function failure(code: "invalid_request" | "credential_unavailable" | "policy_denied", message: string, retryable = false): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

export class CredentialBroker {
	readonly #materials: CredentialMaterialPort;
	readonly #injection: CredentialExecutorInjectionPort;
	readonly #maxTtlMs: number;
	readonly #clock: () => Date;
	readonly #grants = new Map<SessionCredentialGrantRef["grantId"], ActiveCredentialGrant>();
	readonly #injections = new Map<CredentialInjectionReceipt["receiptId"], CredentialInjectionReceipt>();

	public constructor(
		materials: CredentialMaterialPort,
		injection: CredentialExecutorInjectionPort,
		maxTtlMs: number,
		clock: () => Date = () => new Date(),
	) {
		if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) throw new TypeError("credential max ttl must be a positive integer");
		this.#materials = materials;
		this.#injection = injection;
		this.#maxTtlMs = maxTtlMs;
		this.#clock = clock;
	}

	public async issue(request: CredentialGrantRequest, signal?: AbortSignal): Promise<SecurityResult<SessionCredentialGrantRef>> {
		if (
			!request.credentialKind || !/^[a-f0-9]{64}$/u.test(request.audienceDigest) || !/^[a-f0-9]{64}$/u.test(request.scopeDigest) ||
			!Number.isSafeInteger(request.requestedTtlMs) || request.requestedTtlMs <= 0 || request.requestedTtlMs > this.#maxTtlMs
		) return failure("invalid_request", "credential grant request is invalid");
		let material: SecurityResult<CredentialMaterialHandle>;
		try {
			material = await this.#materials.resolve(request, signal);
		} catch {
			return failure("credential_unavailable", "credential store is unavailable", true);
		}
		if (!material.ok) return material;
		if (material.value.credentialKind !== request.credentialKind || material.value.audienceDigest !== request.audienceDigest) {
			return failure("policy_denied", "credential material scope does not match request");
		}
		const issuedAt = this.#clock().toISOString();
		const requestedExpiry = new Date(this.#clock().getTime() + request.requestedTtlMs);
		const materialExpiry = material.value.expiresAt ? new Date(material.value.expiresAt) : requestedExpiry;
		const expiresAt = new Date(Math.min(requestedExpiry.getTime(), materialExpiry.getTime())).toISOString();
		if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return failure("credential_unavailable", "credential material is already expired");
		const body: Omit<SessionCredentialGrantRef, "receiptDigest"> = {
			schemaVersion: 1,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			grantId: createRuntimeId("receipt", canonicalDigest({ request, material: material.value.handleId, issuedAt, expiresAt }).slice(0, 48)),
			principalId: request.principalId,
			sessionId: request.sessionId,
			credentialKind: request.credentialKind,
			audienceDigest: request.audienceDigest,
			scopeDigest: request.scopeDigest,
			keyRefId: material.value.keyRefId,
			issuedAt,
			expiresAt,
		};
		const grant = { ...body, receiptDigest: canonicalDigest(body) };
		this.#grants.set(grant.grantId, { grant, material: material.value });
		return { ok: true, value: grant };
	}

	public async inject(
		grant: SessionCredentialGrantRef,
		target: { targetRuntimeId: RuntimeInstanceId; targetExecutorId: ResourceId; executorAudienceDigest: string },
		signal?: AbortSignal,
	): Promise<SecurityResult<CredentialInjectionReceipt>> {
		const active = this.#grants.get(grant.grantId);
		if (!active || active.revokedAt || active.grant.receiptDigest !== grant.receiptDigest ||
			active.grant.principalId !== grant.principalId || active.grant.sessionId !== grant.sessionId ||
			Date.parse(active.grant.expiresAt) <= this.#clock().getTime()) return failure("policy_denied", "credential grant is missing, stale, or revoked");
		if (target.executorAudienceDigest !== active.grant.audienceDigest) return failure("policy_denied", "executor audience does not match credential grant");
		let injected: SecurityResult<Omit<CredentialInjectionReceipt, "receiptDigest">>;
		try {
			injected = await this.#injection.inject({ ...target, grant: active.grant, material: active.material }, signal);
		} catch {
			return failure("credential_unavailable", "credential injection broker is unavailable", true);
		}
		if (!injected.ok) return injected;
		if (
			injected.value.grantId !== grant.grantId || injected.value.targetRuntimeId !== target.targetRuntimeId ||
			injected.value.targetExecutorId !== target.targetExecutorId || injected.value.audienceDigest !== target.executorAudienceDigest ||
			injected.value.expiresAt !== grant.expiresAt
		) return failure("credential_unavailable", "credential injection receipt is uncorrelated");
		const receipt = { ...injected.value, receiptDigest: canonicalDigest(injected.value) };
		this.#injections.set(receipt.receiptId, receipt);
		return { ok: true, value: receipt };
	}

	public async revoke(grantId: SessionCredentialGrantRef["grantId"], signal?: AbortSignal): Promise<SecurityResult<void>> {
		const active = this.#grants.get(grantId);
		if (!active) return failure("invalid_request", "credential grant was not found");
		if (active.revokedAt) return { ok: true, value: undefined };
		for (const receipt of this.#injections.values()) {
			if (receipt.grantId !== grantId) continue;
			const revoked = await this.#injection.revoke(receipt, signal);
			if (!revoked.ok) return revoked;
		}
		const materialRevoked = await this.#materials.revoke(active.material, signal);
		if (!materialRevoked.ok) return materialRevoked;
		this.#grants.set(grantId, { ...active, revokedAt: this.#clock().toISOString() });
		return { ok: true, value: undefined };
	}
}
