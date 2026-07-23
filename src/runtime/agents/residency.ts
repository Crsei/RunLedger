/** Residency、cancel、timeout 与 crash 的显式持久状态映射。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey, type IdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
import type { CommandId } from "../protocol/v3/ids.ts";
import { createAgentSemanticTerminalRecord } from "./graph-store.ts";
import type {
	AgentErrorCode,
	AgentGraphSemanticCommand,
	AgentInterruptionCause,
	AgentNode,
	AgentResidencyReceiptRef,
	AgentResidencyState,
	AgentResult,
	AgentSemanticTerminalRecord,
	AgentState,
} from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function fail<T>(code: AgentErrorCode, message: string): AgentResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

function receiptDigest(receipt: AgentResidencyReceiptRef): string {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return canonicalDigest(body);
}

function receiptsAreExact(
	left: AgentResidencyReceiptRef,
	right: AgentResidencyReceiptRef | undefined,
): boolean {
	if (!right) return false;
	try {
		return canonicalDigest(left) === canonicalDigest(right);
	} catch {
		return false;
	}
}

export function createAgentResidencyReceipt(input: {
	agentId: AgentResidencyReceiptRef["agentId"];
	sessionId: AgentResidencyReceiptRef["sessionId"];
	runtimeInstanceId: AgentResidencyReceiptRef["runtimeInstanceId"];
	state: AgentResidencyState;
	revision: number;
	observedAt?: string;
	reasonDigest?: string;
}): AgentResult<AgentResidencyReceiptRef> {
	if (
		!isRuntimeId(input.agentId, "agent") ||
		!isRuntimeId(input.sessionId, "session") ||
		!isRuntimeId(input.runtimeInstanceId, "runtime") ||
		!Number.isSafeInteger(input.revision) ||
		input.revision < 0 ||
		(input.reasonDigest !== undefined && !DIGEST_PATTERN.test(input.reasonDigest))
	) {
		return fail("invalid_request", "residency receipt input is invalid");
	}
	const body: Omit<AgentResidencyReceiptRef, "receiptDigest"> = {
		receiptId: createRuntimeId("receipt"),
		agentId: input.agentId,
		sessionId: input.sessionId,
		runtimeInstanceId: input.runtimeInstanceId,
		state: input.state,
		revision: input.revision,
		observedAt: input.observedAt ?? new Date().toISOString(),
		...(input.reasonDigest ? { reasonDigest: input.reasonDigest } : {}),
	};
	return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
}

export function validateAgentResidencyReceipt(
	receipt: AgentResidencyReceiptRef,
	node: AgentNode,
): AgentResult<void> {
	let expectedDigest: string;
	try {
		expectedDigest = receiptDigest(receipt);
	} catch {
		return fail("invalid_request", "residency receipt is not canonical");
	}
	if (
		!isRuntimeId(receipt.receiptId, "receipt") ||
		receipt.agentId !== node.agentId ||
		receipt.sessionId !== node.sessionId ||
		!Number.isSafeInteger(receipt.revision) ||
		receipt.revision < 0 ||
		(node.residency !== undefined && receipt.revision <= node.residency.revision) ||
		!DIGEST_PATTERN.test(receipt.receiptDigest) ||
		receipt.receiptDigest !== expectedDigest
	) {
		return fail("invalid_request", "residency receipt is stale or uncorrelated");
	}
	return { ok: true, value: undefined };
}

export function stateForAgentInterruption(node: AgentNode, cause: AgentInterruptionCause): AgentState {
	if (cause === "cancelled" || cause === "budget_exhausted" || cause === "delegation_revoked") return "stopped";
	if (cause === "workspace_lost") return node.artifacts.length > 0 ? "partial" : "failed";
	if (cause === "residency_evicted") return node.artifacts.length > 0 ? "partial" : "paused";
	return node.artifacts.length > 0 ? "partial" : "failed";
}

export function createAgentInterruptionCommands(
	node: AgentNode,
	cause: AgentInterruptionCause,
	receipt: AgentResidencyReceiptRef,
	request: {
		requestId: CommandId;
		idempotencyKey: IdempotencyKey;
		occurredAt?: string;
		usage?: AgentSemanticTerminalRecord["usage"];
	},
): AgentResult<readonly AgentGraphSemanticCommand[]> {
	if (["completed", "failed", "stopped"].includes(node.state)) {
		return fail("invalid_transition", "terminal agent cannot be interrupted again");
	}
	const residencyAlreadyCommitted = receiptsAreExact(receipt, node.residency);
	if (!residencyAlreadyCommitted) {
		const validated = validateAgentResidencyReceipt(receipt, node);
		if (!validated.ok) return validated;
	}
	if (cause === "residency_evicted" && receipt.state !== "evicted") {
		return fail("invalid_request", "residency eviction requires an evicted receipt");
	}
	if (cause === "crash" && receipt.state !== "unavailable") {
		return fail("invalid_request", "crash requires an unavailable residency receipt");
	}
	const occurredAt = request.occurredAt ?? new Date().toISOString();
	const residency: AgentGraphSemanticCommand = {
		type: "agent.residency_changed",
		requestId: request.requestId,
		idempotencyKey: createIdempotencyKey(`agent-residency-${canonicalDigest(request.idempotencyKey).slice(0, 48)}`),
		occurredAt,
		receipt,
	};
	const common = {
		requestId: request.requestId,
		idempotencyKey: createIdempotencyKey(`agent-interruption-${canonicalDigest(request.idempotencyKey).slice(0, 48)}`),
		occurredAt,
		agentId: node.agentId,
		from: node.state,
		reason: cause,
	} as const;
	const state = stateForAgentInterruption(node, cause);
	const terminal = state === "stopped" || state === "failed"
		? createAgentSemanticTerminalRecord({
				agentId: node.agentId,
				requestId: request.requestId,
				idempotencyKey: common.idempotencyKey,
				outcome: state,
				reason: cause,
				...(request.usage ? { usage: request.usage } : {}),
				partialResults: node.artifacts.map((report) => report.artifact),
			})
		: undefined;
	const transition: AgentGraphSemanticCommand = state === "paused"
		? { ...common, type: "agent.paused" }
		: state === "partial"
			? { ...common, type: "agent.partial_committed" }
			: state === "stopped"
				? { ...common, type: "agent.stopped", terminal: terminal! }
				: {
						...common,
						type: "agent.failed",
						terminal: terminal!,
						error: {
							code: cause,
							messageDigest: canonicalDigest({ cause, residencyReceiptDigest: receipt.receiptDigest }),
							retryable: false,
							outcomeCertain: true,
							effect: "none",
						},
					};
	return { ok: true, value: residencyAlreadyCommitted ? [transition] : [residency, transition] };
}
