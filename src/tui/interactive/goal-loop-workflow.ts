/**
 * `/goal` 与 `/loop` 的 TUI 工作流。
 *
 * 两者都只经 Session Owner 的 command/query：
 * - `/goal set|pause|resume|complete|drop|set-budget` → `goal.*` mutation；
 * - `/loop <limit> [--while|--until 'cmd'] <prompt>` → `loop.start`（owner 侧驱动首轮与后续迭代）；
 * - `/loop stop` → `loop.stop`。
 *
 * TUI 不持有 loop/goal 状态，也不自行安排迭代节奏（D1/D3）。
 */

import { commandSessionController, querySessionController } from "../adapters/session-domain.ts";
import { parseLoopArgs } from "../../runtime/loop/limit.ts";
import type { InteractiveModePorts } from "./types.ts";

const GOAL_USAGE = "Usage: /goal [set <objective> | pause | resume | complete | reject | drop | set-budget <tokens>]";
const LOOP_USAGE = "Usage: /loop [count|duration] [--while|--until '<command>'] [prompt]  ·  /loop stop";

export class GoalLoopWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** 观察面的窄投影：footer 徽标与 timeline 生命周期行共用同一次 inspect。 */
	public async inspectGoalBadge(): Promise<{
		readonly badge: { readonly status: string; readonly tokensUsed: number; readonly accountingCompleteness: "complete" | "partial"; readonly continuations: number };
		readonly lifecycle?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
		readonly goalId?: string;
	} | undefined> {
		const port = this.port;
		if (port.controller?.supports?.("goal.inspect") !== true) return undefined;
		const result = await querySessionController(port.controller, "goal.inspect", {}, {
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`,
		});
		if (!result.ok) return undefined;
		const state = result.value.state as {
			readonly goalId?: string;
			readonly status: string;
			readonly usage: { readonly tokensUsed: number; readonly accountingCompleteness: "complete" | "partial" };
			readonly continuations: number;
		} | undefined;
		if (state === undefined) return undefined;
		return {
			badge: {
				status: state.status,
				tokensUsed: state.usage.tokensUsed,
				accountingCompleteness: state.usage.accountingCompleteness,
				continuations: state.continuations,
			},
			...(state.goalId === undefined ? {} : { goalId: state.goalId }),
			...(goalLifecycleStatus(state.status) === undefined ? {} : { lifecycle: goalLifecycleStatus(state.status)! }),
		};
	}

	/** `/goal`：无参数时展示当前目标；带参数时按显式动作变更。 */
	public async runGoal(arg: string): Promise<void> {
		const port = this.port;
		if (port.controller?.supports?.("goal.inspect") !== true) {
			port.showNotice("/goal requires a standard session with goal mode enabled.", "error");
			return;
		}
		const parts = arg.trim().split(/\s+/u).filter(Boolean);
		const action = parts[0];
		const inspection = await querySessionController(port.controller, "goal.inspect", {}, {
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`,
		}).catch(() => undefined);
		if (inspection?.ok !== true) {
			port.showNotice("Goal state is unavailable in this Session.", "error");
			return;
		}
		const state = inspection.value.state as {
			readonly status: string;
			readonly revision: number;
			readonly objective?: string;
			readonly continuations?: number;
			readonly completion?: { readonly requestedBy: string };
			readonly usage?: { readonly tokensUsed: number; readonly accountingCompleteness: string };
		};
		if (action === undefined) {
			port.showNotice(describeGoal(state), "note");
			return;
		}
		const revision = state.revision;
		const request = (): { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number } => ({
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: revision,
		});
		switch (action) {
			case "set": {
				const objective = parts.slice(1).join(" ").trim();
				if (objective.length === 0) { port.showNotice(GOAL_USAGE, "error"); return; }
				await this.finish("goal.set", { objective, setBy: "user" }, request(), "Goal created.");
				return;
			}
			case "pause":
				await this.finish("goal.pause", { reason: "user_requested" }, request(), "Goal paused.");
				return;
			case "resume":
				await this.finish("goal.resume", {}, request(), "Goal resumed.");
				return;
			case "complete": {
				// 用户是唯一的结算方，也是唯一的权威：一次 `/goal complete` 就登记并结算。
				// 模型只能登记请求（`goal({op:"complete"})`），不能自我结算。
				if (state.completion === undefined) {
					const requested = await commandSessionController(port.controller, "goal.request_complete", { requestedBy: "user" }, request());
					if (!requested.ok) {
						port.showNotice(goalFailureMessage("goal.request_complete", requested.code), "error");
						return;
					}
				}
				// 结算必须用登记后的 revision。
				const settledRevision = await this.currentRevision();
				if (settledRevision === undefined) {
					port.showNotice("Goal state is unavailable in this Session.", "error");
					return;
				}
				await this.finish("goal.settle_complete", { decision: "approved" }, {
					correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: settledRevision,
				}, "Goal settled as complete.");
				return;
			}
			case "reject":
				if (state.completion === undefined) {
					port.showNotice("No completion request is pending.", "error");
					return;
				}
				await this.finish("goal.settle_complete", { decision: "rejected" }, request(), "Completion request rejected; goal stays active.");
				return;
			case "drop":
				await this.finish("goal.drop", {}, request(), "Goal dropped.");
				return;
			case "set-budget": {
				const tokens = Number(parts[1]);
				if (!Number.isSafeInteger(tokens) || tokens < 0) { port.showNotice(`${GOAL_USAGE}\nset-budget needs a non-negative token count.`, "error"); return; }
				await this.finish("goal.set_budget", { budget: { tokenBudget: tokens } }, request(), `Token budget set to ${tokens}.`);
				return;
			}
			default:
				port.showNotice(GOAL_USAGE, "error");
		}
	}

	/** `/loop`：`stop` 结束当前 loop；其余参数交给 `parseLoopArgs` 解析后启动。 */
	public async runLoop(arg: string): Promise<void> {
		const port = this.port;
		if (port.controller?.supports?.("loop.start") !== true) {
			port.showNotice("/loop requires a standard session with loop mode enabled.", "error");
			return;
		}
		const trimmed = arg.trim();
		if (trimmed === "stop") {
			const stopped = await commandSessionController(port.controller, "loop.stop", { reasonCode: "user_requested" }, {
				correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: 0,
			});
			port.showNotice(stopped.ok ? "Loop stopped." : "No loop is running.", stopped.ok ? "note" : "error");
			return;
		}
		const parsed = parseLoopArgs(trimmed);
		if (typeof parsed === "string") {
			port.showNotice(parsed, "error");
			return;
		}
		if (parsed.prompt === undefined || parsed.prompt.trim().length === 0) {
			port.showNotice(`${LOOP_USAGE}\nA prompt is required so the Runtime knows what to repeat.`, "error");
			return;
		}
		const result = await commandSessionController(port.controller, "loop.start", {
			prompt: parsed.prompt,
			action: "prompt",
			...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
			...(parsed.condition === undefined ? {} : { condition: parsed.condition }),
		}, { correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: 0 });
		if (!result.ok) {
			port.showNotice(loopFailureMessage(result.code), "error");
			return;
		}
		const loop = result.value.loop as { readonly limit?: string } | undefined;
		port.showNotice(`Loop started${loop?.limit === undefined ? "." : ` (${loop.limit}).`}`, "note");
	}

	/** 结算前的 revision 必须重新读取：上一步（登记）已推进 revision。 */
	private async currentRevision(): Promise<number | undefined> {
		const inspection = await querySessionController(this.port.controller, "goal.inspect", {}, {
			correlationId: `corr-${this.port.nextCorrelationId()}`, effectId: `effect-${this.port.nextEffectId()}`,
		}).catch(() => undefined);
		if (inspection?.ok !== true) return undefined;
		const state = inspection.value.state as { readonly revision?: number } | undefined;
		return state?.revision;
	}

	private async finish(operation: string, body: Record<string, unknown>, context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number }, message: string): Promise<void> {
		const result = await commandSessionController(this.port.controller, operation, body, context);
		if (!result.ok) {
			this.port.showNotice(goalFailureMessage(operation, result.code), "error");
			return;
		}
		this.port.noteGoalChanged?.();
		this.port.showNotice(message, "note");
	}
}

