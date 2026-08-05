import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";
import type { CapabilityClaim } from "../../../../src/runtime/protocol/capability.ts";
import type { PlanModeState } from "../../../../src/runtime/modes/plan/types.ts";
import { evaluatePlanModeCapabilities } from "../../../../src/runtime/modes/plan/policy.ts";

const sessionId = createRuntimeId("session", "plan-policy-test");
const goalId = createRuntimeId("goal", "plan-policy-test");
const workspaceId = createRuntimeId("workspace", "plan-policy-test");
const revision = 7;
const policyDigest = runtimeDigest("plan-policy");

const activeState: PlanModeState = {
	status: "active",
	sessionId,
	goalId,
	revision,
	plan: {
		goalId,
		workspaceId,
		revision: 0,
		digest: runtimeDigest("plan"),
		artifactRef: { subjectKind: "artifact", digest: runtimeDigest("plan"), mediaType: "text/markdown", size: 4 },
	},
	policyCeilingDigest: policyDigest,
	sourceHead: { streamId: sessionId, sequence: 1, eventHash: runtimeDigest("head") },
	projectionDigest: runtimeDigest("projection"),
	completeness: "complete",
	updatedAt: "2026-08-05T00:00:00.000Z",
};

function claim(name: CapabilityClaim["name"], resourceKind: CapabilityClaim["resourceKind"] = "filesystem"): CapabilityClaim {
	return {
		name,
		resourceKind,
		resourceDigest: runtimeDigest({ name, resourceKind, resource: "fixture" }),
		constraintsDigest: runtimeDigest({ name, constraints: "fixture" }),
		scope: "invocation",
	};
}

describe("Plan Mode capability adapter", () => {
	it("allows a declared repository-read effect and binds the decision to the mode revision", () => {
		expect(evaluatePlanModeCapabilities({ state: activeState, claims: [claim("repository_read")] })).toEqual({
			decision: "allow",
			modeRevision: revision,
		});
	});

	it("denies write, process, and unknown effects even when the normal approval policy could allow them", () => {
		expect(evaluatePlanModeCapabilities({ state: activeState, claims: [claim("workspace_write")] })).toMatchObject({ decision: "deny", reasonCode: "plan_mode_write_denied", modeRevision: revision });
		expect(evaluatePlanModeCapabilities({ state: activeState, claims: [claim("process", "process")] })).toMatchObject({ decision: "deny", reasonCode: "plan_mode_process_denied", modeRevision: revision });
		expect(evaluatePlanModeCapabilities({ state: activeState, claims: [] })).toMatchObject({ decision: "deny", reasonCode: "plan_mode_unknown_effect", modeRevision: revision });
	});

	it("does not restrict tools while Plan Mode is inactive", () => {
		expect(evaluatePlanModeCapabilities({ state: { ...activeState, status: "inactive", plan: undefined, revision: revision + 1 }, claims: [] })).toEqual({
			decision: "allow",
			modeRevision: revision + 1,
		});
	});
});
