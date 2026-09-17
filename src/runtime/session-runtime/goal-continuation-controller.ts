/**
 * Owner 侧 Goal 自动续跑调度（D9）。
 *
 * 与 omp 的差别：续跑不是 TUI 定时器，而是 owner 在 `agent_end` 之后按可配置 idle
 * 窗口触发的受治理动作；headless 与多客户端下行为一致。门禁与 idle recap 同款
 * （driver 在位、owner ready、无在飞请求、队列为空、编辑器为空），并且必须与既有
 * run budget 协调：任一 run budget 终止后不再续跑，并保持目标为 paused/不变。
 */

import type { SessionGoalInspection } from "./goal-composition.ts";
import type { GoalUsageDelta } from "../modes/goal/reducer.ts";
import type { AgentEvent, UserAgentMessage } from "../types.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";
import type { SessionControllerEvent, SessionRuntimeServer } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier } from "./recovery-barrier.ts";
import type { EffectiveGoalSettings } from "../../storage/settings-manager.ts";

/**
 * owner 侧 goal authority 的窄端口。与 idle recap 的 `runEphemeralTurn` 同款：
 * controller 不持有具体 domain 类，只依赖它需要的动作，便于单测给假实现。
 */
export interface SessionGoalRuntimePort {
	readonly subscribeChanged?: (listener: () => void) => () => void;
	readonly inspect: () => SessionGoalInspection;
	readonly controlRevision: () => number;
	readonly pauseAfterRunBudget: (controlRevision: number, reason: string, runId: string) => Promise<boolean>;
	readonly accountUsage: (delta: GoalUsageDelta) => Promise<boolean>;
	readonly recordContinuation: () => Promise<boolean>;
	readonly recordSuppression: (reasonCode: string) => boolean;
	readonly markContinuationTurn: () => void;
	readonly clearContinuationTurn: () => void;
}

export interface SessionGoalContinuationPort {
	readonly domain: SessionDomainPort | undefined;
	readonly goal: SessionGoalRuntimePort | undefined;
	readonly sessionId: string;
	readonly fence: OwnerFence;
	readonly barrier: RecoveryBarrier;
	readonly server: SessionRuntimeServer;
	readonly state: () => SessionRuntimeState;
	readonly emit: (event: SessionControllerEvent) => void;
	readonly settings: EffectiveGoalSettings;
	/** 有 loop 正在运行时跳过续跑：两者叠加会让预算与审计不可解释（D9）。 */
	readonly loopRunning: () => boolean;
}

/** 续跑触发消息是 runtime-origin user message：进 history，但不是用户真实输入。 */
export const GOAL_CONTINUATION_PROMPT = "Continue the active goal.";

export type GoalContinuationSkipReason =
	| "disabled"
	| "loop_active"
	| "no_goal"
	| "goal_not_active"
	| "not_idle"
	| "run_budget_terminated"
	| "max_continuations"
	| "no_tool_calls"
	| "completion_pending"
	| "editor_not_empty"
	| "queues_not_empty"
	| "driver_absent"
	| "owner_not_ready";

export interface GoalContinuationDecision {
	readonly continue: boolean;
	/** 抑制原因；continue 为 true 时为 undefined。 */
	readonly reason?: GoalContinuationSkipReason;
}

export interface GoalContinuationInput {
	readonly settings: EffectiveGoalSettings;
	/** 是否有 loop 正在运行（不是「loop 是否在 settings 中启用」）。 */
	readonly loopRunning: boolean;
	readonly state: SessionGoalInspection["state"] | undefined;
	readonly idle: boolean;
	readonly runBudgetTerminated: boolean;
	/** 上一续跑轮是否产生过工具调用；false 表示空转，必须抑制下一次（omp 同款）。 */
	readonly lastRunHadToolCalls: boolean;
	readonly editorEmpty: boolean;
	readonly queuesEmpty: boolean;
	readonly driverAttached: boolean;
	readonly ownerReady: boolean;
}

