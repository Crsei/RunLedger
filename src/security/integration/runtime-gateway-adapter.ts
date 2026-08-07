/** Runtime final-leaf 只做 decision/receipt 校验，不拥有 process 生命周期。 */

import {
	runtimeDigest,
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
	type RuntimeDigest,
} from "../../runtime/contracts/public.ts";
import type { SecurityResult } from "../types.ts";
import type {
	SandboxBackend,
	SandboxDecisionReceipt,
	SandboxLaunchPlan,
} from "../sandbox/types.ts";

export interface ProcessFinalLeafRequest {
	readonly constraintInput: ExecutionConstraintInput;
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
	readonly requestDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly sandboxPlan?: SandboxLaunchPlan;
	/** 可选的上游 receipt；提供后必须与 backend final-leaf receipt 完全一致。 */
	readonly sandboxReceipt?: SandboxDecisionReceipt;
}

export interface ProcessFinalLeafDecision {
	readonly decision: "allow";
	readonly requestDigest: RuntimeDigest;
	readonly policyDigest: RuntimeDigest;
	readonly constraintSnapshotDigest: RuntimeDigest;
	readonly sandboxReceipt?: SandboxDecisionReceipt;
}

export interface ProcessFinalLeafDecisionPort {
	decide(input: ProcessFinalLeafRequest): Promise<SecurityResult<ProcessFinalLeafDecision>>;
}

export interface RuntimeGatewayAdapterOptions {
	readonly sandboxBackend: SandboxBackend;
	readonly currentPolicyDigest?: () => RuntimeDigest | Promise<RuntimeDigest>;
}

function invalid(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function denied(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "policy_denied", message, retryable: false } };
}

function validDigest(value: RuntimeDigest): boolean {
	return value.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function sandboxReceiptIsSelfConsistent(receipt: SandboxDecisionReceipt): boolean {
	if (!validDigest(receipt.policyDigest) || !validDigest(receipt.requestDigest) || !validDigest(receipt.planDigest) || !validDigest(receipt.finalLeafDigest) || !validDigest(receipt.receiptDigest)) return false;
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return sameDigest(receipt.receiptDigest, runtimeDigest(body));
}

function sandboxReceiptMatches(left: SandboxDecisionReceipt, right: SandboxDecisionReceipt): boolean {
	return sandboxReceiptIsSelfConsistent(left) && sandboxReceiptIsSelfConsistent(right) && sameDigest(left.receiptDigest, right.receiptDigest);
}

export class ProcessFinalLeafAdapter implements ProcessFinalLeafDecisionPort {
	readonly #sandboxBackend: SandboxBackend;
	readonly #currentPolicyDigest: RuntimeGatewayAdapterOptions["currentPolicyDigest"];

	public constructor(options: RuntimeGatewayAdapterOptions) {
		this.#sandboxBackend = options.sandboxBackend;
		this.#currentPolicyDigest = options.currentPolicyDigest;
	}

	public async decide(input: ProcessFinalLeafRequest): Promise<SecurityResult<ProcessFinalLeafDecision>> {
		if (!validDigest(input.requestDigest) || !validDigest(input.policyDigest)) return invalid("final-leaf request or policy digest is malformed");
		if (!input.constraintSnapshot) return invalid("final-leaf constraint decision is missing");
		const constraint = input.constraintInput;
		if (!sameDigest(constraint.requestDigest, input.requestDigest)) return invalid("final-leaf request digest is stale");
		if (!sameDigest(constraint.policyDigest, input.policyDigest)) return invalid("final-leaf policy digest is stale");
		if (!validateExecutionConstraintSnapshot(constraint, input.constraintSnapshot)) return invalid("final-leaf constraint receipt is stale or invalid");
		if (this.#currentPolicyDigest) {
			let current: RuntimeDigest;
			try {
				current = await this.#currentPolicyDigest();
			} catch {
				return invalid("current security policy digest is unavailable");
			}
			if (!validDigest(current) || !sameDigest(current, input.policyDigest)) return invalid("final-leaf policy digest is stale");
		}

		const sandboxMode = constraint.modes.sandbox;
		if (sandboxMode === "none") {
			if (input.sandboxPlan !== undefined || input.sandboxReceipt !== undefined) return invalid("builtin-none final leaf cannot carry a sandbox plan or receipt");
			return {
				ok: true,
				value: {
					decision: "allow",
					requestDigest: input.requestDigest,
					policyDigest: input.policyDigest,
					constraintSnapshotDigest: input.constraintSnapshot.snapshotDigest,
				},
			};
		}
		if (sandboxMode !== "profile") return invalid("final-leaf sandbox mode is unknown");
		if (!input.sandboxPlan) return denied("restrictive sandbox launch plan is missing");
		if (!sameDigest(input.sandboxPlan.requestDigest, input.requestDigest) || !sameDigest(input.sandboxPlan.policyDigest, input.policyDigest)) return invalid("sandbox launch plan digest is stale");
		if (input.sandboxPlan.enforcement !== "enforced") return denied("restrictive sandbox is not enforced");

		let capability;
		try {
			capability = await this.#sandboxBackend.probe();
		} catch {
			return denied("restrictive sandbox capability is unavailable");
		}
		if (
			capability.status !== "available" ||
			!capability.supportsFilesystemIsolation ||
			!capability.supportsChildIsolation ||
			(input.sandboxPlan.network === "deny" && !capability.supportsNetworkDeny)
		) return denied("restrictive sandbox capability is unavailable");

		let receipt: SandboxDecisionReceipt;
		try {
			receipt = await this.#sandboxBackend.validateFinalLeaf(input.sandboxPlan, input.requestDigest);
		} catch {
			return denied("restrictive sandbox final-leaf validation is unavailable");
		}
		if (!sandboxReceiptIsSelfConsistent(receipt)) return invalid("sandbox final-leaf receipt digest is invalid");
		if (input.sandboxReceipt && !sandboxReceiptMatches(input.sandboxReceipt, receipt)) return invalid("sandbox final-leaf receipt is stale");
		if (
			receipt.decision !== "allow" ||
			receipt.enforcement !== "enforced" ||
			!sameDigest(receipt.requestDigest, input.requestDigest) ||
			!sameDigest(receipt.policyDigest, input.policyDigest) ||
			!sameDigest(receipt.planDigest, input.sandboxPlan.planDigest)
		) return denied("restrictive sandbox final-leaf decision was not allow");
		return {
			ok: true,
			value: {
				decision: "allow",
				requestDigest: input.requestDigest,
				policyDigest: input.policyDigest,
				constraintSnapshotDigest: input.constraintSnapshot.snapshotDigest,
				sandboxReceipt: receipt,
			},
		};
	}

	public validate(input: ProcessFinalLeafRequest): Promise<SecurityResult<ProcessFinalLeafDecision>> {
		return this.decide(input);
	}
}

/** legacy Host 源码在 R9 删除前使用的兼容类型/值别名。 */
export type HostProcessFinalLeafRequest = ProcessFinalLeafRequest;
export type HostProcessFinalLeafDecision = ProcessFinalLeafDecision;
export type HostProcessFinalLeafDecisionPort = ProcessFinalLeafDecisionPort;
export { ProcessFinalLeafAdapter as HostProcessFinalLeafAdapter };

/** 与 Runtime adapter 命名保持一致；不创建第二个 process manager。 */
export class RuntimeGatewayAdapter extends ProcessFinalLeafAdapter {}
