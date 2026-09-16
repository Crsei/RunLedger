/**
 * Goal Mode 的被动公共状态合同。
 *
 * 这是会话级自主目标的 canonical 状态（照 PlanModeState 先例）：`status` 是唯一
 * 生命周期真源，`usage` 是模型用量的**已观测下界**，预算耗尽只在完整度确证时成立。
 */

import type { RuntimeDigest, RuntimeStreamHead } from "../../protocol/foundation.ts";
import type { GoalId, SessionId } from "../../protocol/ids.ts";

/**
 * 生命周期：`inactive` 表示会话存在但未设置目标；`complete`/`dropped` 是终态。
 * `budget_limited` 只在下界确证（完整度 complete）时进入，见 accountingCompleteness。
 */
export type GoalStatus = "inactive" | "active" | "paused" | "budget_limited" | "complete" | "dropped";

/** 用量计量完整度：`partial` 表示存在不可知轮次，tokenBudget 判定不得据此推进。 */
export type GoalAccountingCompleteness = "complete" | "partial";

/** 目标的模型用量记账累计；tokensUsed 是已观测下界，不是精确值。 */
export interface GoalUsage {
	/** input + cacheWrite + output；排除 cacheRead（复用前缀不计费）。 */
	readonly tokensUsed: number;
	readonly inputTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	/** 活跃时长（agent_work_pause/resume 之间），不含审批等待与用户离开。 */
	readonly activeDurationMs: number;
	readonly accountingCompleteness: GoalAccountingCompleteness;
	/** 用量不可知的轮次计数；>0 即 accountingCompleteness 为 partial。 */
	readonly unaccountedTurns: number;
}

export interface GoalBudget {
	readonly tokenBudget?: number;
	readonly timeBudgetMs?: number;
}

/** 模型请求完成但尚未结算：目标完成是断言，模型不能自我结算（照 plan 审批纪律）。 */
export interface GoalCompletionRequest {
	readonly requestedAt: string;
	readonly requestedBy: "agent" | "user";
}

/** 目标正文的单目标字节上限；超限以 typed 失败拒绝，不截断。 */
export const GOAL_OBJECTIVE_MAX_BYTES = 4_096;

export interface GoalModeState {
	readonly status: GoalStatus;
	readonly sessionId: SessionId;
	readonly goalId: GoalId;
	readonly revision: number;
	readonly objective?: string;
	readonly objectiveDigest?: RuntimeDigest;
	readonly budget: GoalBudget;
	readonly usage: GoalUsage;
	/** 已经发生的自动续跑次数；上限由 settings.goal.maxContinuations 控制（D9）。 */
	readonly continuations: number;
	readonly completion?: GoalCompletionRequest;
	/** 最近一次离开 active 的原因码；仅用于呈现与审计，不参与转移判定。 */
	readonly pauseReason?: string;
	readonly completedAt?: string;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly sourceHead: RuntimeStreamHead;
	readonly projectionDigest: RuntimeDigest;
	/** 投影完整度；canonical 重放产出的状态恒为 complete。 */
	readonly completeness: "complete" | "partial";
	readonly updatedAt: string;
}

/** 无目标时的零用量基线；预算判定与片段渲染共用，避免各自造默认值。 */
export const EMPTY_GOAL_USAGE: GoalUsage = Object.freeze({
	tokensUsed: 0,
	inputTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	activeDurationMs: 0,
	accountingCompleteness: "complete",
	unaccountedTurns: 0,
});

export const EMPTY_GOAL_BUDGET: GoalBudget = Object.freeze({});
