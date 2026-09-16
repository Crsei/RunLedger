/**
 * Goal Mode reducer：照 modes/plan/reducer.ts 的纪律实现。
 *
 * 只归约当前冻结 GoalModeState，不读取 prompt、TUI、usage 或外部状态；
 * 跨字段不变量在 isValidGoalModeState 校验，projection 用 reproject 重算 digest。
 */

import { runtimeDigest, type RuntimeDigest, type RuntimeStreamHead } from "../../protocol/foundation.ts";
import { isCanonicalUtcTimestamp, isRuntimeDigest } from "../../protocol/foundation-schemas.ts";
import { isRuntimeId, type GoalId, type SessionId } from "../../protocol/ids.ts";
import { isGoalCompletionRequest, isGoalModeState } from "./schema.ts";
import {
	EMPTY_GOAL_BUDGET,
	EMPTY_GOAL_USAGE,
	GOAL_OBJECTIVE_MAX_BYTES,
	type GoalAccountingCompleteness,
	type GoalBudget,
	type GoalModeState,
	type GoalUsage,
} from "./types.ts";
import { goalFailure, type GoalResult } from "./errors.ts";

export interface SetGoalCommand {
	readonly type: "set";
	readonly expectedRevision: number;
	readonly objective: string;
	readonly budget?: GoalBudget;
	readonly setBy: "user" | "agent";
	readonly updatedAt: string;
}

/** 替换目标正文：视为新目标，用量与续跑计数归零，预算沿用或显式替换。 */
export interface ReplaceGoalCommand {
	readonly type: "replace";
	readonly expectedRevision: number;
	readonly objective: string;
	readonly budget?: GoalBudget;
	readonly setBy: "user" | "agent";
	readonly updatedAt: string;
}

export interface PauseGoalCommand {
	readonly type: "pause";
	readonly expectedRevision: number;
	readonly reason: string;
	readonly updatedAt: string;
}

export interface ResumeGoalCommand {
	readonly type: "resume";
	readonly expectedRevision: number;
	readonly updatedAt: string;
}

export interface DropGoalCommand {
	readonly type: "drop";
	readonly expectedRevision: number;
	readonly updatedAt: string;
}

/** 模型或用户断言目标完成；结算只由 settle_complete 完成，模型不能自我结算。 */
export interface RequestGoalCompleteCommand {
	readonly type: "request_complete";
	readonly expectedRevision: number;
	readonly requestedBy: "agent" | "user";
	readonly updatedAt: string;
}

export interface SettleGoalCompleteCommand {
	readonly type: "settle_complete";
	readonly expectedRevision: number;
	readonly decision: "approved" | "rejected";
	readonly updatedAt: string;
}

export interface SetGoalBudgetCommand {
	readonly type: "set_budget";
	readonly expectedRevision: number;
	readonly budget: GoalBudget;
	readonly updatedAt: string;
}

/** 一次用量记账；`unknown` 分项通过 accountingCompleteness/unaccountedTurns 表达。 */
export interface AccountGoalUsageCommand {
	readonly type: "account_usage";
	readonly expectedRevision: number;
	readonly delta: GoalUsageDelta;
	readonly updatedAt: string;
}

export interface RecordGoalContinuationCommand {
	readonly type: "record_continuation";
	readonly expectedRevision: number;
	readonly updatedAt: string;
}

export interface GoalUsageDelta {
	readonly inputTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly outputTokens?: number;
	readonly activeDurationMs?: number;
	/** 本轮用量不可知（全部或部分分项缺失）时为 true，只降完整度、不累加。 */
	readonly tokensUnknown?: boolean;
}

export type GoalModeCommand =
	| SetGoalCommand
	| ReplaceGoalCommand
	| PauseGoalCommand
	| ResumeGoalCommand
	| DropGoalCommand
	| RequestGoalCompleteCommand
	| SettleGoalCompleteCommand
	| SetGoalBudgetCommand
	| AccountGoalUsageCommand
	| RecordGoalContinuationCommand;

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function sameUsage(left: GoalUsage, right: GoalUsage): boolean {
	return (
		left.tokensUsed === right.tokensUsed &&
		left.inputTokens === right.inputTokens &&
		left.cacheWriteTokens === right.cacheWriteTokens &&
		left.outputTokens === right.outputTokens &&
		left.activeDurationMs === right.activeDurationMs &&
		left.accountingCompleteness === right.accountingCompleteness &&
		left.unaccountedTurns === right.unaccountedTurns
	);
}

function validExpectedRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validObjective(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= GOAL_OBJECTIVE_MAX_BYTES &&
		Buffer.byteLength(value, "utf8") <= GOAL_OBJECTIVE_MAX_BYTES
	);
}

export function isValidGoalObjective(value: unknown): value is string {
	return validObjective(value);
}

function validBudget(value: unknown): value is GoalBudget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "tokenBudget" && key !== "timeBudgetMs") return false;
	}
	for (const key of ["tokenBudget", "timeBudgetMs"] as const) {
		const entry = record[key];
		if (entry !== undefined && (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) return false;
	}
	return true;
}

export function isValidGoalBudget(value: unknown): value is GoalBudget {
	return validBudget(value);
}

/** 比公共 schema 更严格地验证 reducer 所需的跨字段不变量。 */
export function isValidGoalModeState(state: unknown): state is GoalModeState {
	if (!isGoalModeState(state)) return false;
	if (state.sourceHead.streamId !== state.sessionId) return false;
	if (state.status === "inactive") {
		return (
			state.objective === undefined &&
			state.objectiveDigest === undefined &&
			state.completion === undefined &&
			state.completedAt === undefined &&
			state.pauseReason === undefined &&
			state.continuations === 0 &&
			state.budget.tokenBudget === undefined &&
			state.budget.timeBudgetMs === undefined &&
			sameUsage(state.usage, EMPTY_GOAL_USAGE)
		);
	}
	if (!validObjective(state.objective)) return false;
	if (state.objectiveDigest === undefined || !sameDigest(state.objectiveDigest, runtimeDigest(state.objective))) return false;
	if (!validBudget(state.budget)) return false;
	if (state.budget.tokenBudget === undefined && state.budget.timeBudgetMs === undefined && state.status === "budget_limited") return false;
	if (state.status === "complete") return state.completedAt !== undefined && state.completion !== undefined;
	if (state.completedAt !== undefined) return false;
	if (state.status === "paused") return state.pauseReason !== undefined && state.pauseReason.length > 0;
	return state.pauseReason === undefined || state.status === "budget_limited" || state.status === "dropped";
}

function cloneGoalModeState(state: GoalModeState): GoalModeState {
	return { ...state, budget: { ...state.budget }, usage: { ...state.usage }, ...(state.objectiveDigest === undefined ? {} : { objectiveDigest: { ...state.objectiveDigest } }) };
}

export function snapshotGoalModeState(state: GoalModeState): GoalResult<GoalModeState> {
	return isValidGoalModeState(state)
		? { ok: true, value: cloneGoalModeState(state) }
		: goalFailure("invalid_state", "goal mode state failed snapshot invariants");
}

export function restoreGoalModeState(snapshot: unknown): GoalResult<GoalModeState> {
	return isValidGoalModeState(snapshot)
		? { ok: true, value: cloneGoalModeState(snapshot) }
		: goalFailure("invalid_snapshot", "goal mode snapshot failed exact and cross-field validation");
}

export interface GoalBaseStateInput {
	readonly sessionId: SessionId;
	readonly goalId: GoalId;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly sourceHead: RuntimeStreamHead;
	readonly updatedAt: string;
}

/** inactive 基线的唯一构造点：domain 重放与 inspection 投影共用，避免两处造默认值。 */
export function createGoalBaseState(input: GoalBaseStateInput): GoalModeState {
	return reprojectGoalModeState(
		{
			status: "inactive",
			sessionId: input.sessionId,
			goalId: input.goalId,
			revision: 0,
			budget: { ...EMPTY_GOAL_BUDGET },
			usage: { ...EMPTY_GOAL_USAGE },
			continuations: 0,
			policyCeilingDigest: input.policyCeilingDigest,
			sourceHead: input.sourceHead,
			completeness: "complete",
			updatedAt: input.updatedAt,
		} as unknown as GoalModeState,
		input.sourceHead,
	);
}

