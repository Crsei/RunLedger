/**
 * Runtime-owned tool admission gate.
 *
 * 该门禁不复制 filesystem/network/process 策略,只回答一个问题:
 * **这个工具实例是否属于本 Session 组合出的工具集**。每个 effect 仍在
 * ExecutionGateway 最终叶重新授权,避免出现第二个 effect evaluator。
 *
 * admission 依据是 composition 注入的工具实例(对象身份),不是工具名。
 * 历史实现使用静态名字集合,与本仓库的 registration 重复且会静默过期:
 * 组合进 Session 的 `spawn_agent` 从未进入该集合,导致每次调用都被拒。
 * 名字名单越"全"越危险 —— 组合点变化时名单不会跟着变,而拒绝是静默的。
 *
 * 未注入 `admittedTools` 时本策略不做 admission(只保留 Plan Mode 判定)。
 * 需要门禁的调用方必须注入自己组合出的工具集,并由 Session/Host composition
 * 负责在工具集最终确定后(receipt 落盘前)完成注入。
 */

import type {
	AgentTool,
	ToolAuthorizationDecision,
	ToolAuthorizationPolicy,
	ToolAuthorizationRequest,
} from "../../runtime/types.ts";
import { evaluatePlanModeCapabilities } from "../../runtime/modes/plan/policy.ts";
import type { PlanModeState } from "../../runtime/modes/plan/types.ts";
import type { PlanArtifactWriteGate as PlanArtifactWriteTool } from "../../runtime/session-runtime/plan-tools.ts";

export interface GovernedToolAuthorizationPolicyOptions {
	readonly basePolicy?: ToolAuthorizationPolicy;
	/**
	 * 本 Session 实际组合出的工具实例(对象身份基准);缺省 = 不做 admission。
	 * 必须是 **当前有效** 集合:`composition` 会先创建 controller 再
	 * `controller.addTools(...)` 追加 Session-owned 工具,所以调用方通常传
	 * thunk 而不是构造期快照。
	 */
	readonly admittedTools?: () => readonly AgentTool[];
	/** composition 注入的 plan 工件工具实例与状态约束;按对象身份判定,不看工具名。 */
	readonly planState?: () => PlanModeState | undefined;
	readonly planArtifactWriteTools?: readonly PlanArtifactWriteTool[];
	readonly planProfileReadonly?: boolean;
}

export class GovernedToolAuthorizationPolicy implements ToolAuthorizationPolicy {
	readonly #planState: (() => PlanModeState | undefined) | undefined;
	readonly #basePolicy: ToolAuthorizationPolicy | undefined;
	readonly #admittedTools: (() => readonly AgentTool[]) | undefined;
	readonly #planArtifactWriteTools: readonly PlanArtifactWriteTool[];
	readonly #planProfileReadonly: boolean;

	public constructor(options: GovernedToolAuthorizationPolicyOptions = {}) {
		this.#basePolicy = options.basePolicy;
		this.#admittedTools = options.admittedTools;
		this.#planState = options.planState;
		this.#planArtifactWriteTools = options.planArtifactWriteTools ?? [];
		this.#planProfileReadonly = options.planProfileReadonly === true;
	}

	public authorize(request: ToolAuthorizationRequest, signal?: AbortSignal): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
		const baseDecision = this.#basePolicy?.authorize(request, signal);
		if (baseDecision !== undefined && isPromise(baseDecision)) {
			return baseDecision.then((decision) => this.applyGovernedCeiling(request, decision));
		}
		return this.applyGovernedCeiling(request, baseDecision);
	}

	private applyGovernedCeiling(request: ToolAuthorizationRequest, baseDecision: ToolAuthorizationDecision | undefined): ToolAuthorizationDecision {
		if (baseDecision?.decision === "deny") return baseDecision;
		if (request.tool === undefined) return { decision: "deny", reason: "tool is not present in the governed registry" };
		if (this.#admittedTools !== undefined && !this.#admittedTools().includes(request.tool)) {
			return { decision: "deny", reason: `tool ${request.tool.name} is not admitted by the governed composition` };
		}
		const state = this.#planState?.();
		if (state !== undefined || this.#planProfileReadonly) {
			// 仅允许 composition 注入的 plan 工件工具实例；不按工具名赋予写权限。
			const gate = this.#planArtifactWriteTools.find((candidate) => candidate.tool === request.tool);
			if (gate !== undefined) {
				return gate.allows(state?.status ?? "inactive")
					? { decision: "allow" }
					: { decision: "deny", reason: `plan tool ${request.tool.name} is not available in the current state` };
			}
			const planDecision = evaluatePlanModeCapabilities({ state, claims: request.tool.capabilityClaims ?? [], enforceReadonly: this.#planProfileReadonly });
			if (planDecision.decision === "deny") {
				return { decision: "deny", reason: `${planDecision.reasonCode} at mode revision ${planDecision.modeRevision}` };
			}
		}
		return { decision: "allow" };
	}
}

/** legacy Host 组合在 Runtime 06 移除前使用的兼容值别名。 */
export { GovernedToolAuthorizationPolicy as HostGovernedToolAuthorizationPolicy };

function isPromise(value: ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>): value is Promise<ToolAuthorizationDecision> {
	return typeof (value as { then?: unknown }).then === "function";
}
