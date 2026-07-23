/** Security CredentialBroker 到 Runtime 中立 CredentialBrokerPort 的 fail-closed 适配层。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	isCredentialAudienceValidationRequest,
	isCredentialGrantIssueRequest,
	isCredentialGrantRevocationRequest,
	isSessionCredentialGrantRef,
} from "../../runtime/identity/enterprise-schemas.ts";
import type { CredentialBrokerPort } from "../../runtime/identity/enterprise-ports.ts";
import type {
	CredentialAudienceValidationReceiptRef,
	CredentialAudienceValidationRequest,
	CredentialGrantIssueRequest,
	CredentialGrantRevocationReceiptRef,
	CredentialGrantRevocationRequest,
	EnterprisePortError,
	EnterprisePortResult,
	SessionCredentialGrantRef,
} from "../../runtime/identity/enterprise-types.ts";
import type { CredentialBroker } from "../enterprise/credential-broker.ts";
import type { SecurityResult } from "../types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_CREDENTIAL_TTL_LIMIT_MS = 86_400_000;

type WithoutReceiptDigest<T> = T extends { receiptDigest: string } ? Omit<T, "receiptDigest"> : never;
type CredentialAudienceReceiptBody = WithoutReceiptDigest<CredentialAudienceValidationReceiptRef>;
type CredentialRevocationReceiptBody = WithoutReceiptDigest<CredentialGrantRevocationReceiptRef>;

export interface CredentialAudienceBindingRequest {
	schemaVersion: 1;
	authorityId: CredentialAudienceValidationRequest["authorityId"];
	tenantId: CredentialAudienceValidationRequest["tenantId"];
	requestId: CredentialAudienceValidationRequest["requestId"];
	principalId: CredentialAudienceValidationRequest["principalId"];
	sessionId: CredentialAudienceValidationRequest["sessionId"];
	grantId: SessionCredentialGrantRef["grantId"];
	credentialKind: string;
	scopeDigest: string;
	targetKind: CredentialAudienceValidationRequest["targetKind"];
	targetExecutorId: CredentialAudienceValidationRequest["targetExecutorId"];
	invocationDigest: string;
	requestedAt: string;
}

/** 受信配置或 executor registry 返回的 audience 绑定；不包含 credential material。 */
export interface CredentialAudienceBindingRef extends CredentialAudienceBindingRequest {
	audienceDigest: string;
	issuedAt: string;
	expiresAt?: string;
	bindingDigest: string;
}

