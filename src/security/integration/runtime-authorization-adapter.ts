/** 将内部 Permission/Approval 结果投影为 Runtime CapabilityDecisionReceipt。 */

import { createRuntimeId, runtimeDigest } from "../../runtime/contracts/public.ts";
import type {
	AdapterIdentityRef,
	CapabilityDecisionReceipt,
	CapabilityRequest,
	RuntimeDigest,
} from "../../runtime/contracts/public.ts";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	SecurityResult,
} from "../types.ts";
import {
	ApprovalCoordinator,
	type ApprovalRevalidationPort,
} from "../permission/approval-coordinator.ts";
import { PermissionEngine } from "../permission/engine.ts";

export interface RuntimeAuthorizationAdapterOptions {
	readonly engine: PermissionEngine;
	readonly approvals: ApprovalCoordinator;
	readonly gateway: AdapterIdentityRef;
	readonly clock?: () => Date;
}

export interface RuntimeAuthorizationInput {
	readonly request: AuthorizationRequest;
	readonly capability: CapabilityRequest;
	readonly revalidate: ApprovalRevalidationPort;
}

export interface RuntimeAuthorizationValue {
	readonly authorization: AuthorizationResult;
	readonly receipt: CapabilityDecisionReceipt;
}

function invalid(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function matchedRulesDigest(request: AuthorizationRequest, policy: RuntimeDigest): RuntimeDigest {
	return runtimeDigest({
		policy,
		decisions: request.requests,
	});
}

export class RuntimeAuthorizationAdapter {
	readonly #engine: PermissionEngine;
	readonly #approvals: ApprovalCoordinator;
	readonly #gateway: AdapterIdentityRef;
	readonly #clock: () => Date;

	public constructor(options: RuntimeAuthorizationAdapterOptions) {
		this.#engine = options.engine;
		this.#approvals = options.approvals;
		this.#gateway = options.gateway;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async authorize(
		input: RuntimeAuthorizationInput,
		signal?: AbortSignal,
	): Promise<SecurityResult<RuntimeAuthorizationValue>> {
		const { request, capability } = input;
		if (
			request.requestId !== capability.requestId ||
			request.sessionId !== capability.subject.sessionId ||
			request.toolCallId !== capability.subject.toolCallId ||
			request.argumentsDigest.digest !== capability.argumentsDigest.digest ||
			request.snapshot.policyDigest.digest !== capability.policyDigest.digest
		) return invalid("authorization request and Runtime capability binding differ");
		const evaluation = this.#engine.evaluate(request.requests, request.snapshot);
		let authorization: AuthorizationResult;
		if (evaluation.decision === "ask") {
			const approved = await this.#approvals.authorize(request, evaluation, input.revalidate, signal);
			if (!approved.ok) return approved;
			authorization = approved.value;
		} else {
			authorization = {
				outcome: evaluation.decision === "allow" ? "allow" : "deny",
				decisionSource: evaluation.requestDecisions[0]?.source ?? "fallback",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				reason: evaluation.reason,
			};
		}
		const decidedAt = this.#clock().toISOString();
		const approverPrincipalId = authorization.approval?.principalId;
		const body = {
			requestId: capability.requestId,
			decision: authorization.outcome,
			decisionRevision: 1,
			matchedRulesDigest: matchedRulesDigest(request, capability.policyDigest),
			policyDigest: capability.policyDigest,
			gateway: this.#gateway,
			...(approverPrincipalId === undefined ? {} : { approverPrincipalId }),
			decidedAt,
			expiresAt: capability.expiresAt,
			revocationRevision: 0,
		} as const;
		const receipt: CapabilityDecisionReceipt = {
			receiptId: createRuntimeId("receipt", `capability-${runtimeDigest(body).digest.slice(0, 48)}`),
			...body,
		};
		return { ok: true, value: { authorization, receipt } };
	}
}
