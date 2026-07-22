/** Production capability subset evaluator：只接受父 grant 与 policy receipt 的 exact 交集。 */

import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../../protocol/v3/ids.ts";
import {
	capabilitySubsetRequestDigest,
	delegationReceiptMatches,
	isAgentCapabilityRequestRef,
	isParentCapabilityGrantRef,
} from "../delegation.ts";
import type {
	AgentCapabilityRequestRef,
	AgentErrorCode,
	AgentResult,
	CapabilitySubsetEvaluationRequest,
	CapabilitySubsetEvaluatorPort,
	CapabilitySubsetRevalidationRequest,
	DelegationReceiptRef,
	ParentCapabilityGrantRef,
} from "../types.ts";
import type { PrincipalId, ReceiptId } from "../../protocol/v3/ids.ts";

export type DelegableToolKind = Extract<
	Extract<AgentCapabilityRequestRef, { kind: "tool" }>["toolKind"],
	"builtin" | "mcp" | "custom" | "unknown"
>;

export interface ProductionCapabilityGrantPolicy {
	policyReceiptId: ReceiptId;
	parentGrant: ParentCapabilityGrantRef;
	allowedRequests: readonly AgentCapabilityRequestRef[];
	delegableToolKinds: readonly DelegableToolKind[];
	childSpawnAllowed: boolean;
	decisionRevision: number;
	evaluatorId: PrincipalId;
	issuedAt: string;
	expiresAt?: string;
	policyDigest: string;
}

export interface ProductionCapabilityGrantPolicyInput
	extends Omit<ProductionCapabilityGrantPolicy, "policyDigest"> {}

const TOOL_KINDS: ReadonlySet<string> = new Set(["builtin", "mcp", "custom", "unknown"]);

function fail<T>(code: AgentErrorCode, message: string): AgentResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

function timestampIsValid(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function policyBody(
	policy: ProductionCapabilityGrantPolicy | ProductionCapabilityGrantPolicyInput,
): ProductionCapabilityGrantPolicyInput {
	const { policyDigest: _policyDigest, ...body } = policy as ProductionCapabilityGrantPolicy;
	return {
		...body,
		parentGrant: { ...body.parentGrant },
		allowedRequests: body.allowedRequests.map((request) => ({ ...request })),
		delegableToolKinds: [...body.delegableToolKinds],
	};
}

function policyIsValid(policy: ProductionCapabilityGrantPolicy, now: Date): boolean {
	const requestDigests = new Set<string>();
	const toolKinds = new Set(policy.delegableToolKinds);
	return (
		isRuntimeId(policy.policyReceiptId, "receipt") &&
		isRuntimeId(policy.evaluatorId, "principal") &&
		isParentCapabilityGrantRef(policy.parentGrant, now) &&
		Number.isSafeInteger(policy.decisionRevision) &&
		policy.decisionRevision >= policy.parentGrant.decisionRevision &&
		timestampIsValid(policy.issuedAt) &&
		(policy.expiresAt === undefined ||
			(timestampIsValid(policy.expiresAt) && Date.parse(policy.expiresAt) > now.getTime())) &&
		policy.allowedRequests.every((request) => {
			if (!isAgentCapabilityRequestRef(request)) return false;
			const digest = canonicalDigest(request);
			if (requestDigests.has(digest)) return false;
			requestDigests.add(digest);
			return true;
		}) &&
		policy.delegableToolKinds.every((kind) => TOOL_KINDS.has(kind)) &&
		toolKinds.size === policy.delegableToolKinds.length &&
		policy.policyDigest === canonicalDigest(policyBody(policy))
	);
}

export function createProductionCapabilityGrantPolicy(
	input: ProductionCapabilityGrantPolicyInput,
): ProductionCapabilityGrantPolicy {
	const body = policyBody(input);
	return { ...body, policyDigest: canonicalDigest(body) };
}

function sameParentGrant(left: ParentCapabilityGrantRef, right: ParentCapabilityGrantRef): boolean {
	return (
		left.receiptId === right.receiptId &&
		left.receiptDigest === right.receiptDigest &&
		left.decisionRevision === right.decisionRevision &&
		left.expiresAt === right.expiresAt
	);
}

function earlierExpiry(left: string | undefined, right: string | undefined): string | undefined {
	if (!left) return right;
	if (!right) return left;
	return Date.parse(left) <= Date.parse(right) ? left : right;
}

function receiptBody(
	receipt: Omit<DelegationReceiptRef, "receiptDigest"> | DelegationReceiptRef,
): Omit<DelegationReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt as DelegationReceiptRef;
	return body;
}

/**
 * Policy 必须由受信的 Gateway/config adapter 固定 exact grant 与 request refs。
 * 未进入 allowedRequests 的 capability/builtin 一律拒绝；MCP/custom/unknown 还需显式 kind 授权。
 */
export class GatewayBoundCapabilitySubsetEvaluator implements CapabilitySubsetEvaluatorPort {
	readonly #policies = new Map<ReceiptId, ProductionCapabilityGrantPolicy>();
	readonly #clock: () => Date;