export interface CredentialAudienceBindingResolverPort {
	resolve(
		request: CredentialAudienceBindingRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialAudienceBindingRef>>;
}

export interface RuntimeCredentialBrokerAdapterOptions {
	broker: CredentialBroker;
	audienceResolver: CredentialAudienceBindingResolverPort;
	/** Runtime 可签发的硬上限；生产值应显著短于 provider credential 生命周期。 */
	maxGrantTtlMs: number;
	maxRequestAgeMs?: number;
	allowedClockSkewMs?: number;
	clock?: () => Date;
}

interface CachedCall<T> {
	requestDigest: string;
	result: Promise<EnterprisePortResult<T>>;
}

interface AudienceValidationResolution {
	result: EnterprisePortResult<CredentialAudienceValidationReceiptRef>;
	/** 仅 valid receipt 设置；到期后必须重新询问 audience resolver。 */
	validUntilMs?: number;
}

interface CachedValidation {
	requestDigest: string;
	grantId: SessionCredentialGrantRef["grantId"];
	resolution: Promise<AudienceValidationResolution>;
}

interface ActiveGrantRecord {
	grant: SessionCredentialGrantRef;
	revokedAt?: string;
	revocation?: Promise<SecurityResult<void>>;
}

function failure(
	code: EnterprisePortError["code"],
	reason: string,
	retryable = false,
): EnterprisePortResult<never> {
	return {
		ok: false,
		error: {
			code,
			retryable,
			reasonDigest: DIGEST_PATTERN.test(reason) ? reason : canonicalDigest(reason),
		},
	};
}

function securityFailure(error: Extract<SecurityResult<never>, { ok: false }>["error"]): EnterprisePortResult<never> {
	switch (error.code) {
		case "invalid_request":
			return failure("invalid_request", "credential broker rejected an invalid request", error.retryable);
		case "policy_denied":
			return failure("denied", "credential broker policy denied the request", error.retryable);
		case "credential_unavailable":
			return failure("unavailable", "credential broker material is unavailable", error.retryable);
		default:
			return failure("unavailable", "credential broker failed closed", error.retryable);
	}
}

function grantHasValidDigest(grant: SessionCredentialGrantRef): boolean {
	const { receiptDigest, ...body } = grant;
	return receiptDigest === canonicalDigest(body);
}

function audienceBindingHasValidDigest(binding: CredentialAudienceBindingRef): boolean {
	const { bindingDigest, ...body } = binding;
	return DIGEST_PATTERN.test(binding.audienceDigest) && DIGEST_PATTERN.test(binding.scopeDigest) &&
		bindingDigest === canonicalDigest(body);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

export class RuntimeCredentialBrokerAdapter implements CredentialBrokerPort {
	readonly #broker: CredentialBroker;
	readonly #audienceResolver: CredentialAudienceBindingResolverPort;
	readonly #maxGrantTtlMs: number;
	readonly #maxRequestAgeMs: number;
	readonly #allowedClockSkewMs: number;
	readonly #clock: () => Date;
	readonly #grants = new Map<SessionCredentialGrantRef["grantId"], ActiveGrantRecord>();
	readonly #issueCalls = new Map<string, CachedCall<SessionCredentialGrantRef>>();
	readonly #validationCalls = new Map<string, CachedValidation>();
	readonly #revocationCalls = new Map<string, CachedCall<CredentialGrantRevocationReceiptRef>>();

	public constructor(options: RuntimeCredentialBrokerAdapterOptions) {
		if (
			!Number.isSafeInteger(options.maxGrantTtlMs) || options.maxGrantTtlMs <= 0 ||
			options.maxGrantTtlMs > RUNTIME_CREDENTIAL_TTL_LIMIT_MS
		) throw new TypeError("runtime credential max ttl must be a positive supported integer");
		const maxRequestAgeMs = options.maxRequestAgeMs ?? 60_000;
		const allowedClockSkewMs = options.allowedClockSkewMs ?? 5_000;
		if (!Number.isSafeInteger(maxRequestAgeMs) || maxRequestAgeMs <= 0) {
			throw new TypeError("runtime credential max request age must be a positive integer");
		}
		if (!Number.isSafeInteger(allowedClockSkewMs) || allowedClockSkewMs < 0) {
			throw new TypeError("runtime credential allowed clock skew must be a non-negative integer");
		}
		this.#broker = options.broker;
		this.#audienceResolver = options.audienceResolver;
		this.#maxGrantTtlMs = options.maxGrantTtlMs;
		this.#maxRequestAgeMs = maxRequestAgeMs;
		this.#allowedClockSkewMs = allowedClockSkewMs;
		this.#clock = options.clock ?? (() => new Date());
	}

	#callKey(request: { authorityId: string; tenantId: string; requestId: string }): string {
		return `${request.authorityId}/${request.tenantId}/${request.requestId}`;
	}

	#freshRequest(requestedAt: string, now: Date): EnterprisePortResult<void> {
		const requestedMs = Date.parse(requestedAt);
		if (!Number.isFinite(requestedMs) || requestedMs > now.getTime() + this.#allowedClockSkewMs) {
			return failure("invalid_request", "credential request timestamp is invalid or in the future");
		}
		if (requestedMs < now.getTime() - this.#maxRequestAgeMs) {
			return failure("stale_receipt", "credential request is stale");
		}
		return { ok: true, value: undefined };
	}

