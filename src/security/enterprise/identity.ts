/** Enterprise user/service/local-peer/remote-workload authentication 与 SoD authorization adapter。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	authorizationRequestDigest,
	isAuthenticationRequest,
	isAuthorizationRequest,
} from "../../runtime/identity/enterprise-schemas.ts";
import type {
	EnterpriseAuthenticationPort,
	EnterpriseAuthorizationPort,
} from "../../runtime/identity/enterprise-ports.ts";
import type {
	AuthenticationReceiptRef,
	AuthenticationRequest,
	AuthorizationDecisionReceiptRef,
	AuthorizationRequest,
	EnterprisePortResult,
	EnterprisePrincipalRef,
} from "../../runtime/identity/enterprise-types.ts";

type WithoutReceiptDigest<T> = T extends { receiptDigest: string } ? Omit<T, "receiptDigest"> : never;
type AuthorizationDecisionBody = WithoutReceiptDigest<AuthorizationDecisionReceiptRef>;

export interface AuthenticatedIdentityMaterial {
	subjectDigest: string;
	issuerId: string;
	attestationReceiptId?: EnterprisePrincipalRef["attestationReceiptId"];
	grantReceiptId?: EnterprisePrincipalRef["grantReceiptId"];
	expiresAt?: string;
}

export interface EnterpriseIdentityBrokerPort {
	verifyPresentation(
		request: AuthenticationRequest,
		signal?: AbortSignal,
	): Promise<EnterprisePortResult<AuthenticatedIdentityMaterial>>;
}

export interface EnterpriseAccessEvaluation {
	decision: "allow" | "ask" | "deny";
	reasonDigest: string;
	obligationsDigest?: string;
	requiredApprovalDigest?: string;
}

export interface EnterpriseAccessPolicyPort {
	evaluate(request: AuthorizationRequest, signal?: AbortSignal): Promise<EnterprisePortResult<EnterpriseAccessEvaluation>>;
}

function failure(code: "invalid_request" | "denied" | "unavailable" | "scope_mismatch", reason: string, retryable = false): EnterprisePortResult<never> {
	return { ok: false, error: { code, retryable, reasonDigest: canonicalDigest(reason) } };
}

export class EnterpriseIdentityAdapter implements EnterpriseAuthenticationPort {
	readonly #broker: EnterpriseIdentityBrokerPort;
	readonly #clock: () => Date;
	readonly #maxTtlMs: number;

	public constructor(broker: EnterpriseIdentityBrokerPort, maxTtlMs: number, clock: () => Date = () => new Date()) {
		this.#broker = broker;
		this.#maxTtlMs = maxTtlMs;
		this.#clock = clock;
	}

	public async authenticate(request: AuthenticationRequest, signal?: AbortSignal): Promise<EnterprisePortResult<AuthenticationReceiptRef>> {
		if (!isAuthenticationRequest(request)) return failure("invalid_request", "enterprise authentication request is invalid");
		const issuedAt = this.#clock().toISOString();
		let verified: EnterprisePortResult<AuthenticatedIdentityMaterial>;
		try {
			verified = await this.#broker.verifyPresentation(request, signal);
		} catch {
			verified = failure("unavailable", "enterprise identity broker is unavailable", true);
		}
		const requestDigest = canonicalDigest(request);
		if (!verified.ok) {
			const body = {
				schemaVersion: 1 as const, authorityId: request.authorityId, tenantId: request.tenantId,
				receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, error: verified.error }).slice(0, 48)),
				requestId: request.requestId, outcome: verified.error.code === "unavailable" ? "unavailable" as const : "rejected" as const,
				requestDigest, reasonDigest: verified.error.reasonDigest, issuedAt,
			};
			return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
		}
		const maxExpiry = new Date(this.#clock().getTime() + this.#maxTtlMs);
		const brokerExpiry = verified.value.expiresAt ? new Date(verified.value.expiresAt) : maxExpiry;
		const expiresAt = new Date(Math.min(maxExpiry.getTime(), brokerExpiry.getTime())).toISOString();
		if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return failure("denied", "authenticated enterprise identity is expired");
		const principal: EnterprisePrincipalRef = {
			schemaVersion: 1, authorityId: request.authorityId, tenantId: request.tenantId,
			principalId: createRuntimeId("principal", canonicalDigest({ kind: request.requestedKind, subject: verified.value.subjectDigest, issuer: verified.value.issuerId }).slice(0, 48)),
			kind: request.requestedKind, subjectDigest: verified.value.subjectDigest, issuerId: verified.value.issuerId,
			issuedAt, expiresAt,
			...(verified.value.attestationReceiptId ? { attestationReceiptId: verified.value.attestationReceiptId } : {}),
			...(verified.value.grantReceiptId ? { grantReceiptId: verified.value.grantReceiptId } : {}),
		};
		const body = {
			schemaVersion: 1 as const, authorityId: request.authorityId, tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, principal }).slice(0, 48)),
			requestId: request.requestId, outcome: "authenticated" as const, principal, requestDigest, issuedAt, expiresAt,
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
	}
}

export class EnterpriseAuthorizationAdapter implements EnterpriseAuthorizationPort {
	readonly #policy: EnterpriseAccessPolicyPort;
	readonly #clock: () => Date;

	public constructor(policy: EnterpriseAccessPolicyPort, clock: () => Date = () => new Date()) {
		this.#policy = policy;
		this.#clock = clock;
	}

	public async authorize(request: AuthorizationRequest, signal?: AbortSignal): Promise<EnterprisePortResult<AuthorizationDecisionReceiptRef>> {
		if (!isAuthorizationRequest(request)) return failure("invalid_request", "enterprise authorization request is invalid");
		if (request.principal.expiresAt && Date.parse(request.principal.expiresAt) <= this.#clock().getTime()) return failure("denied", "enterprise principal is expired");
		if (new Set(request.separationOfDutyPrincipalIds).size !== request.separationOfDutyPrincipalIds.length) return failure("invalid_request", "separation-of-duty principals contain duplicates");
		const highRisk = request.risk === "high" || request.risk === "critical" || ["approve", "manage_policy", "execute_remote", "use_credential"].includes(request.action);
		const requiredApprovers = request.risk === "critical" ? 2 : highRisk ? 1 : 0;
		let evaluation: EnterpriseAccessEvaluation;
		if (request.separationOfDutyPrincipalIds.length < requiredApprovers || (highRisk && request.approvalReceiptId === undefined)) {
			evaluation = {
				decision: "ask",
				reasonDigest: canonicalDigest("separation of duty approval is required"),
				requiredApprovalDigest: canonicalDigest({ requiredApprovers, action: request.action, resourceDigest: request.resourceDigest }),
			};
		} else {
			let resolved: EnterprisePortResult<EnterpriseAccessEvaluation>;
			try {
				resolved = await this.#policy.evaluate(request, signal);
			} catch {
				resolved = failure("unavailable", "enterprise access policy is unavailable", true);
			}
			if (!resolved.ok) return resolved;
			evaluation = resolved.value;
		}
		const decidedAt = this.#clock().toISOString();
		const common = {
			schemaVersion: 1 as const, authorityId: request.authorityId, tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, evaluation, decidedAt }).slice(0, 48)),
			requestId: request.requestId, requestDigest: authorizationRequestDigest(request),
			effectivePolicyReceiptId: request.effectivePolicy.receiptId,
			effectivePolicyDigest: request.effectivePolicy.effectivePolicyDigest,
			separationOfDutyDigest: canonicalDigest(request.separationOfDutyPrincipalIds), decidedAt,
		};
		let body: AuthorizationDecisionBody;
		switch (evaluation.decision) {
			case "allow":
				body = { ...common, decision: "allow", obligationsDigest: evaluation.obligationsDigest ?? canonicalDigest([]), ...(request.approvalReceiptId ? { approvalReceiptId: request.approvalReceiptId } : {}) };
				break;
			case "ask":
				body = { ...common, decision: "ask", requiredApprovalDigest: evaluation.requiredApprovalDigest ?? evaluation.reasonDigest };
				break;
			case "deny":
				body = { ...common, decision: "deny", reasonDigest: evaluation.reasonDigest };
				break;
		}
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } as AuthorizationDecisionReceiptRef };
	}
}