function describeGoal(state: { readonly status: string; readonly revision: number; readonly objective?: string; readonly continuations?: number; readonly usage?: { readonly tokensUsed: number; readonly accountingCompleteness: string } }): string {
	if (state.status === "inactive") return "No goal is set. Use /goal set <objective>.";
	const bound = state.usage?.accountingCompleteness === "partial" ? " (observed lower bound)" : "";
	return [
		`Goal (${state.status}, revision ${state.revision}): ${state.objective ?? "(no objective)"}`,
		`tokens: ${state.usage?.tokensUsed ?? 0}${bound}; continuations: ${state.continuations ?? 0}`,
	].join("\n");
}

function goalFailureMessage(operation: string, code: string): string {
	switch (code) {
		case "stale_expected_revision":
		case "domain_revision_conflict":
			return "The goal changed while you were acting; run /goal again to see the current state.";
		case "illegal_transition":
			return "That goal action is not allowed in the current state.";
		case "invalid_budget":
			return "Raise the goal budget before resuming an exhausted goal.";
		case "completion_not_requested":
			return "Request completion before settling it.";
		default:
			return `${operation} failed: ${code}`;
	}
}

function loopFailureMessage(code: string): string {
	switch (code) {
		case "loop_disabled":
			return "Loop mode is disabled in settings.";
		case "loop_already_running":
			return "A loop is already running; use /loop stop first.";
		case "loop_condition_disabled":
			return "Loop conditions are disabled in settings.";
		case "loop_reset_requires_client":
			return "/loop cannot reset the session from the Runtime; start a new session instead.";
		case "session_busy":
			return "The Session is busy; wait for the current turn to finish.";
		default:
			return `loop.start failed: ${code}`;
	}
}

/** canonical goal 状态 -> timeline 行状态；inactive 不产生行。 */
function goalLifecycleStatus(status: string): "pending" | "running" | "succeeded" | "failed" | "cancelled" | undefined {
	switch (status) {
		case "active": return "running";
		case "paused":
		case "budget_limited": return "pending";
		case "complete": return "succeeded";
		case "dropped": return "cancelled";
		default: return undefined;
	}
}
