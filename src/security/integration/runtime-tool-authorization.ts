/**
 * Host-owned tool admission gate.
 *
 * This gate deliberately does not duplicate filesystem/network/process policy.
 * It only accepts tool instances that belong to the Host-composed registry;
 * every effect is still authorized by the ExecutionGateway at its final leaf.
 * Keeping this distinction explicit prevents the old AllowAll policy from
 * becoming a production fallback while avoiding a second effect evaluator.
 */

import type {
	ToolAuthorizationDecision,
	ToolAuthorizationPolicy,
	ToolAuthorizationRequest,
} from "../../runtime/types.ts";
import { evaluatePlanModeCapabilities } from "../../runtime/modes/plan/policy.ts";
import type { PlanModeState } from "../../runtime/modes/plan/types.ts";

const HOST_GOVERNED_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"MultiEdit",
	"bash",
	"grep",
	"find",
	"glob",
	"ls",
	"WebFetch",
	"skill",
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
]);

export class HostGovernedToolAuthorizationPolicy implements ToolAuthorizationPolicy {
	readonly #planState: (() => PlanModeState | undefined) | undefined;
	readonly #basePolicy: ToolAuthorizationPolicy | undefined;

	public constructor(options: {
		readonly basePolicy?: ToolAuthorizationPolicy;
		readonly planState?: () => PlanModeState | undefined;
	} = {}) {
		this.#basePolicy = options.basePolicy;
		this.#planState = options.planState;
	}

	public authorize(request: ToolAuthorizationRequest, signal?: AbortSignal): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
		const baseDecision = this.#basePolicy?.authorize(request, signal);
		if (baseDecision !== undefined && isPromise(baseDecision)) {
			return baseDecision.then((decision) => this.applyHostCeiling(request, decision));
		}
		return this.applyHostCeiling(request, baseDecision);
	}

	private applyHostCeiling(request: ToolAuthorizationRequest, baseDecision: ToolAuthorizationDecision | undefined): ToolAuthorizationDecision {
		if (baseDecision?.decision === "deny") return baseDecision;
		if (request.tool === undefined) return { decision: "deny", reason: "tool is not present in the Host registry" };
		if (!HOST_GOVERNED_TOOL_NAMES.has(request.tool.name)) {
			return { decision: "deny", reason: `tool ${request.tool.name} is not admitted by the Host composition` };
		}
		if (this.#planState !== undefined) {
			const planDecision = evaluatePlanModeCapabilities({ state: this.#planState(), claims: request.tool.capabilityClaims ?? [] });
			if (planDecision.decision === "deny") return { decision: "deny", reason: `${planDecision.reasonCode} at mode revision ${planDecision.modeRevision}` };
		}
		return { decision: "allow" };
	}
}

function isPromise(value: ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>): value is Promise<ToolAuthorizationDecision> {
	return typeof (value as { then?: unknown }).then === "function";
}
