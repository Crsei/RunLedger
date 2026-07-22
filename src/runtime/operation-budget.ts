/** Agent loop 与 Orchestrator BudgetGuard 之间的最小事务端口。 */

import type { BudgetReservationId, CommandId } from "./protocol/v3/ids.ts";

export const AGENT_OPERATION_BUDGET_DIMENSIONS = [
	"inputTokens",
	"outputTokens",
	"usdMicros",
	"wallTimeMs",
	"toolCalls",
	"retries",
	"networkBytes",
	"storageBytes",
	"artifactCount",
	"verifications",
] as const;

export type AgentOperationBudgetDimension = (typeof AGENT_OPERATION_BUDGET_DIMENSIONS)[number];
export type AgentOperationBudgetUsage = Readonly<Record<AgentOperationBudgetDimension, number>>;
export type AgentOperationKind = "provider" | "tool";
export type AgentOperationOutcome = "succeeded" | "failed" | "cancelled" | "uncertain";

export interface AgentOperationBudgetReserveRequest {
	kind: AgentOperationKind;
	/** restart 后保持稳定；adapter 从它派生 reservation/operation/idempotency key。 */
	operationKey: string;
	estimatedUpperBound: AgentOperationBudgetUsage;
}

export interface AgentOperationBudgetReservation {
	kind: AgentOperationKind;
	operationKey: string;
	operationId: CommandId;
	reservationId: BudgetReservationId;
	estimatedUpperBound: AgentOperationBudgetUsage;
	reservedAtMs: number;
}

export interface AgentOperationBudgetCommitRequest {
	reservation: AgentOperationBudgetReservation;
	outcome: AgentOperationOutcome;
	actual: AgentOperationBudgetUsage;
	resultDigest: string;
}

export interface AgentOperationBudgetRefundRequest {
	reservation: AgentOperationBudgetReservation;
	reason: "cancelled" | "not_started";
}

/**
 * 所有方法都以 durable BudgetGuard mutation 为成功边界。实现抛错意味着调用方
 * 必须在开始副作用前拒绝，或在已开始后保持 uncertain gate，不能继续下一操作。
 */
export interface AgentOperationBudgetPort {
	reserve(request: AgentOperationBudgetReserveRequest): Promise<AgentOperationBudgetReservation>;
	commit(request: AgentOperationBudgetCommitRequest): Promise<void>;
	refund(request: AgentOperationBudgetRefundRequest): Promise<void>;
}

export function zeroAgentOperationBudgetUsage(): AgentOperationBudgetUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		usdMicros: 0,
		wallTimeMs: 0,
		toolCalls: 0,
		retries: 0,
		networkBytes: 0,
		storageBytes: 0,
		artifactCount: 0,
		verifications: 0,
	};
}
