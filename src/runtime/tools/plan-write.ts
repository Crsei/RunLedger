import { Type } from "typebox";
import type { ExpectedRevision } from "../protocol/v3/events.ts";
import type { TraceId } from "../protocol/v3/ids.ts";
import type { AgentTool } from "../types.ts";
import type { PlanModeService } from "../modes/plan/service.ts";

const PlanWriteParameters = Type.Object({
	expectedRevision: Type.Integer({ minimum: 0 }),
	body: Type.String({ maxLength: 1_048_576 }),
}, { additionalProperties: false });

export interface PlanToolRuntimeBinding {
	service: PlanModeService;
	expectedEventRevision: () => ExpectedRevision;
	traceId: () => TraceId;
}

/** 唯一 Plan Mode 写入口；参数中刻意没有 path/planId/sessionId。 */
export function createPlanWriteTool(binding: PlanToolRuntimeBinding): AgentTool<typeof PlanWriteParameters> {
	return {
		name: "plan_write",
		label: "Write plan revision",
		description: "Write one immutable revision of the runtime-bound current plan. Does not accept a filesystem path.",
		parameters: PlanWriteParameters,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		isDestructive: () => false,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			if (signal?.aborted) throw new Error("plan write aborted before durable mutation");
			const state = await binding.service.writePlan(
				params.body,
				params.expectedRevision,
				binding.expectedEventRevision(),
				binding.traceId(),
			);
			if (state.kind !== "active") throw new Error("plan write did not produce active plan state");
			return {
				content: [{ type: "text", text: `plan revision ${state.plan.revision} committed (${state.plan.contentDigest})` }],
				details: { plan: state.plan, modeRevision: state.modeRevision },
			};
		},
	};
}
