import { describe, expect, it } from "vitest";
import { createGoalBaseState, reduceGoalModeState, type GoalModeCommand } from "../../../src/runtime/modes/goal/reducer.ts";
import type { GoalModeState } from "../../../src/runtime/modes/goal/types.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { DEFAULT_GOAL_SETTINGS, type EffectiveGoalSettings } from "../../../src/storage/settings-manager.ts";
import {
	decideGoalContinuation,
	goalUsageDeltaFrom,
	type GoalContinuationInput,
} from "../../../src/runtime/session-runtime/goal-continuation-controller.ts";

const digest = runtimeDigest("goal-continuation");
const sessionId = createRuntimeId("session", "goal-continuation");
const goalId = createRuntimeId("goal", "goal-continuation");
const at = "2026-09-17T00:00:00.000Z";

function state(commands: readonly GoalModeCommand[]): GoalModeState {
	let current = createGoalBaseState({
		sessionId, goalId, policyCeilingDigest: digest,
		sourceHead: { streamId: sessionId, sequence: 0, eventHash: digest }, updatedAt: at,
	});
	for (const command of commands) {
		const reduced = reduceGoalModeState(current, command);
		if (!reduced.ok) throw new Error(reduced.error.code);
		current = reduced.value;
	}
	return current;
}

const active = state([{ type: "set", expectedRevision: 0, objective: "objective", setBy: "user", updatedAt: at }]);

/** 默认全部条件通过，各用例只翻转被验证的那一项。 */
function input(overrides: Partial<GoalContinuationInput> = {}): GoalContinuationInput {
	return {
		settings: DEFAULT_GOAL_SETTINGS,
		loopRunning: false,
		state: active,
		idle: true,
		runBudgetTerminated: false,
		lastRunHadToolCalls: true,
		editorEmpty: true,
		queuesEmpty: true,
		driverAttached: true,
		ownerReady: true,
		...overrides,
	};
}

describe("decideGoalContinuation", () => {
	it("continues only when every guard passes", () => {
		expect(decideGoalContinuation(input())).toEqual({ continue: true });
	});

	it("stops when the goal is not active", () => {
		expect(decideGoalContinuation(input({ state: state([]) }))).toMatchObject({ reason: "no_goal" });
		const paused = state([{ type: "set", expectedRevision: 0, objective: "o", setBy: "user", updatedAt: at }, { type: "pause", expectedRevision: 1, reason: "user_requested", updatedAt: at }]);
		expect(decideGoalContinuation(input({ state: paused }))).toMatchObject({ reason: "goal_not_active" });
		const complete = state([
			{ type: "set", expectedRevision: 0, objective: "o", setBy: "user", updatedAt: at },
			{ type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: at },
			{ type: "settle_complete", expectedRevision: 2, decision: "approved", updatedAt: at },
		]);
		expect(decideGoalContinuation(input({ state: complete }))).toMatchObject({ reason: "goal_not_active" });
	});

	it("honours the settings gate and loop pre-emption", () => {
		expect(decideGoalContinuation(input({ settings: { ...DEFAULT_GOAL_SETTINGS, enabled: false } }))).toMatchObject({ reason: "disabled" });
		expect(decideGoalContinuation(input({ settings: { ...DEFAULT_GOAL_SETTINGS, autoContinuation: false } }))).toMatchObject({ reason: "disabled" });
		// loop 与 goal 续跑不叠加：loop 真在跑时跳过续跑；只是 settings 里启用不算。
		expect(decideGoalContinuation(input({ loopRunning: true }))).toMatchObject({ reason: "loop_active" });
	});

	it("never continues past a run budget termination or the continuation cap", () => {
		expect(decideGoalContinuation(input({ runBudgetTerminated: true }))).toMatchObject({ reason: "run_budget_terminated" });
		const capped = state([
			{ type: "set", expectedRevision: 0, objective: "o", setBy: "user", updatedAt: at },
			{ type: "record_continuation", expectedRevision: 1, updatedAt: at },
			{ type: "record_continuation", expectedRevision: 2, updatedAt: at },
		]);
		const settings: EffectiveGoalSettings = { ...DEFAULT_GOAL_SETTINGS, maxContinuations: 2 };
		expect(decideGoalContinuation(input({ state: capped, settings }))).toMatchObject({ reason: "max_continuations" });
		expect(decideGoalContinuation(input({ state: capped, settings: { ...settings, maxContinuations: 3 } }))).toEqual({ continue: true });
	});

	it("stops continuing while a completion request awaits user settlement", () => {
		const pending = state([
			{ type: "set", expectedRevision: 0, objective: "o", setBy: "agent", updatedAt: at },
			{ type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: at },
		]);
		expect(decideGoalContinuation(input({ state: pending }))).toMatchObject({ reason: "completion_pending" });
		// 用户拒绝后恢复续跑。
		const rejected = state([
			{ type: "set", expectedRevision: 0, objective: "o", setBy: "agent", updatedAt: at },
			{ type: "request_complete", expectedRevision: 1, requestedBy: "agent", updatedAt: at },
			{ type: "settle_complete", expectedRevision: 2, decision: "rejected", updatedAt: at },
		]);
		expect(decideGoalContinuation(input({ state: rejected }))).toEqual({ continue: true });
	});

	it("suppresses an idle continuation round with no tool calls", () => {
		expect(decideGoalContinuation(input({ lastRunHadToolCalls: false }))).toMatchObject({ reason: "no_tool_calls" });
	});

	it("requires an attached driver, an empty editor, empty queues and a settled owner", () => {
		expect(decideGoalContinuation(input({ ownerReady: false }))).toMatchObject({ reason: "owner_not_ready" });
		expect(decideGoalContinuation(input({ driverAttached: false }))).toMatchObject({ reason: "driver_absent" });
		expect(decideGoalContinuation(input({ editorEmpty: false }))).toMatchObject({ reason: "editor_not_empty" });
		expect(decideGoalContinuation(input({ queuesEmpty: false }))).toMatchObject({ reason: "queues_not_empty" });
		expect(decideGoalContinuation(input({ idle: false }))).toMatchObject({ reason: "not_idle" });
	});
});

