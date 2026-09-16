import {
	CompactionCheckpointSchema,
	ContextAssemblyReceiptSchema,
	GoalModeStateSchema,
	MemoryRecordSchema,
	ModelRouteDecisionSchema,
	PlanModeStateSchema,
} from "../../../src/runtime/contracts/public.ts";
import type {
	CompactionCheckpoint,
	ContextAssemblyReceipt,
	GoalModeState,
	MemoryRecord,
	ModelRouteDecision,
	ModelStreamPort,
	PlanModeState,
} from "../../../src/runtime/contracts/public.ts";

export interface PlanContextMemoryContractConsumer {
	readonly modelStream: ModelStreamPort;
	acceptModelRoute(decision: ModelRouteDecision): void;
	acceptPlanState(state: PlanModeState): void;
	acceptGoalState(state: GoalModeState): void;
	acceptContextReceipt(receipt: ContextAssemblyReceipt): void;
	acceptCompaction(checkpoint: CompactionCheckpoint): void;
	acceptMemory(record: MemoryRecord): void;
}

export const PLAN_CONTEXT_MEMORY_SCHEMAS = [
	ModelRouteDecisionSchema,
	PlanModeStateSchema,
	GoalModeStateSchema,
	ContextAssemblyReceiptSchema,
	CompactionCheckpointSchema,
	MemoryRecordSchema,
] as const;
