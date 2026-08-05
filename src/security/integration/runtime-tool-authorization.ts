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
]);

export class HostGovernedToolAuthorizationPolicy implements ToolAuthorizationPolicy {
	public authorize(request: ToolAuthorizationRequest, _signal?: AbortSignal): ToolAuthorizationDecision {
		if (request.tool === undefined) return { decision: "deny", reason: "tool is not present in the Host registry" };
		if (!HOST_GOVERNED_TOOL_NAMES.has(request.tool.name)) {
			return { decision: "deny", reason: `tool ${request.tool.name} is not admitted by the Host composition` };
		}
		return { decision: "allow" };
	}
}