/** 纯判定：只看已解析输入，不含计时器与 I/O，便于覆盖抑制矩阵。 */
export function decideGoalContinuation(input: GoalContinuationInput): GoalContinuationDecision {
	if (!input.settings.enabled) return { continue: false, reason: "disabled" };
	if (!input.settings.autoContinuation) return { continue: false, reason: "disabled" };
	if (input.loopRunning) return { continue: false, reason: "loop_active" };
	if (input.state === undefined || input.state.status === "inactive") return { continue: false, reason: "no_goal" };
	if (input.state.status !== "active") return { continue: false, reason: "goal_not_active" };
	if (!input.ownerReady) return { continue: false, reason: "owner_not_ready" };
	if (input.runBudgetTerminated) return { continue: false, reason: "run_budget_terminated" };
	if (input.state.continuations >= input.settings.maxContinuations) return { continue: false, reason: "max_continuations" };
	// 模型已断言完成、等待用户结算时不再续跑：继续花预算不会改变结算结果。
	if (input.state.completion !== undefined) return { continue: false, reason: "completion_pending" };
	if (!input.lastRunHadToolCalls) return { continue: false, reason: "no_tool_calls" };
	if (!input.driverAttached) return { continue: false, reason: "driver_absent" };
	if (!input.editorEmpty) return { continue: false, reason: "editor_not_empty" };
	if (!input.queuesEmpty) return { continue: false, reason: "queues_not_empty" };
	if (!input.idle) return { continue: false, reason: "not_idle" };
	return { continue: true };
}

/**
 * 从 assistant 消息的 provider usage 计算一次记账增量。
 * usage 缺失即 tokensUnknown（D6：不得把未知当 0）。
 */
export function goalUsageDeltaFrom(event: AgentEvent): GoalUsageDelta | undefined {
	if (event.type !== "message_end" || event.role !== "assistant") return undefined;
	const message = event.message;
	const usage = message !== undefined && message.role === "assistant" ? message.usage : undefined;
	if (usage === undefined) return { tokensUnknown: true };
	// D6 口径：input + cacheWrite + output；cacheRead 是复用前缀，不计费。
	return { inputTokens: usage.input, cacheWriteTokens: usage.cacheWrite, outputTokens: usage.output };
}

/** 续跑触发消息：runtime-origin，模型必须看到自己在被续跑。 */
export function goalContinuationMessage(): UserAgentMessage {
	return { role: "user", origin: "runtime", content: [{ type: "text", text: GOAL_CONTINUATION_PROMPT }] };
}

/**
 * 续跑调度器：计时器（可重排/取消）与判定（纯函数）分离。
 * 计时器一律 unref，触发时重新快照全部条件（对照 IdleRecapCoordinator）。
 */
export class SessionGoalContinuationController {
	private readonly port: SessionGoalContinuationPort;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private editorEmpty = true;
	/** 上一轮 run 是否产生工具调用；首次判定前为 true，避免误抑制合法续跑。 */
	private lastRunHadToolCalls = true;
	private runHadToolCalls = false;
	private currentRunIsContinuation = false;
	private generation = 0;
	private runControlRevision: number | undefined;
	private budgetStoppedRevision: number | undefined;
	private runSequence = 0;

	public constructor(port: SessionGoalContinuationPort) {
		this.port = port;
	}

