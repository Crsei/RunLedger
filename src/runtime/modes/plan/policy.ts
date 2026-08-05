/** Plan Mode capability adapter.
 *
 * The adapter consumes Runtime capability claims rather than tool names.  A
 * missing claim is an unknown effect and therefore cannot be admitted while
 * Plan Mode is active.  The ExecutionGateway remains the final effect owner;
 * this is the mode-specific deny boundary that runs before a tool executes.
 */

import type { CapabilityClaim } from "../../protocol/capability.ts";
import type { PlanModeState } from "./types.ts";

export interface PlanModeCapabilityRequest {
	readonly state: PlanModeState | undefined;
	readonly claims: readonly CapabilityClaim[];
}

export type PlanModeCapabilityDecision =
	| { readonly decision: "allow"; readonly modeRevision: number }
	| { readonly decision: "deny"; readonly modeRevision: number; readonly reasonCode: PlanModeDenyReason };

export type PlanModeDenyReason =
	| "plan_mode_unknown_effect"
	| "plan_mode_write_denied"
	| "plan_mode_process_denied"
	| "plan_mode_network_denied"
	| "plan_mode_credential_denied"
	| "plan_mode_deploy_denied"
	| "plan_mode_cross_workspace_denied";

const RESTRICTED_STATUSES = new Set<PlanModeState["status"]>(["active", "awaiting_approval", "exit_pending"]);

/**
 * Evaluate the immutable mode snapshot against Runtime capability claims.
 * Every claim must be safe for planning; one unsafe or unknown claim denies
 * the whole invocation.  This preserves deny-over-approval semantics.
 */
export function evaluatePlanModeCapabilities(request: PlanModeCapabilityRequest): PlanModeCapabilityDecision {
	const state = request.state;
	const modeRevision = state?.revision ?? 0;
	if (state === undefined || !RESTRICTED_STATUSES.has(state.status)) return { decision: "allow", modeRevision };
	if (request.claims.length === 0) return { decision: "deny", modeRevision, reasonCode: "plan_mode_unknown_effect" };
	for (const claim of request.claims) {
		const denied = denyReason(claim);
		if (denied !== undefined) return { decision: "deny", modeRevision, reasonCode: denied };
	}
	return { decision: "allow", modeRevision };
}

function denyReason(claim: CapabilityClaim): PlanModeDenyReason | undefined {
	switch (claim.name) {
		case "repository_read":
			return claim.resourceKind === "filesystem" ? undefined : "plan_mode_unknown_effect";
		case "workspace_write": return "plan_mode_write_denied";
		case "process":
		case "dependency_install": return "plan_mode_process_denied";
		case "network": return "plan_mode_network_denied";
		case "credential": return "plan_mode_credential_denied";
		case "deploy": return "plan_mode_deploy_denied";
		case "cross_workspace": return "plan_mode_cross_workspace_denied";
	}
}
