import {
	GoalModeStateSchema,
	GoalProjectionSchema,
	RUNTIME_EVENT_PAYLOAD_REQUIREMENTS,
	RUNTIME_EVENT_TYPES,
	createRuntimeId,
	isGoalModeState,
	isRuntimeProjection,
	runtimeDigest,
} from "../../../src/runtime/contracts/public.ts";
import type { GoalModeState } from "../../../src/runtime/contracts/public.ts";

const digest = runtimeDigest("goal-contract-digest");
const sourceHead = { streamId: createRuntimeId("session", "goal-contract"), sequence: 3, eventHash: digest } as const;

export const GOAL_MODE_SCHEMAS = [GoalModeStateSchema, GoalProjectionSchema] as const;

/** 契约消费者的编译期锚点：goal 状态必须可被外部消费者接收。 */
export interface GoalModeContractConsumer {
	acceptGoalState(state: GoalModeState): void;
}

export const GOAL_EVENT_TYPES = [
	"goal.transitioned",
	"goal.budget_updated",
	"goal.budget_exhausted",
	"goal.usage_accounted",
	"goal.continuation_requested",
	"goal.continuation_suppressed",
	"loop.started",
	"loop.iteration_submitted",
	"loop.iteration_settled",
	"loop.stopped",
] as const;

export function goalModeContractFixture(): {
	readonly state: GoalModeState;
	readonly projection: Record<string, unknown>;
	readonly registered: readonly string[];
	readonly transitionRequirements: readonly string[];
} {
	const state: GoalModeState = {
		status: "active",
		sessionId: createRuntimeId("session", "goal-contract"),
		goalId: createRuntimeId("goal", "goal-contract"),
		revision: 2,
		objective: "Ship the goal mode adaptation end to end.",
		objectiveDigest: runtimeDigest("Ship the goal mode adaptation end to end."),
		budget: { tokenBudget: 200_000 },
		usage: {
			tokensUsed: 1_000,
			inputTokens: 700,
			cacheWriteTokens: 100,
			outputTokens: 200,
			activeDurationMs: 5_000,
			accountingCompleteness: "complete",
			unaccountedTurns: 0,
		},
		continuations: 1,
		policyCeilingDigest: digest,
		sourceHead,
		projectionDigest: digest,
		completeness: "complete",
		updatedAt: "2026-09-17T00:00:00.000Z",
	};
	const projection = {
		projectionKind: "goal",
		sessionId: state.sessionId,
		goalId: state.goalId,
		revision: state.revision,
		status: state.status,
		objective: state.objective,
		budget: state.budget,
		usage: state.usage,
		continuations: state.continuations,
		sourceHead,
		projectionDigest: digest,
		builtAt: "2026-09-17T00:00:00.000Z",
		completeness: "complete",
	};
	return {
		state,
		projection,
		registered: RUNTIME_EVENT_TYPES.filter((type) => GOAL_EVENT_TYPES.includes(type as (typeof GOAL_EVENT_TYPES)[number])),
		transitionRequirements: RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["goal.transitioned"],
	};
}

export function goalModeStateIsValid(state: unknown): state is GoalModeState {
	return isGoalModeState(state);
}

export function goalProjectionIsValid(value: unknown): boolean {
	return isRuntimeProjection(value);
}