/** 用当前 source head 重算 projection digest；唯一写入口，避免各处漏算。 */
export function reprojectGoalModeState(state: GoalModeState, sourceHead: RuntimeStreamHead): GoalModeState {
	const { projectionDigest: _digest, ...body } = state;
	const next = { ...body, sourceHead, projectionDigest: runtimeDigest(body) } as GoalModeState;
	if (!isValidGoalModeState(next)) throw new Error("goal_projection_corrupt");
	return next;
}

function commandEnvelope(value: unknown): value is { readonly expectedRevision: number; readonly updatedAt: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return validExpectedRevision(record.expectedRevision as number) && isCanonicalUtcTimestamp(record.updatedAt);
}

type GoalStateBody = Omit<GoalModeState, "sessionId" | "goalId" | "revision" | "policyCeilingDigest" | "sourceHead" | "projectionDigest" | "completeness" | "updatedAt">;

/**
 * 归约一步。`changes` 中显式的 `undefined` 表示**清除**该可选字段，
 * 而不是把它写成 undefined —— exact schema 不接受 undefined 值。
 */
function nextState(state: GoalModeState, changes: Partial<GoalStateBody>, updatedAt: string): GoalResult<GoalModeState> {
	const merged: Record<string, unknown> = { ...state, ...changes, revision: state.revision + 1, updatedAt };
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete merged[key];
	}
	const next = merged as unknown as GoalModeState;
	return isValidGoalModeState(next) ? { ok: true, value: next } : goalFailure("invalid_state", "goal reducer produced an invalid state");
}

function objectiveChange(objective: string, budget: GoalBudget | undefined, state: GoalModeState): Partial<GoalStateBody> {
	const merged: GoalBudget = budget === undefined ? { ...EMPTY_GOAL_BUDGET } : { ...budget };
	return {
		status: "active",
		objective,
		objectiveDigest: runtimeDigest(objective),
		budget: merged,
		usage: { ...EMPTY_GOAL_USAGE },
		continuations: 0,
		// replace 视为新目标：清掉上一个目标的完成请求。
		completion: undefined,
	};
}

function validUsageDelta(delta: GoalUsageDelta): boolean {
	for (const amount of [delta.inputTokens, delta.cacheWriteTokens, delta.outputTokens, delta.activeDurationMs]) {
		if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) return false;
	}
	return delta.tokensUnknown === undefined || typeof delta.tokensUnknown === "boolean";
}

function newUsage(current: GoalUsage, delta: GoalUsageDelta): GoalUsage {
	const input = delta.inputTokens ?? 0;
	const cacheWrite = delta.cacheWriteTokens ?? 0;
	const output = delta.outputTokens ?? 0;
	const tokensUnknown = delta.tokensUnknown === true;
	return {
		tokensUsed: current.tokensUsed + input + cacheWrite + output,
		inputTokens: current.inputTokens + input,
		cacheWriteTokens: current.cacheWriteTokens + cacheWrite,
		outputTokens: current.outputTokens + output,
		activeDurationMs: current.activeDurationMs + (delta.activeDurationMs ?? 0),
		accountingCompleteness: tokensUnknown ? "partial" : current.accountingCompleteness,
		unaccountedTurns: current.unaccountedTurns + (tokensUnknown ? 1 : 0),
	};
}

/** 预算耗尽只在**完整度确证**时成立：partial 下 tokensUsed 是下界，不得据此停止。 */
function budgetExhausted(budget: GoalBudget, usage: GoalUsage): boolean {
	if (usage.accountingCompleteness !== "complete") return false;
	if (usage.unaccountedTurns > 0) return false;
	if (budget.tokenBudget !== undefined && usage.tokensUsed >= budget.tokenBudget) return true;
	return budget.timeBudgetMs !== undefined && usage.activeDurationMs >= budget.timeBudgetMs;
}

