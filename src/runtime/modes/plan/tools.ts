import { Type } from "typebox";
import type { AgentTool } from "../../types.ts";
import type { PlanToolRuntimeBinding } from "../../tools/plan-write.ts";

const EnterPlanModeParameters = Type.Object({}, { additionalProperties: false });
const ExitPlanModeParameters = Type.Object({}, { additionalProperties: false });

export function createEnterPlanModeTool(binding: PlanToolRuntimeBinding): AgentTool<typeof EnterPlanModeParameters> {
	return {
		name: "enter_plan_mode",
		label: "Request plan mode",
		description: "Request user-approved activation of read-only plan mode at the next safe point.",
		parameters: EnterPlanModeParameters,
		executionMode: "sequential",
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		isDestructive: () => false,
		execute: async (_toolCallId, _params, signal) => {
			if (signal?.aborted) throw new Error("plan activation request aborted");
			const state = await binding.service.requestActivation(
				"agent",
				binding.expectedEventRevision(),
				binding.traceId(),
			);
			return { content: [{ type: "text", text: "plan mode activation is pending user approval and a safe turn boundary" }], details: { state } };
		},
	};
}

export function createExitPlanModeTool(binding: PlanToolRuntimeBinding): AgentTool<typeof ExitPlanModeParameters> {
	return {
		name: "exit_plan_mode",
		label: "Request plan approval",
		description: "Pin the current immutable plan revision and request a human implementation decision.",
		parameters: ExitPlanModeParameters,
		executionMode: "sequential",
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		isDestructive: () => false,
		execute: async (_toolCallId, _params, signal) => {
			if (signal?.aborted) throw new Error("plan approval request aborted");
			const state = await binding.service.requestApproval(
				binding.expectedEventRevision(),
				binding.traceId(),
			);
			if (state.kind !== "awaiting_approval") throw new Error("plan approval did not enter awaiting state");
			return {
				content: [{ type: "text", text: `plan revision ${state.plan.revision} is awaiting human approval` }],
				details: { plan: state.plan, approval: state.approval, modeRevision: state.modeRevision },
			};
		},
	};
}
