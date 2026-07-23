/** 显式 deny-set adapter；未知 policy revision 或撤销命中时 fail closed。 */

import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId, type AgentId } from "../../protocol/v3/ids.ts";
import type {
	AgentDenialEvaluatorPort,
	AgentDenialReceiptRef,
	AgentResult,
} from "../types.ts";

export interface ProductionAgentDenialPolicy {
	policyDigest: string;
	decisionRevision: number;
	deniedAgentIds: ReadonlySet<AgentId>;
}

export class ProductionAgentDenialEvaluator implements AgentDenialEvaluatorPort {
	readonly #policy: ProductionAgentDenialPolicy;
	readonly #clock: () => Date;

	public constructor(policy: ProductionAgentDenialPolicy, clock: () => Date = () => new Date()) {
		if (
			!/^[a-f0-9]{64}$/.test(policy.policyDigest) ||
			!Number.isSafeInteger(policy.decisionRevision) ||
			policy.decisionRevision < 0 ||
			[...policy.deniedAgentIds].some((agentId) => !isRuntimeId(agentId, "agent"))
		) throw new TypeError("production Agent denial policy is invalid");
		this.#policy = {
			...policy,
			deniedAgentIds: new Set(policy.deniedAgentIds),
		};
		this.#clock = clock;
	}

	public check(
		agentId: Parameters<AgentDenialEvaluatorPort["check"]>[0],
		sessionId: Parameters<AgentDenialEvaluatorPort["check"]>[1],
		signal?: AbortSignal,
	): Promise<AgentResult<AgentDenialReceiptRef>> {
		if (signal?.aborted) {
			return Promise.resolve({
				ok: false,
				error: { code: "reference_unavailable", message: "Agent denial evaluation was aborted", retryable: true },
			});
		}
		const checkedAt = this.#clock().toISOString();
		const body: Omit<AgentDenialReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId(
				"receipt",
				`agent-denial-${canonicalDigest({ agentId, sessionId, checkedAt, policyDigest: this.#policy.policyDigest }).slice(0, 48)}`,
			),
			agentId,
			sessionId,
			status: this.#policy.deniedAgentIds.has(agentId) ? "denied" : "allowed",
			decisionRevision: this.#policy.decisionRevision,
			checkedAt,
		};
		return Promise.resolve({ ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } });
	}
}
