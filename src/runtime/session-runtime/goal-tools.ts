/**
 * `goal` 工具：只调用 Session-owned Goal authority，不接受文件路径，也不直接改状态。
 *
 * 与 plan 工具的差异：goal 在 standard 会话**常驻**（D4，无动态工具集），非法状态
 * 调用由 reducer 以 typed error 拒绝，而不是「工具不存在」。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import type { SessionGoalDomain } from "./goal-domain.ts";

/**
 * goal 状态是会话内 canonical 记录，不触碰工作区文件。
 *
 * 这里沿用 plan 工件工具的做法：用 `workspace_write` claim 表达「会话自有的状态
 * 写入」。capability 词汇表没有「session state mutation」，而该 claim 正是 plan mode
 * 只读 ceiling 判定 write 的依据；换成 `repository_read` 会让模型在只读 plan mode
 * 下仍能改写目标。
 */
const GOAL_STATE_CLAIM = {
	name: "workspace_write" as const,
	resourceKind: "filesystem" as const,
	resourceDigest: runtimeDigest("session-goal-state"),
	constraintsDigest: runtimeDigest("goal-state-only"),
	scope: "invocation" as const,
};

export interface SessionGoalTools {
	readonly tools: readonly AgentTool[];
}

const budgetSchema = Type.Object(
	{
		tokenBudget: Type.Optional(Type.Integer({ minimum: 0, description: "Total token budget for the goal" })),
		timeBudgetMs: Type.Optional(Type.Integer({ minimum: 0, description: "Active-time budget in milliseconds" })),
	},
	{ additionalProperties: false },
);

const goalSchema = Type.Object(
	{
		op: Type.Union([
			Type.Literal("create"),
			Type.Literal("get"),
			Type.Literal("complete"),
			Type.Literal("resume"),
			Type.Literal("drop"),
			Type.Literal("set_budget"),
		], { description: "Operation to perform" }),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0, description: "State revision from goal({op:\"get\"})" })),
		objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096, description: "Required for create: the complete objective" })),
		budget: Type.Optional(budgetSchema),
	},
	{ additionalProperties: false },
);

type GoalInput = Static<typeof goalSchema>;

const GOAL_TOOL_DESCRIPTION = [
	"Manage the session's goal-mode objective.",
	"",
	"Single `op` field:",
	"- `create`: starts the goal and enables goal mode. Requires `objective`; optional `budget`. Only valid when no goal exists.",
	"- `get`: returns the current objective, status, budget and observed usage.",
	"- `complete`: asserts the goal is done. Records a completion request the user settles; it does not complete the goal by itself.",
	"- `resume`: reactivates a paused goal.",
	"- `drop`: discards the goal without completing it.",
	"- `set_budget`: replaces the token/time budget.",
	"",
	"Never call `complete` because the budget is nearly spent or the turn is ending; only when every deliverable has direct current-state evidence.",
	"`expectedRevision` comes from `goal({op:\"get\"})`; a stale value is rejected instead of silently applied.",
].join("\n");

export function createSessionGoalTools(domain: SessionGoalDomain): SessionGoalTools {
	const mutate = async (operation: string, input: Record<string, unknown>) => {
		const revision = domain.inspect().state.revision;
		const result = await domain.mutate(operation, { ...input, expectedRevision: revision }, {
			expectedRevision: revision,
			correlationId: `goal-tool-${operation}-${revision}`,
			effectId: `goal-tool-${operation}-${revision}`,
		});
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result.ok ? result.value : { code: result.code }) }],
			details: {},
			...(result.ok ? {} : { isError: true }),
		};
	};

	const goal: AgentTool<typeof goalSchema> = {
		name: "goal",
		label: "Goal",
		description: GOAL_TOOL_DESCRIPTION,
		parameters: goalSchema,
		capabilityClaims: [GOAL_STATE_CLAIM],
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		async execute(_toolCallId: string, input: GoalInput) {
			switch (input.op) {
				case "get":
					return { content: [{ type: "text" as const, text: JSON.stringify(domain.inspect()) }], details: {} };
				case "create":
					if (input.objective === undefined) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ code: "invalid_objective" }) }], details: {}, isError: true };
					}
					return mutate("goal.set", {
						objective: input.objective,
						...(input.budget === undefined ? {} : { budget: input.budget }),
						setBy: "agent",
					});
				case "complete":
					return mutate("goal.request_complete", { requestedBy: "agent" });
				case "resume":
					return mutate("goal.resume", {});
				case "drop":
					return mutate("goal.drop", {});
				case "set_budget":
					return mutate("goal.set_budget", input.budget === undefined ? {} : { budget: input.budget });
			}
		},
	};
	return { tools: [goal] };
}