/** 只归约当前冻结 GoalModeState；不读取 prompt、TUI 或外部状态。 */
export function reduceGoalModeState(state: GoalModeState, command: GoalModeCommand): GoalResult<GoalModeState> {
	if (!isValidGoalModeState(state)) return goalFailure("invalid_state", "goal mode state failed reducer invariants");
	if (!commandEnvelope(command)) return goalFailure("invalid_command", "goal command has an invalid expected revision or timestamp");
	if (command.expectedRevision !== state.revision) {
		return goalFailure("stale_expected_revision", "goal mode revision changed before command execution", {
			retryable: true,
			expectedRevision: command.expectedRevision,
			actualRevision: state.revision,
		});
	}

	switch (command.type) {
		case "set":
			if (state.status !== "inactive") return goalFailure("illegal_transition", "goal set requires an inactive session goal");
			if (!validObjective(command.objective)) return goalFailure("invalid_objective", "goal objective is empty, oversized, or not a string");
			if (command.budget !== undefined && !validBudget(command.budget)) return goalFailure("invalid_budget", "goal budget is malformed");
			return nextState(state, objectiveChange(command.objective, command.budget, state), command.updatedAt);

		case "replace":
			if (state.status === "inactive" || state.status === "complete" || state.status === "dropped") {
				return goalFailure("illegal_transition", "goal replace requires a live goal");
			}
			if (!validObjective(command.objective)) return goalFailure("invalid_objective", "goal objective is empty, oversized, or not a string");
			if (command.budget !== undefined && !validBudget(command.budget)) return goalFailure("invalid_budget", "goal budget is malformed");
			return nextState(
				state,
				{ ...objectiveChange(command.objective, command.budget ?? state.budget, state), pauseReason: undefined },
				command.updatedAt,
			);

		case "pause":
			if (state.status !== "active") return goalFailure("illegal_transition", "only an active goal can be paused");
			if (command.reason.length === 0 || command.reason.length > 128) return goalFailure("invalid_command", "pause reason is empty or too long");
			return nextState(state, { status: "paused", pauseReason: command.reason }, command.updatedAt);

		case "resume": {
			if (state.status !== "paused" && state.status !== "budget_limited") {
				return goalFailure("illegal_transition", "only a paused or budget-limited goal can be resumed");
			}
			// 预算仍耗尽时不得凭 resume 绕过：必须先 set_budget 提高上限（D6）。
			if (budgetExhausted(state.budget, state.usage)) {
				return goalFailure("invalid_budget", "goal budget is still exhausted; raise the budget before resuming");
			}
			return nextState(state, { status: "active", pauseReason: undefined }, command.updatedAt);
		}

		case "drop":
			if (state.status === "inactive") return goalFailure("illegal_transition", "there is no goal to drop");
			if (state.status === "dropped") return goalFailure("illegal_transition", "goal is already dropped");
			return nextState(state, { status: "dropped", completion: undefined, pauseReason: undefined, completedAt: undefined }, command.updatedAt);

		case "request_complete":
			if (state.status !== "active") return goalFailure("illegal_transition", "completion can only be requested for an active goal");
			if (state.completion !== undefined) return goalFailure("illegal_transition", "goal completion is already requested");
			return nextState(state, { completion: { requestedAt: command.updatedAt, requestedBy: command.requestedBy } }, command.updatedAt);

		case "settle_complete": {
			if (state.status !== "active" || state.completion === undefined) {
				return goalFailure("completion_not_requested", "goal completion must be requested before it is settled");
			}
			if (command.decision === "approved") {
				return nextState(state, { status: "complete", completedAt: command.updatedAt }, command.updatedAt);
			}
			return nextState(state, { completion: undefined }, command.updatedAt);
		}

		case "set_budget":
			if (state.status === "inactive") return goalFailure("illegal_transition", "there is no goal to budget");
			if (!validBudget(command.budget)) return goalFailure("invalid_budget", "goal budget is malformed");
			return nextState(state, { budget: { ...command.budget } }, command.updatedAt);

		case "account_usage": {
			if (state.status !== "active") return goalFailure("illegal_transition", "usage is only accounted for an active goal");
			if (!validUsageDelta(command.delta)) return goalFailure("invalid_usage", "goal usage delta has a negative or non-integer amount");
			const usage = newUsage(state.usage, command.delta);
			const status = budgetExhausted(state.budget, usage) ? "budget_limited" as const : state.status;
			return nextState(
				state,
				{ usage, status, ...(status === "budget_limited" ? { pauseReason: "budget_exhausted" } : {}) },
				command.updatedAt,
			);
		}

		case "record_continuation":
			if (state.status !== "active") return goalFailure("illegal_transition", "continuations are only recorded for an active goal");
			return nextState(state, { continuations: state.continuations + 1, completion: undefined }, command.updatedAt);
	}
}

export function isGoalDigest(value: unknown): value is RuntimeDigest {
	return isRuntimeDigest(value);
}