	#cacheCollision(): EnterprisePortResult<never> {
		return failure("invalid_request", "credential request id was replayed with different content");
	}

	public async issue(
		request: CredentialGrantIssueRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<SessionCredentialGrantRef>> {
		if (!isCredentialGrantIssueRequest(request)) {
			return failure("invalid_request", "credential grant issue request is invalid");
		}
		const requestDigest = canonicalDigest(request);
		const key = this.#callKey(request);
		const cached = this.#issueCalls.get(key);
		if (cached) return cached.requestDigest === requestDigest ? cached.result : this.#cacheCollision();
		const fresh = this.#freshRequest(request.requestedAt, this.#clock());
		if (!fresh.ok) return fresh;
		if (request.requestedTtlMs > this.#maxGrantTtlMs) {
			return failure("denied", "credential grant ttl exceeds the runtime short-lived limit");
		}
		if (signal?.aborted) return failure("unavailable", "credential grant issue was aborted", true);

		const result = this.#issueOnce(request, signal);
		this.#issueCalls.set(key, { requestDigest, result });
		return result;
	}

	async #issueOnce(
		request: CredentialGrantIssueRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<SessionCredentialGrantRef>> {
		let issued: Awaited<ReturnType<CredentialBroker["issue"]>>;
		try {
			issued = await this.#broker.issue({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				sessionId: request.sessionId,
				credentialKind: request.credentialKind,
				audienceDigest: request.audienceDigest,
				scopeDigest: request.scopeDigest,
				requestedTtlMs: request.requestedTtlMs,
				requestId: request.requestId,
			}, signal);
		} catch {
			return failure("unavailable", "credential broker issue operation is unavailable", true);
		}
		if (!issued.ok) return securityFailure(issued.error);
		const grant = issued.value;
		if (!isSessionCredentialGrantRef(grant) || !grantHasValidDigest(grant)) {
			return failure("stale_receipt", "credential broker returned an invalid grant receipt");
		}
		if (grant.authorityId !== request.authorityId || grant.tenantId !== request.tenantId ||
			grant.principalId !== request.principalId || grant.sessionId !== request.sessionId) {
			return failure("scope_mismatch", "credential broker grant crossed authority, tenant, principal, or session");
		}
		if (
			grant.credentialKind !== request.credentialKind || grant.audienceDigest !== request.audienceDigest ||
			grant.scopeDigest !== request.scopeDigest
		) return failure("stale_receipt", "credential broker grant is not correlated with the issue request");

		const completedMs = this.#clock().getTime();
		const requestedMs = Date.parse(request.requestedAt);
		const issuedMs = Date.parse(grant.issuedAt);
		const expiresMs = Date.parse(grant.expiresAt);
		if (
			issuedMs < requestedMs - this.#allowedClockSkewMs ||
			issuedMs > completedMs + this.#allowedClockSkewMs ||
			expiresMs <= completedMs ||
			expiresMs > completedMs + request.requestedTtlMs ||
			expiresMs > completedMs + this.#maxGrantTtlMs ||
			expiresMs - issuedMs > request.requestedTtlMs + this.#allowedClockSkewMs ||
			expiresMs - issuedMs > this.#maxGrantTtlMs + this.#allowedClockSkewMs
		) return failure("stale_receipt", "credential broker grant lifetime is invalid or over-broad");

		const existing = this.#grants.get(grant.grantId);
		if (existing && !canonicalEqual(existing.grant, grant)) {
			return failure("stale_receipt", "credential broker reused a grant id for different content");
		}
		if (!existing) this.#grants.set(grant.grantId, { grant });
		return { ok: true, value: existing?.grant ?? grant };
	}

	public async validateAudience(
		request: CredentialAudienceValidationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialAudienceValidationReceiptRef>> {
		if (!isCredentialAudienceValidationRequest(request) || !grantHasValidDigest(request.grant)) {
			return failure("invalid_request", "credential audience validation request is invalid");
		}
		const now = this.#clock();
		const fresh = this.#freshRequest(request.requestedAt, now);
		if (!fresh.ok) return fresh;
		const requestDigest = canonicalDigest(request);
		const key = this.#callKey(request);
		const cached = this.#validationCalls.get(key);
		if (cached) {
			if (cached.requestDigest !== requestDigest) return this.#cacheCollision();
			const resolution = await cached.resolution;
			const record = this.#grants.get(cached.grantId);
			if (resolution.validUntilMs === undefined || (
				record && !record.revokedAt && !record.revocation &&
				Date.parse(record.grant.expiresAt) > now.getTime() && resolution.validUntilMs > now.getTime()
			)) {
				return resolution.result;
			}
			this.#validationCalls.delete(key);
		}
		const resolution = this.#validateAudienceOnce(request, now, signal);
		this.#validationCalls.set(key, { requestDigest, grantId: request.grant.grantId, resolution });
		return (await resolution).result;
	}

	#validationResolution(
		result: EnterprisePortResult<CredentialAudienceValidationReceiptRef>,
		validUntilMs?: number,
	): AudienceValidationResolution {
		return validUntilMs === undefined ? { result } : { result, validUntilMs };
	}

	#audienceReceipt(
		request: CredentialAudienceValidationRequest,
		outcome: CredentialAudienceValidationReceiptRef["outcome"],
		validatedAt: string,
		reason?: string,
	): CredentialAudienceValidationReceiptRef {
		const common = {
			schemaVersion: 1 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ request, outcome, validatedAt, reason: reason ?? null }).slice(0, 48)),
			requestId: request.requestId,
			grantId: request.grant.grantId,
			targetExecutorId: request.targetExecutorId,
			invocationDigest: request.invocationDigest,
			audienceDigest: request.grant.audienceDigest,
			validatedAt,
		};
		const reasonDigest = reason && DIGEST_PATTERN.test(reason)
			? reason
			: canonicalDigest(reason ?? "credential audience validation failed");
		const body: CredentialAudienceReceiptBody = outcome === "valid"
			? { ...common, outcome }
			: { ...common, outcome, reasonDigest };
		return { ...body, receiptDigest: canonicalDigest(body) } as CredentialAudienceValidationReceiptRef;
	}

	async #validateAudienceOnce(
		request: CredentialAudienceValidationRequest,
		now: Date,
		signal?: AbortSignal,
	): Promise<AudienceValidationResolution> {
		const record = this.#grants.get(request.grant.grantId);
		if (!record) return this.#validationResolution(failure("not_found", "credential grant was not issued by this runtime broker"));
		if (
			record.grant.authorityId !== request.authorityId || record.grant.tenantId !== request.tenantId ||
			record.grant.principalId !== request.principalId || record.grant.sessionId !== request.sessionId
		) return this.#validationResolution(failure("scope_mismatch", "credential audience request crossed authority, tenant, principal, or session"));
		if (!grantHasValidDigest(record.grant) || !canonicalEqual(record.grant, request.grant)) {
			return this.#validationResolution(failure("stale_receipt", "credential audience request carries a stale or altered grant"));
		}
		const validatedAt = now.toISOString();
		if (record.revokedAt || record.revocation) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "credential grant is revoked or revoking") });
		}
		if (Date.parse(record.grant.expiresAt) <= now.getTime()) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "credential grant is expired") });
		}
		if (signal?.aborted) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "unavailable", validatedAt, "credential audience validation was aborted") });
		}

		const bindingRequest: CredentialAudienceBindingRequest = {
			schemaVersion: 1,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			requestId: request.requestId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			grantId: request.grant.grantId,
			credentialKind: record.grant.credentialKind,
			scopeDigest: record.grant.scopeDigest,
			targetKind: request.targetKind,
			targetExecutorId: request.targetExecutorId,
			invocationDigest: request.invocationDigest,
			requestedAt: request.requestedAt,
		};
		let resolved: EnterprisePortResult<CredentialAudienceBindingRef>;
		try {
			resolved = await this.#audienceResolver.resolve(bindingRequest, signal);
		} catch {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "unavailable", validatedAt, "credential audience resolver is unavailable") });
		}
		if (!resolved.ok) {
			const outcome = resolved.error.code === "unavailable" ? "unavailable" : "rejected";
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, outcome, validatedAt, resolved.error.reasonDigest) });
		}
		const binding = resolved.value;
		const { bindingDigest: _bindingDigest, audienceDigest: _audienceDigest, issuedAt: _issuedAt, expiresAt: _expiresAt, ...bindingCorrelation } = binding;
		if (!audienceBindingHasValidDigest(binding) || !canonicalEqual(bindingCorrelation, bindingRequest)) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "credential audience binding is invalid or uncorrelated") });
		}
		const bindingIssuedMs = Date.parse(binding.issuedAt);
		const bindingExpiresMs = binding.expiresAt === undefined ? undefined : Date.parse(binding.expiresAt);
		if (
			!Number.isFinite(bindingIssuedMs) || bindingIssuedMs > now.getTime() + this.#allowedClockSkewMs ||
			(bindingExpiresMs !== undefined && (!Number.isFinite(bindingExpiresMs) || bindingExpiresMs <= now.getTime()))
		) return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "credential audience binding is stale") });
		if (binding.audienceDigest !== record.grant.audienceDigest) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "target executor audience does not match credential grant") });
		}
		if (record.revokedAt || record.revocation || Date.parse(record.grant.expiresAt) <= this.#clock().getTime()) {
			return this.#validationResolution({ ok: true, value: this.#audienceReceipt(request, "rejected", validatedAt, "credential grant became stale during validation") });
		}
		const validUntilMs = Math.min(Date.parse(record.grant.expiresAt), bindingExpiresMs ?? Date.parse(record.grant.expiresAt));
		return this.#validationResolution(
			{ ok: true, value: this.#audienceReceipt(request, "valid", validatedAt) },
			validUntilMs,
		);
	}

	public async revoke(
		request: CredentialGrantRevocationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialGrantRevocationReceiptRef>> {
		if (!isCredentialGrantRevocationRequest(request)) {
			return failure("invalid_request", "credential grant revocation request is invalid");
		}
		const requestDigest = canonicalDigest(request);
		const key = this.#callKey(request);
		const cached = this.#revocationCalls.get(key);
		if (cached) return cached.requestDigest === requestDigest ? cached.result : this.#cacheCollision();
		const fresh = this.#freshRequest(request.requestedAt, this.#clock());
		if (!fresh.ok) return fresh;
		const result = this.#revokeOnce(request, signal);
		this.#revocationCalls.set(key, { requestDigest, result });
		return result;
	}

	#revocationReceipt(
		request: CredentialGrantRevocationRequest,
		outcome: CredentialGrantRevocationReceiptRef["outcome"],
		revokedAt: string,
		reason?: string,
	): CredentialGrantRevocationReceiptRef {
		const common = {
			schemaVersion: 1 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ request, outcome, revokedAt, reason: reason ?? null }).slice(0, 48)),
			requestId: request.requestId,
			grantId: request.grantId,
			expectedReceiptDigest: request.expectedReceiptDigest,
			revokedAt,
		};
		const reasonDigest = reason && DIGEST_PATTERN.test(reason)
			? reason
			: canonicalDigest(reason ?? "credential revocation failed");
		const body: CredentialRevocationReceiptBody = outcome === "revoked"
			? { ...common, outcome }
			: { ...common, outcome, reasonDigest };
		return { ...body, receiptDigest: canonicalDigest(body) } as CredentialGrantRevocationReceiptRef;
	}

	async #revokeOnce(
		request: CredentialGrantRevocationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<CredentialGrantRevocationReceiptRef>> {
		const record = this.#grants.get(request.grantId);
		if (!record) return failure("not_found", "credential grant was not issued by this runtime broker");
		if (
			record.grant.authorityId !== request.authorityId || record.grant.tenantId !== request.tenantId ||
			record.grant.principalId !== request.principalId || record.grant.sessionId !== request.sessionId
		) return failure("scope_mismatch", "credential revocation crossed authority, tenant, principal, or session");
		if (!grantHasValidDigest(record.grant) || record.grant.receiptDigest !== request.expectedReceiptDigest) {
			return failure("stale_receipt", "credential revocation expected receipt is stale or altered");
		}
		if (record.revokedAt) {
			return { ok: true, value: this.#revocationReceipt(request, "revoked", record.revokedAt) };
		}
		if (signal?.aborted) {
			return { ok: true, value: this.#revocationReceipt(request, "unavailable", this.#clock().toISOString(), "credential revocation was aborted") };
		}

		const revoked = await this.#revokeGrant(record, signal);
		if (!revoked.ok) {
			const outcome = revoked.error.code === "credential_unavailable" || revoked.error.retryable ? "unavailable" : "rejected";
			return { ok: true, value: this.#revocationReceipt(request, outcome, this.#clock().toISOString(), `credential broker ${revoked.error.code}`) };
		}
		return { ok: true, value: this.#revocationReceipt(request, "revoked", record.revokedAt ?? this.#clock().toISOString()) };
	}

	async #revokeGrant(record: ActiveGrantRecord, signal?: AbortSignal): Promise<SecurityResult<void>> {
		if (record.revocation) return record.revocation;
		this.#invalidateValidations(record.grant.grantId);
		const operation = (async (): Promise<SecurityResult<void>> => {
			let revoked: SecurityResult<void>;
			try {
				revoked = await this.#broker.revoke(record.grant.grantId, signal);
			} catch {
				return { ok: false, error: { code: "credential_unavailable", message: "credential broker revoke operation is unavailable", retryable: true } };
			}
			if (revoked.ok) record.revokedAt = this.#clock().toISOString();
			return revoked;
		})();
		record.revocation = operation;
		const result = await operation;
		if (record.revocation === operation) record.revocation = undefined;
		return result;
	}

	#invalidateValidations(grantId: SessionCredentialGrantRef["grantId"]): void {
		for (const [key, cached] of this.#validationCalls) {
			if (cached.grantId === grantId) this.#validationCalls.delete(key);
		}
	}
}
