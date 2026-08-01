import {
	CompactionCheckpointSchema,
	ContextAssemblyReceiptSchema,
	MemoryRecordSchema,
	ModelRouteDecisionSchema,
	PlanModeStateSchema,
} from "../../../src/runtime/contracts/public.ts";
import type {
	CompactionCheckpoint,
	ContextAssemblyReceipt,
	MemoryRecord,
	ModelRouteDecision,
	ModelStreamPort,
	PlanModeState,
} from "../../../src/runtime/contracts/public.ts";

export interface PlanContextMemoryContractConsumer {
	readonly modelStream: ModelStreamPort;
	acceptModelRoute(decision: ModelRouteDecision): void;
	acceptPlanState(state: PlanModeState): void;
	acceptContextReceipt(receipt: ContextAssemblyReceipt): void;
	acceptCompaction(checkpoint: CompactionCheckpoint): void;
	acceptMemory(record: MemoryRecord): void;
}

export const PLAN_CONTEXT_MEMORY_SCHEMAS = [
	ModelRouteDecisionSchema,
	PlanModeStateSchema,
	ContextAssemblyReceiptSchema,
	CompactionCheckpointSchema,
	MemoryRecordSchema,
] as const;
