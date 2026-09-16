import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";
import type { GoalModeState } from "../../../../src/runtime/modes/goal/types.ts";
import {
	createGoalBaseState,
	reduceGoalModeState,
	restoreGoalModeState,
	snapshotGoalModeState,
	type GoalModeCommand,
} from "../../../../src/runtime/modes/goal/reducer.ts";
import type { GoalResult } from "../../../../src/runtime/modes/goal/errors.ts";

const digest = runtimeDigest("goal-mode-red");
const sessionId = createRuntimeId("session", "goal-mode-red");
const goalId = createRuntimeId("goal", "goal-mode-red");
const timestamp = "2026-09-17T00:00:00.000Z";

function unwrap<T>(result: GoalResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function base(): GoalModeState {
	return createGoalBaseState({
		sessionId,
		goalId,
		policyCeilingDigest: digest,
		sourceHead: { streamId: sessionId, sequence: 0, eventHash: digest },
		updatedAt: timestamp,
	});
}

function apply(state: GoalModeState, command: GoalModeCommand): GoalModeState {
	return unwrap(reduceGoalModeState(state, command));
}

describe("Goal Mode reducer", () => {
	it("starts from an inactive baseline with zero usage and no objective", () => {
		const state = base();
		expect(state).toMatchObject({
			status: "inactive",
			revision: 0,
			continuations: 0,
			usage: { tokensUsed: 0, accountingCompleteness: "complete", unaccountedTurns: 0 },
			budget: {},
		});
		expect(state.objective).toBeUndefined();
	});

	it("activates a goal from inactive and rejects a second set", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "Ship goal mode.", setBy: "user", updatedAt: timestamp });
		expect(active).toMatchObject({ status: "active", revision: 1, objective: "Ship goal mode.", continuations: 0 });
		expect(active.objectiveDigest).toEqual(runtimeDigest("Ship goal mode."));

		const second = reduceGoalModeState(active, { type: "set", expectedRevision: 1, objective: "Another goal.", setBy: "user", updatedAt: timestamp });
		expect(second).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
	});

	it("rejects a stale expected revision instead of applying it", () => {
		const result = reduceGoalModeState(base(), { type: "set", expectedRevision: 5, objective: "x", setBy: "user", updatedAt: timestamp });
		expect(result).toMatchObject({ ok: false, error: { code: "stale_expected_revision", retryable: true, expectedRevision: 5, actualRevision: 0 } });
	});

	it("enforces the legal transition matrix", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "objective", setBy: "user", updatedAt: timestamp });
		const paused = apply(active, { type: "pause", expectedRevision: 1, reason: "user_requested", updatedAt: timestamp });
		expect(paused).toMatchObject({ status: "paused", pauseReason: "user_requested" });

		// 只有 active 才能 pause。
		expect(reduceGoalModeState(paused, { type: "pause", expectedRevision: 2, reason: "again", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "illegal_transition" } });
		// 未设置目标时不能 request_complete。
		expect(reduceGoalModeState(base(), { type: "request_complete", expectedRevision: 0, requestedBy: "agent", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "illegal_transition" } });

		const resumed = apply(paused, { type: "resume", expectedRevision: 2, updatedAt: timestamp });
		expect(resumed).toMatchObject({ status: "active" });
		expect(resumed.pauseReason).toBeUndefined();

		const requested = apply(resumed, { type: "request_complete", expectedRevision: 3, requestedBy: "agent", updatedAt: timestamp });
		expect(requested).toMatchObject({ status: "active", completion: { requestedBy: "agent" } });
		// 结算必须在请求之后，模型不能自我结算。
		expect(reduceGoalModeState(requested, { type: "settle_complete", expectedRevision: 4, decision: "approved", updatedAt: timestamp }))
			.toMatchObject({ ok: true, value: { status: "complete", completedAt: timestamp } });
		expect(reduceGoalModeState(active, { type: "settle_complete", expectedRevision: 1, decision: "approved", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "completion_not_requested" } });
	});

	it("keeps a rejected completion request on the active goal", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "objective", setBy: "agent", updatedAt: timestamp });
		const requested = apply(active, { type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: timestamp });
		const rejected = apply(requested, { type: "settle_complete", expectedRevision: 2, decision: "rejected", updatedAt: timestamp });
		expect(rejected).toMatchObject({ status: "active" });
		expect(rejected.completion).toBeUndefined();
	});

	it("accumulates only input + cacheWrite + output and keeps unknown usage out of the lower bound", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "objective", setBy: "user", updatedAt: timestamp });
		const accounted = apply(active, {
			type: "account_usage", expectedRevision: 1, updatedAt: timestamp,
			// cacheRead 由调用方排除，这里验证的是入账口径与下界一致性。
			delta: { inputTokens: 100, cacheWriteTokens: 20, outputTokens: 30, activeDurationMs: 1_500 },
		});
		expect(accounted.usage).toMatchObject({
			tokensUsed: 150, inputTokens: 100, cacheWriteTokens: 20, outputTokens: 30,
			activeDurationMs: 1_500, accountingCompleteness: "complete", unaccountedTurns: 0,
		});

		const unknown = apply(accounted, { type: "account_usage", expectedRevision: 2, updatedAt: timestamp, delta: { tokensUnknown: true } });
		expect(unknown.usage).toMatchObject({ tokensUsed: 150, accountingCompleteness: "partial", unaccountedTurns: 1 });
	});

	it("only marks the goal budget-limited when the complete baseline proves exhaustion", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "objective", setBy: "user", updatedAt: timestamp });
		const budgeted = apply(active, { type: "set_budget", expectedRevision: 1, budget: { tokenBudget: 200 }, updatedAt: timestamp });

		// partial 完整度下 tokensUsed 只是下界：即使超过预算也不得判定耗尽。
		const partial = apply(budgeted, { type: "account_usage", expectedRevision: 2, updatedAt: timestamp, delta: { tokensUnknown: true } });
		const overBudgetButPartial = apply(partial, { type: "account_usage", expectedRevision: 3, updatedAt: timestamp, delta: { inputTokens: 500 } });
		expect(overBudgetButPartial.usage.tokensUsed).toBe(500);
		expect(overBudgetButPartial.usage.accountingCompleteness).toBe("partial");
		expect(overBudgetButPartial.status).toBe("active");

		// 完整度确证时才进入 budget_limited，并要求提高预算后才能 resume。
		const exhausted = apply(budgeted, { type: "account_usage", expectedRevision: 2, updatedAt: timestamp, delta: { inputTokens: 200 } });
		expect(exhausted).toMatchObject({ status: "budget_limited", pauseReason: "budget_exhausted" });
		expect(reduceGoalModeState(exhausted, { type: "resume", expectedRevision: 3, updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "invalid_budget" } });
		const raised = apply(exhausted, { type: "set_budget", expectedRevision: 3, budget: { tokenBudget: 1_000 }, updatedAt: timestamp });
		expect(apply(raised, { type: "resume", expectedRevision: 4, updatedAt: timestamp })).toMatchObject({ status: "active" });
	});

	it("counts continuations and resets them when the objective is replaced", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "first", setBy: "user", updatedAt: timestamp });
		const continued = apply(active, { type: "record_continuation", expectedRevision: 1, updatedAt: timestamp });
		expect(continued.continuations).toBe(1);
		const replaced = apply(continued, { type: "replace", expectedRevision: 2, objective: "second", setBy: "user", updatedAt: timestamp });
		expect(replaced).toMatchObject({ status: "active", objective: "second", continuations: 0 });
		expect(replaced.usage.tokensUsed).toBe(0);
	});

	it("clears optional fields instead of writing undefined into the exact schema", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "objective", setBy: "user", updatedAt: timestamp });
		const paused = apply(active, { type: "pause", expectedRevision: 1, reason: "user_requested", updatedAt: timestamp });
		// resume 必须真正移除 pauseReason；写成 undefined 会被 exact schema 拒绝。
		const resumed = apply(paused, { type: "resume", expectedRevision: 2, updatedAt: timestamp });
		expect(resumed.status).toBe("active");
		expect("pauseReason" in resumed).toBe(false);

		// replace 必须真正移除上一个目标的完成请求。
		const requested = apply(active, { type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: timestamp });
		const replaced = apply(requested, { type: "replace", expectedRevision: 2, objective: "next objective", setBy: "user", updatedAt: timestamp });
		expect("completion" in replaced).toBe(false);

		// 续跑记账同样清掉 stale 完成请求，且不写 undefined。
		const continued = apply(requested, { type: "record_continuation", expectedRevision: 2, updatedAt: timestamp });
		expect("completion" in continued).toBe(false);
		expect(continued.continuations).toBe(1);

		// drop 清除 completion 与 completedAt。
		const dropped = apply(requested, { type: "drop", expectedRevision: 2, updatedAt: timestamp });
		expect(dropped.status).toBe("dropped");
		expect("completion" in dropped).toBe(false);
		expect("completedAt" in dropped).toBe(false);
	});

	it("rejects malformed objectives, budgets and usage deltas", () => {
		expect(reduceGoalModeState(base(), { type: "set", expectedRevision: 0, objective: "   ", setBy: "user", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "invalid_objective" } });
		expect(reduceGoalModeState(base(), { type: "set", expectedRevision: 0, objective: "x", budget: { tokenBudget: -1 }, setBy: "user", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "invalid_budget" } });
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "x", setBy: "user", updatedAt: timestamp });
		expect(reduceGoalModeState(active, { type: "account_usage", expectedRevision: 1, updatedAt: timestamp, delta: { inputTokens: -5 } }))
			.toMatchObject({ ok: false, error: { code: "invalid_usage" } });
		expect(reduceGoalModeState(active, { type: "pause", expectedRevision: 1, reason: "", updatedAt: timestamp }))
			.toMatchObject({ ok: false, error: { code: "invalid_command" } });
	});

	it("round-trips snapshots and rejects drifted restores", () => {
		const active = apply(base(), { type: "set", expectedRevision: 0, objective: "x", setBy: "user", updatedAt: timestamp });
		const snapshot = unwrap(snapshotGoalModeState(active));
		expect(unwrap(restoreGoalModeState(snapshot))).toEqual(active);

		expect(restoreGoalModeState({ ...active, status: "active", usage: { ...active.usage, tokensUsed: 7 } }))
			.toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
		expect(snapshotGoalModeState({ ...active, objectiveDigest: digest }))
			.toMatchObject({ ok: false, error: { code: "invalid_state" } });
	});
});