	public constructor(
		policies: readonly ProductionCapabilityGrantPolicy[],
		clock: () => Date = () => new Date(),
	) {
		this.#clock = clock;
		const now = this.#clock();
		for (const policy of policies) {
			if (!policyIsValid(policy, now) || this.#policies.has(policy.parentGrant.receiptId)) {
				throw new TypeError("production capability grant policy is invalid or duplicated");
			}
			this.#policies.set(policy.parentGrant.receiptId, structuredClone(policy));
		}
	}

	#policyFor(parentGrant: ParentCapabilityGrantRef): ProductionCapabilityGrantPolicy | undefined {
		const policy = this.#policies.get(parentGrant.receiptId);
		return policy && policyIsValid(policy, this.#clock()) && sameParentGrant(policy.parentGrant, parentGrant)
			? policy
			: undefined;
	}

	#requestsAllowed(
		policy: ProductionCapabilityGrantPolicy,
		requested: readonly AgentCapabilityRequestRef[],
	): boolean {
		const allowed = new Set(policy.allowedRequests.map((request) => canonicalDigest(request)));
		const delegableToolKinds = new Set(policy.delegableToolKinds);
		return requested.every((request) => {
			if (!allowed.has(canonicalDigest(request))) return false;
			return request.kind === "capability" || delegableToolKinds.has(request.toolKind);
		});
	}

	#evaluate(
		request: CapabilitySubsetEvaluationRequest,
		previous?: DelegationReceiptRef,
	): AgentResult<DelegationReceiptRef> {
		const expectedDigest = capabilitySubsetRequestDigest(
			request.parentAgentId,
			request.childAgentId,
			request.parentGrant,
			request.requestedCapabilities,
			request.inputSources,
			request.declassificationReceipts,
		);
		if (request.requestDigest !== expectedDigest) {
			return fail("delegation_invalid", "capability subset request digest is invalid");
		}
		const policy = this.#policyFor(request.parentGrant);
		if (!policy) return fail("delegation_denied", "parent capability grant or policy receipt is stale");
		if (!this.#requestsAllowed(policy, request.requestedCapabilities)) {
			return fail("delegation_denied", "requested capability or tool is not an exact parent-grant subset");
		}
		if (previous) {
			if (
				!delegationReceiptMatches(
					previous,
					{
						parentAgentId: request.parentAgentId,
						childAgentId: request.childAgentId,
						parentGrant: request.parentGrant,
						requestDigest: request.requestDigest,
					},
					this.#clock(),
				)
			) return fail("resume_denied", "previous delegation receipt is stale or uncorrelated");
		}
		const evaluatedAt = this.#clock().toISOString();
		const decisionRevision = Math.max(
			policy.decisionRevision,
			request.parentGrant.decisionRevision,
			previous ? previous.decisionRevision + 1 : 0,
		);
		const receiptId = createRuntimeId(
			"receipt",
			`agent-delegation-${canonicalDigest({
				policyReceiptId: policy.policyReceiptId,
				requestDigest: request.requestDigest,
				decisionRevision,
			}).slice(0, 48)}`,
		);
		const body: Omit<DelegationReceiptRef, "receiptDigest"> = {
			receiptId,
			parentAgentId: request.parentAgentId,
			childAgentId: request.childAgentId,
			parentGrantReceiptId: request.parentGrant.receiptId,
			parentGrantDigest: request.parentGrant.receiptDigest,
			requestDigest: request.requestDigest,
			decision: "allowed",
			childSpawnAllowed: policy.childSpawnAllowed,
			decisionRevision,
			evaluatorId: policy.evaluatorId,
			evaluatedAt,
			...(() => {
				const expiresAt = earlierExpiry(request.parentGrant.expiresAt, policy.expiresAt);
				return expiresAt ? { expiresAt } : {};
			})(),
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(receiptBody(body)) } };
	}

	public evaluate(
		request: CapabilitySubsetEvaluationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<DelegationReceiptRef>> {
		if (signal?.aborted) return Promise.resolve(fail("reference_unavailable", "capability subset evaluation was aborted"));
		return Promise.resolve(this.#evaluate(request));
	}

	public revalidate(
		request: CapabilitySubsetRevalidationRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<DelegationReceiptRef>> {
		if (signal?.aborted) return Promise.resolve(fail("reference_unavailable", "capability subset revalidation was aborted"));
		return Promise.resolve(this.#evaluate({
			requestId: request.requestId,
			parentAgentId: request.parentAgentId,
			childAgentId: request.agentId,
			parentGrant: request.parentGrant,
			requestedCapabilities: request.requestedCapabilities,
			inputSources: request.inputSources,
			declassificationReceipts: request.declassificationReceipts,
			requestDigest: request.requestDigest,
		}, request.previousReceipt));
	}

	/** Launcher 在创建 child runtime 前再次验证当前父 grant/policy；不接受缓存式 allow。 */
	public validatesDelegation(receipt: DelegationReceiptRef): boolean {
		const policy = this.#policies.get(receipt.parentGrantReceiptId);
		if (!policy || !policyIsValid(policy, this.#clock())) return false;
		if (
			policy.parentGrant.receiptDigest !== receipt.parentGrantDigest ||
			policy.parentGrant.decisionRevision > receipt.decisionRevision ||
			policy.evaluatorId !== receipt.evaluatorId
		) return false;
		return canonicalDigest(receiptBody(receipt)) === receipt.receiptDigest;
	}
}
