import { describe, expect, it } from "vitest";
import { buildPlanFragment } from "../../../../src/runtime/modes/plan/prompt.ts";
import type { PlanArtifactRef, PlanModeState } from "../../../../src/runtime/modes/plan/types.ts";
import { runtimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";

const digest = runtimeDigest("plan-fragment");
const sessionId = createRuntimeId("session", "plan-fragment");
const goalId = createRuntimeId("goal", "plan-fragment");
const workspaceId = createRuntimeId("workspace", "plan-fragment");

function plan(content: string, revision: number): PlanArtifactRef {
	const contentDigest = runtimeDigest(content);
	return {
		goalId, workspaceId, revision, digest: contentDigest,
		artifactRef: { subjectKind: "artifact", digest: contentDigest, mediaType: "text/markdown", size: Buffer.byteLength(content, "utf8") },
	};
}

function state(status: PlanModeState["status"], artifact?: PlanArtifactRef, approval?: PlanModeState["approval"]): PlanModeState {
	return {
		status, sessionId, goalId, revision: 7,
		...(artifact === undefined ? {} : { plan: artifact }),
		...(approval === undefined ? {} : { approval }),
		policyCeilingDigest: digest,
		sourceHead: { streamId: sessionId, sequence: 3, eventHash: digest },
		projectionDigest: digest,
		completeness: "complete",
		updatedAt: "2026-09-16T00:00:00.000Z",
	};
}

describe("plan mode context fragment", () => {
	it("injects nothing while plan mode is inactive", () => {
		expect(buildPlanFragment({ state: state("inactive") })).toBeUndefined();
	});

	it("binds the fragment key to status and artifact revision", () => {
		const first = buildPlanFragment({ state: state("active", plan("# Plan A", 0)) })!;
		const second = buildPlanFragment({ state: state("active", plan("# Plan A", 0)) })!;
		const revised = buildPlanFragment({ state: state("active", plan("# Plan B", 1)) })!;
		const awaiting = buildPlanFragment({ state: state("awaiting_approval", plan("# Plan B", 1), { approvalId: createRuntimeId("approval", "a"), goalId, revision: 1, digest: runtimeDigest("# Plan B"), status: "pending" }) })!;

		expect(first.key).toBe(second.key);
		expect(first.key).not.toBe(revised.key);
		expect(revised.key).not.toBe(awaiting.key);
	});

	it("inlines the artifact body for the active revision and skips it once inlined", () => {
		const content = "# Plan A\n\n1. Do the thing";
		const inline = buildPlanFragment({ state: state("active", plan(content, 0)), content })!;
		expect(inline.text).toContain(content);
		expect(inline.text).toContain('inlined="false"');
		expect(inline.text).toContain("read-only");

		const alreadyInlined = buildPlanFragment({ state: state("active", plan(content, 0)), content, contentInlined: true })!;
		expect(alreadyInlined.text).not.toContain(content);
		expect(alreadyInlined.text).toContain('inlined="true"');
		expect(alreadyInlined.key).toBe(inline.key);
	});

	it("states the mode constraint for each live status without leaking a plan body on approval", () => {
		const content = "# Plan A\n\n1. Do the thing";
		const awaiting = buildPlanFragment({
			state: state("awaiting_approval", plan(content, 1), { approvalId: createRuntimeId("approval", "b"), goalId, revision: 1, digest: runtimeDigest(content), status: "pending" }),
			content,
		})!;
		// 待审批时不重投正文（预算），只给出被 pin 的 revision/digest；模型需要正文时用 plan_read。
		expect(awaiting.text).toContain("awaiting user approval");
		expect(awaiting.text).toContain('revision="1"');
		expect(awaiting.text).toContain('inlined="true"');
		expect(awaiting.text).not.toContain(content);

		const exitPending = buildPlanFragment({
			state: state("exit_pending", plan(content, 1), { approvalId: createRuntimeId("approval", "c"), goalId, revision: 1, digest: runtimeDigest(content), status: "approved" }),
			content,
		})!;
		expect(exitPending.text).toContain("was approved");
		expect(exitPending.text).toContain(content);

		const pending = buildPlanFragment({ state: state("pending") })!;
		expect(pending.text).toContain("next turn boundary");
		expect(pending.text).not.toContain("<plan ");
	});

	it("carries the plan quality rules that make the artifact executable", () => {
		const fragment = buildPlanFragment({ state: state("active", plan("# Plan", 0)) })!;
		expect(fragment.text).toContain("execution spec, not a design doc");
		expect(fragment.text).toContain("end-to-end verification");
		expect(fragment.text).toContain("Do not add decision-free sections");
		expect(fragment.text).toContain("cannot approve your own plan");
	});
});