	public handleDomainAgentEvent(event: AgentEvent): void {
		if (event.type === "agent_start") {
			this.runSequence += 1;
			this.runControlRevision = this.port.goal?.inspect().state.status === "active" ? this.port.goal.controlRevision() : undefined;
			// 空转判定是「本轮 run 有没有产生过工具调用」，不是「最后一个 turn 有没有」：
			// 只调工具的 run 末轮通常没有工具调用，按 turn 重置会误判为空转。
			this.runHadToolCalls = false;
			this.cancelPending();
			return;
		}
		if (event.type === "turn_start") return;
		if (event.type === "message_end") {
			void this.accountMessageUsage(event);
			return;
		}
		if (event.type === "tool_execution_end") {
			// 允许首轮内新建目标；已有目标被替换时仍保留旧 run 的绑定。
			if (this.runControlRevision === undefined && this.port.goal?.inspect().state.status === "active") {
				this.runControlRevision = this.port.goal.controlRevision();
			}
			this.runHadToolCalls = true;
			this.cancelPending();
			return;
		}
		if (event.type !== "agent_end") {
			if (event.type === "message_start") this.cancelPending();
			return;
		}
		// agent_end 在 agent.inFlight 仍为 true 时派发，用 macrotask 让生命周期先结算。
		if (this.currentRunIsContinuation) this.lastRunHadToolCalls = this.runHadToolCalls;
		this.currentRunIsContinuation = false;
		this.port.goal?.clearContinuationTurn();
		void this.accountActiveTime(event);
		const terminated = event.terminationReason !== undefined;
		if (terminated) {
			// run budget 终止后不再续跑，也不会凭续跑绕过预算（D9）。
			this.port.goal?.recordSuppression("run_budget_terminated");
			this.cancelPending();
			const revision = this.runControlRevision;
			if (revision !== undefined) {
				this.budgetStoppedRevision = revision;
				void this.pauseAfterBudget(revision, event.terminationReason!, event.runId ?? `run-${this.runSequence}`);
			}
			return;
		}
		this.cancelPending();
		if (this.disposed) return;
		const generation = this.generation;
		const delayMs = Math.max(1, Math.trunc(this.port.settings.continuationDelaySeconds)) * 1_000;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.fire(generation);
		}, delayMs);
		this.timer.unref?.();
	}

	public handleEditorActivity(empty: boolean): void {
		this.editorEmpty = empty;
		if (!empty) this.cancelPending();
	}

	public handleDriverStateChange(): void {
		this.cancelPending();
	}

	/** 用户显式 pause/drop/complete 后续跑失效：状态由判定重新读取，这里只取消计时器。 */
	public invalidate(): void {
		this.cancelPending();
	}

	public dispose(): void {
		this.disposed = true;
		this.cancelPending();
	}

	private cancelPending(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.generation += 1;
	}

	private async fire(generation: number): Promise<void> {
		if (this.disposed || generation !== this.generation) return;
		const snapshot = this.port.domain?.snapshot();
		const ownerState = this.port.state();
		const decision = decideGoalContinuation({
			settings: this.port.settings,
			loopRunning: this.port.loopRunning(),
			state: this.port.goal?.inspect().state,
			idle: !(snapshot?.inFlight ?? true),
			runBudgetTerminated: this.budgetStoppedRevision !== undefined && this.budgetStoppedRevision === this.port.goal?.controlRevision(),
			lastRunHadToolCalls: this.lastRunHadToolCalls,
			editorEmpty: this.editorEmpty,
			queuesEmpty: this.queuesEmpty(),
			driverAttached: this.port.server.driverConnectionId?.() !== undefined,
			ownerReady: ownerState === "ready" || ownerState === "ready_with_uncertainty",
		});
		if (!decision.continue) {
			// 抑制必须可解释：除「本来就没有目标」外一律落审计，否则「为什么没续跑」无法回答。
			if (decision.reason !== undefined && decision.reason !== "no_goal") {
				this.port.goal?.recordSuppression(decision.reason);
			}
			return;
		}
		// 必须保留接收者：controller.prompt 读取实例状态，解构后会丢 this。
		const controller = this.port.domain?.controller;
		if (controller?.prompt === undefined) return;
		if (this.port.barrier.currentState === "open") {
			this.port.goal?.recordSuppression("owner_not_ready");
			return;
		}
		const admission = this.port.barrier.admitPrompt();
		if (!admission.ok) {
			this.port.goal?.recordSuppression("owner_not_ready");
			return;
		}
		if ((await this.port.goal?.recordContinuation()) !== true) return;
		this.port.goal?.markContinuationTurn();
		this.currentRunIsContinuation = true;
		this.port.emit({ eventType: "turn.started", payload: { promptText: GOAL_CONTINUATION_PROMPT, origin: "runtime" } });
		try {
			// 同上：必须等上一轮 run 真正结束，否则续跑消息会落进无人消费的 steering 队列。
			await controller.waitForIdle();
			await controller.prompt(GOAL_CONTINUATION_PROMPT, undefined, "runtime");
		} catch {
			// 续跑启动失败不改 canonical 状态；下一次 agent_end 会重新判定。
			this.currentRunIsContinuation = false;
			this.port.goal?.clearContinuationTurn();
		}
	}

	private queuesEmpty(): boolean {
		return (this.port.domain?.controller.getSteeringMessages().length ?? 0) === 0
			&& (this.port.domain?.controller.getFollowUpMessages().length ?? 0) === 0;
	}

	private async pauseAfterBudget(revision: number, reason: string, runId: string): Promise<void> {
		const paused = await this.port.goal?.pauseAfterRunBudget(revision, reason, runId).catch(() => false);
		if (paused !== true) {
			this.port.emit({ eventType: "session.goal_notice", payload: {
				message: `Goal auto-continuation stopped (${reason}), but saving the paused state failed. Pause the goal explicitly before resuming.`,
			} });
		}
	}

	private async accountActiveTime(event: AgentEvent): Promise<void> {
		const goal = this.port.goal;
		if (goal === undefined) return;
		if (goal.inspect().state.status !== "active") return;
		if (event.type !== "agent_end") return;
		// 活跃时长只在确实消耗过时记账，避免零值转移刷 revision。
		const activeDurationMs = event.activeDurationMs ?? 0;
		if (activeDurationMs <= 0) return;
		await goal.accountUsage({ activeDurationMs });
	}

	private async accountMessageUsage(event: AgentEvent): Promise<void> {
		const goal = this.port.goal;
		if (goal === undefined) return;
		if (goal.inspect().state.status !== "active") return;
		const delta = goalUsageDeltaFrom(event);
		if (delta === undefined) return;
		await goal.accountUsage(delta);
	}
}
