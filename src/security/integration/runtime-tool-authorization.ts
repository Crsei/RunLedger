/**
 * Runtime-owned tool admission gate.
 *
 * This gate deliberately does not duplicate filesystem/network/process policy.
 * It only accepts tool instances that belong to the governed runtime registry;
 * every effect is still authorized by the ExecutionGateway at its final leaf.
 * Keeping this distinction explicit prevents the old AllowAll policy from
 * becoming a production fallback while avoiding a second effect evaluator.
 */

import type {
	AgentTool,
	ToolAuthorizationDecision,
	ToolAuthorizationPolicy,
	ToolAuthorizationRequest,
} from "../../runtime/types.ts";
import { evaluatePlanModeCapabilities } from "../../runtime/modes/plan/policy.ts";
import type { PlanModeState } from "../../runtime/modes/plan/types.ts";

const GOVERNED_TOOL_NAMES = new Set([
	"read",
	"plan_read",
	"plan_write",
	"write",
	"edit",
	"MultiEdit",
	"bash",
	"grep",
	"find",
	"glob",
	"ls",
	"WebFetch",
	"Skill",
	"request_permissions",
	"NotebookEdit",
	"TodoWrite",
	"process_output",
	"process_wait",
	"write_stdin",
	"process_stop",
	"process_resize",
	"echo",
	"mcp_catalog",
	"mcp_search",
	"mcp_call",
	"lsp",
]);

export class GovernedToolAuthorizationPolicy implements ToolAuthorizationPolicy {
	readonly #planState: (() => PlanModeState | undefined) | undefined;
	readonly #basePolicy: ToolAuthorizationPolicy | undefined;
	readonly #planArtifactWriter: AgentTool | undefined;
	readonly #planProfileReadonly: boolean;

	public constructor(options: {
		readonly basePolicy?: ToolAuthorizationPolicy;
		readonly planState?: () => PlanModeState | undefined;
		readonly planArtifactWriter?: AgentTool;
		readonly planProfileReadonly?: boolean;
	} = {}) {
		this.#basePolicy = options.basePolicy;
		this.#planState = options.planState;
		this.#planArtifactWriter = options.planArtifactWriter;
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
		if (!GOVERNED_TOOL_NAMES.has(request.tool.name)) {
			return { decision: "deny", reason: `tool ${request.tool.name} is not admitted by the governed composition` };
		}
		if (this.#planState !== undefined || this.#planProfileReadonly) {
			const state = this.#planState?.();
			// 仅允许 composition 注入的同一工件 writer 实例；不按工具名赋予写权限。
			if (request.tool === this.#planArtifactWriter) {
				return state?.status === "active" ? { decision: "allow" } : { decision: "deny", reason: "plan artifact is not editable in the current state" };
			}
			const planDecision = evaluatePlanModeCapabilities({ state, claims: request.tool.capabilityClaims ?? [], enforceReadonly: this.#planProfileReadonly });
			if (planDecision.decision === "deny") return { decision: "deny", reason: `${planDecision.reasonCode} at mode revision ${planDecision.modeRevision}` };
		}
		return { decision: "allow" };
	}
}

/** legacy Host 组合在 R9 删除前使用的兼容值别名。 */
export { GovernedToolAuthorizationPolicy as HostGovernedToolAuthorizationPolicy };

function isPromise(value: ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>): value is Promise<ToolAuthorizationDecision> {
	return typeof (value as { then?: unknown }).then === "function";
}