describe("SessionGoalContinuationController idle detection", () => {
	it("treats a run as productive when an earlier turn used a tool, even if the last turn was text-only", async () => {
		const { SessionGoalContinuationController } = await import("../../../src/runtime/session-runtime/goal-continuation-controller.ts");
		const { DEFAULT_LOOP_SETTINGS } = await import("../../../src/storage/settings-manager.ts");
		const submissions: string[] = [];
		const suppressions: string[] = [];
		const goalState: GoalModeState = active;
		/** 每个 run 的形态：turn 1 调工具，turn 2 只回文本（末轮无工具调用）。 */
		const runShape = (controller: { handleDomainAgentEvent(event: never): void }, seed: string): void => {
			controller.handleDomainAgentEvent({ type: "agent_start", timestamp: 0 } as never);
			controller.handleDomainAgentEvent({ type: "turn_start", timestamp: 0, turn: 1 } as never);
			controller.handleDomainAgentEvent({ type: "tool_execution_end", timestamp: 0, toolCallId: seed, toolName: "goal", isError: false, result: { type: "toolResult", toolCallId: seed, toolName: "goal", content: [] } } as never);
			controller.handleDomainAgentEvent({ type: "turn_start", timestamp: 0, turn: 2 } as never);
			controller.handleDomainAgentEvent({ type: "agent_end", timestamp: 0, stopReason: "stop" } as never);
		};
		const domain = {
			controller: {
				prompt: async (text: string) => { submissions.push(text); },
				waitForIdle: async () => undefined,
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
			},
			snapshot: () => ({ inFlight: false }),
		};
		const withDomain = new SessionGoalContinuationController({
			domain: domain as never,
			goal: {
				inspect: () => ({ repositoryId: createRuntimeId("repository", "goal-continuation"), state: goalState }),
				accountUsage: async () => true,
				controlRevision: () => 1,
				pauseAfterRunBudget: async () => true,
				recordContinuation: async () => true,
				recordSuppression: (reason) => { suppressions.push(reason); return true; },
				markContinuationTurn: () => undefined,
				clearContinuationTurn: () => undefined,
			},
			sessionId: "session_fixture",
			fence: { sessionId, runtimeId: createRuntimeId("runtime", "fixture"), generation: 1 },
			barrier: { currentState: "closed", admitPrompt: () => ({ ok: true }) } as never,
			server: { driverConnectionId: () => createRuntimeId("connection", "fixture") } as never,
			state: () => "ready",
			emit: () => undefined,
			settings: { ...DEFAULT_GOAL_SETTINGS, continuationDelaySeconds: 1, maxContinuations: 5 },
			loopRunning: () => false,
		});
		// 首轮（用户输入触发）：有工具调用但末轮无工具调用 —— 不得被判为空转。
		runShape(withDomain, "c0");
		await new Promise((resolve) => { setTimeout(resolve, 1_100); });
		expect(submissions.length).toBeGreaterThanOrEqual(1);
		expect(suppressions).not.toContain("no_tool_calls");

		// 续跑轮的 agent 事件由测试直接驱动：同样判定为有效轮，产生第二次续跑。
		runShape(withDomain, "c1");
		await new Promise((resolve) => { setTimeout(resolve, 1_100); });
		expect(submissions.length).toBeGreaterThanOrEqual(2);
		expect(suppressions).not.toContain("no_tool_calls");

		// 真正空转的 run（全程无工具调用）才抑制下一次续跑。
		withDomain.handleDomainAgentEvent({ type: "agent_start", timestamp: 0 } as never);
		withDomain.handleDomainAgentEvent({ type: "turn_start", timestamp: 0, turn: 1 } as never);
		withDomain.handleDomainAgentEvent({ type: "agent_end", timestamp: 0, stopReason: "stop" } as never);
		await new Promise((resolve) => { setTimeout(resolve, 1_100); });
		expect(suppressions).toContain("no_tool_calls");
		withDomain.dispose();
		void goalState;
	});
});

describe("goalUsageDeltaFrom", () => {
	it("counts input + cacheWrite + output and excludes cacheRead", () => {
		const delta = goalUsageDeltaFrom({
			type: "message_end", timestamp: 1, role: "assistant",
			message: {
				role: "assistant", stopReason: "stop", content: [],
				usage: {
					input: 100, output: 30, cacheRead: 9_000, cacheWrite: 20, totalTokens: 9_150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
		// cacheRead 是复用前缀，不计费；cacheWrite 实际计费，必须计入。
		expect(delta).toEqual({ inputTokens: 100, cacheWriteTokens: 20, outputTokens: 30 });
	});

	it("reports missing usage as unknown instead of zero", () => {
		expect(goalUsageDeltaFrom({ type: "message_end", timestamp: 1, role: "assistant", message: { role: "assistant", stopReason: "stop", content: [] } }))
			.toEqual({ tokensUnknown: true });
		expect(goalUsageDeltaFrom({ type: "message_end", timestamp: 1, role: "user" })).toBeUndefined();
		expect(goalUsageDeltaFrom({ type: "turn_end", timestamp: 1, turn: 1 })).toBeUndefined();
	});
});
