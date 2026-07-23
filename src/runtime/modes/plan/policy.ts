import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { CapabilityDecision } from "../../protocol/v3/capability.ts";
import type { RuntimeToolDescriptor } from "../../resources/types.ts";
import type { PlanModeState } from "./types.ts";

export interface PlanModeCapabilityConstraint {
	ceiling: CapabilityDecision;
	reason: string;
	modeRevision: number;
	matchedCapabilityDigests: readonly string[];
}

const DECISION_ORDER: Readonly<Record<CapabilityDecision, number>> = { allow: 0, ask: 1, deny: 2 };

export function mergeCapabilityCeilings(decisions: readonly CapabilityDecision[]): CapabilityDecision {
	return decisions.reduce<CapabilityDecision>((current, candidate) =>
		DECISION_ORDER[candidate] > DECISION_ORDER[current] ? candidate : current,
	"allow");
}

/** Plan policy 只产 ceiling；真实 Gateway 继续合并 managed/workspace/session policy。 */
export function constrainToolForPlanMode(
	state: PlanModeState,
	descriptor: RuntimeToolDescriptor,
	options: { isCurrentPlanWriter?: boolean } = {},
): PlanModeCapabilityConstraint {
	if (state.mode !== "plan") {
		return { ceiling: "allow", reason: "session is not in plan mode", modeRevision: state.modeRevision, matchedCapabilityDigests: [] };
	}
	const digests = descriptor.capabilities.map((item) => canonicalDigest(item)).sort();
	if (options.isCurrentPlanWriter === true) {
		return { ceiling: "allow", reason: "runtime-bound current plan writer", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	if (descriptor.trust !== "trusted" || descriptor.activation !== "ready") {
		return { ceiling: "deny", reason: "untrusted, stale, revoked, or inactive tools are denied in plan mode", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	if (descriptor.identity.kind === "mcp-tool" && descriptor.capabilities.length === 0) {
		return { ceiling: "deny", reason: "MCP tools without exact capability declarations are denied in plan mode", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	if (descriptor.capabilities.length === 0 && descriptor.risk.sideEffect !== "none" && descriptor.risk.sideEffect !== "read") {
		return { ceiling: "deny", reason: "unknown or undeclared side effect is denied in plan mode", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	const names = new Set(descriptor.capabilities.map((item) => item.claim.name));
	if (
		descriptor.risk.sideEffect === "write" || descriptor.risk.sideEffect === "privileged" ||
		names.has("workspace_write") || names.has("process") || names.has("credential") ||
		names.has("dependency_install") || names.has("deploy")
	) return { ceiling: "deny", reason: "plan mode denies workspace mutation, process, credential, and privileged effects", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	if (descriptor.risk.sideEffect === "external" || names.has("network") || names.has("browser")) {
		return { ceiling: "ask", reason: "external reads require an explicit gateway decision", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	if (!descriptor.execution.readOnly) {
		return { ceiling: "deny", reason: "tool is not structurally declared read-only", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
	}
	return { ceiling: "allow", reason: "declared read-only tool remains subject to stricter gateway policy", modeRevision: state.modeRevision, matchedCapabilityDigests: digests };
}
