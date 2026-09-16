import { describe, expect, it } from "vitest";
import { buildGoalFragment } from "../../../../src/runtime/modes/goal/prompt.ts";
import { createGoalBaseState, reduceGoalModeState, type GoalModeCommand } from "../../../../src/runtime/modes/goal/reducer.ts";
import type { GoalModeState } from "../../../../src/runtime/modes/goal/types.ts";
import { runtimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";

const digest = runtimeDigest("goal-fragment");
const sessionId = createRuntimeId("session", "goal-fragment");
const goalId = createRuntimeId("goal", "goal-fragment");

function state(commands: readonly GoalModeCommand[]): GoalModeState {
	let current = createGoalBaseState({
		sessionId, goalId,
		policyCeilingDigest: digest,
		sourceHead: { streamId: sessionId, sequence: 3, eventHash: digest },
		updatedAt: "2026-09-17T00:00:00.000Z",
	});
	for (const command of commands) {
		const reduced = reduceGoalModeState(current, command);
		if (!reduced.ok) throw new Error(`${reduced.error.code}: ${reduced.error.message}`);
		current = reduced.value;
	}
	return current;
}

const at = "2026-09-17T00:00:00.000Z";
const activate = (budget?: { readonly tokenBudget?: number }): GoalModeCommand => ({
	type: "set", expectedRevision: 0, objective: "Ship the goal mode adaptation.", setBy: "user", updatedAt: at,
	...(budget === undefined ? {} : { budget: { ...budget } }),
});

describe("goal mode context fragment", () => {
	it("injects nothing while the goal is inactive", () => {
		expect(buildGoalFragment({ state: state([]) })).toBeUndefined();
	});

	it("binds the key to status, revision and objective digest", () => {
		const active = state([activate()]);
		const first = buildGoalFragment({ state: active })!;
		expect(first.key).toBe(`active:1:${active.objectiveDigest!.digest.slice(0, 16)}`);
		// 同一状态同 key（注入方据此去重）；续跑轮与普通轮必须区分。
		expect(buildGoalFragment({ state: active })!.key).toBe(first.key);
		expect(buildGoalFragment({ state: active, continuation: true })!.key).toBe(`${first.key}:c`);
		expect(buildGoalFragment({ state: state([activate(), { type: "record_continuation", expectedRevision: 1, updatedAt: at }]) })!.key)
			.not.toBe(first.key);
	});

	it("states the lower-bound semantics of a partial usage baseline", () => {
		const partial = state([activate(), { type: "account_usage", expectedRevision: 1, updatedAt: at, delta: { tokensUnknown: true } }]);
		const text = buildGoalFragment({ state: partial })!.text;
		expect(partial.usage.accountingCompleteness).toBe("partial");
		expect(text).toContain("observed lower bound");
		expect(text).toContain("Turns without usage data: 1");

		const complete = buildGoalFragment({ state: state([activate(), { type: "account_usage", expectedRevision: 1, updatedAt: at, delta: { inputTokens: 10 } }]) })!.text;
		expect(complete).not.toContain("observed lower bound");
	});

	it("adds the completion audit checklist only for a continuation turn", () => {
		const active = state([activate()]);
		const plain = buildGoalFragment({ state: active })!.text;
		expect(plain).toContain("<objective>");
		expect(plain).not.toContain("<completion_audit>");
		expect(plain).not.toContain("<goal_continuation>");

		const continuation = buildGoalFragment({ state: active, continuation: true })!.text;
		expect(continuation).toContain("<goal_continuation>");
		expect(continuation).toContain("<completion_audit>");
		expect(continuation).toContain("Verification scope must equal claim scope");
	});

	it("omits the todo section entirely instead of injecting an empty table", () => {
		const active = state([activate()]);
		expect(buildGoalFragment({ state: active })!.text).not.toContain("<todo_context>");

		const withTodo = buildGoalFragment({ state: active, todoSnapshot: "Overall: 1/2 done, 1 open." })!.text;
		expect(withTodo).toContain("<todo_context>");
		expect(withTodo).toContain("Overall: 1/2 done, 1 open.");
		// 空白快照等价于没有快照，不得插入空段。
		expect(buildGoalFragment({ state: active, todoSnapshot: "   " })!.text).not.toContain("<todo_context>");
	});

	it("tells the model not to work on a paused or exhaustedly-budgeted goal", () => {
		const paused = buildGoalFragment({ state: state([activate(), { type: "pause", expectedRevision: 1, reason: "user_requested", updatedAt: at }]) })!.text;
		expect(paused).toContain("paused");
		expect(paused).toContain("wait for an explicit resume");

		const budgetLimited = buildGoalFragment({
			state: state([activate({ tokenBudget: 10 }), { type: "account_usage", expectedRevision: 1, updatedAt: at, delta: { inputTokens: 10 } }]),
		})!.text;
		expect(budgetLimited).toContain("budget is exhausted");
		expect(budgetLimited).toContain("Budget exhaustion is not completion");

		const complete = buildGoalFragment({
			state: state([
				activate(),
				{ type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: at },
				{ type: "settle_complete", expectedRevision: 2, decision: "approved", updatedAt: at },
			]),
		})!.text;
		expect(complete).toContain("is complete");
		expect(complete).not.toContain("<objective>");
	});
});
