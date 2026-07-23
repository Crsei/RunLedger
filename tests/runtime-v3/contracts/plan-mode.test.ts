import type { Static } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	ApprovedPlanRefSchema,
	isApprovedPlanRef,
	isPlanApprovalRef,
	isPlanArtifactRef,
	isPlanModeCommand,
	isPlanModeState,
	PlanApprovalRefSchema,
	PlanArtifactRefSchema,
	PlanModeCommandSchema,
	PlanModeStateSchema,
} from "../../../src/runtime/modes/plan/schema.ts";
import type { ApprovedPlanRef, PlanModeCommand, PlanModeState } from "../../../src/runtime/modes/plan/types.ts";
import { runtimeEventPayloadSchema } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { asRecord, loadContractFixture } from "./helpers.ts";

function fixture(): Record<string, unknown> {
	return asRecord(loadContractFixture("plan-mode/approval-resume.json"));
}

describe("Phase 6 Plan Mode contracts", () => {
	it("keeps schema static types aligned with public types", () => {
		expectTypeOf<Static<typeof ApprovedPlanRefSchema>>().toEqualTypeOf<ApprovedPlanRef>();
		expectTypeOf<Static<typeof PlanModeStateSchema>>().toEqualTypeOf<PlanModeState>();
		expectTypeOf<Static<typeof PlanModeCommandSchema>>().toEqualTypeOf<PlanModeCommand>();
	});

	it("round-trips revision-pinned plan and approval refs", () => {
		const value = fixture();
		expect(Check(PlanArtifactRefSchema, value.plan)).toBe(true);
		expect(isPlanArtifactRef(value.plan)).toBe(true);
		expect(Check(PlanApprovalRefSchema, value.approval)).toBe(true);
		expect(isPlanApprovalRef(value.approval)).toBe(true);
		expect(Check(ApprovedPlanRefSchema, value.approvedPlan)).toBe(true);
		expect(isApprovedPlanRef(value.approvedPlan)).toBe(true);
		expect(isApprovedPlanRef(JSON.parse(JSON.stringify(value.approvedPlan)) as unknown)).toBe(true);
	});

	it("preserves awaiting approval across a resumable state and expected-revision command", () => {
		const value = fixture();
		expect(Check(PlanModeStateSchema, value.state)).toBe(true);
		expect(isPlanModeState(value.state)).toBe(true);
		expect(asRecord(value.state).kind).toBe("awaiting_approval");
		expect(Check(PlanModeCommandSchema, value.command)).toBe(true);
		expect(isPlanModeCommand(value.command)).toBe(true);
	});

	it("rejects revision, digest, approval and version drift", () => {
		const value = fixture();
		const state = asRecord(value.state);
		const approval = asRecord(value.approval);
		const command = asRecord(value.command);
		expect(isPlanModeState({ ...state, schemaVersion: 2 })).toBe(false);
		expect(isPlanModeState({ ...state, future: true })).toBe(false);
		expect(isPlanApprovalRef({ ...approval, contentDigest: "0".repeat(64) })).toBe(true);
		expect(isPlanModeState({ ...state, approval: { ...approval, planRevision: 4 } })).toBe(false);
		const expectedRevision = asRecord(command.expectedRevision);
		const stream = asRecord(expectedRevision.stream);
		expect(isPlanModeCommand({
			...command,
			expectedRevision: { ...expectedRevision, stream: { ...stream, sessionId: "session_other" } },
		})).toBe(false);
		expect(isPlanModeCommand({
			...command,
			expectedRevision: { ...expectedRevision, stream: { ...stream, streamId: "eventStream_other" } },
		})).toBe(false);
		expect(isPlanModeCommand({ ...command, approval: { ...approval, state: "pending", receipt: undefined } })).toBe(false);
	});

	it("registers exact mode and plan lifecycle payloads", () => {
		expect(Check(runtimeEventPayloadSchema("mode.transitioned"), {
			from: "default",
			to: "plan",
			fromState: "inactive",
			toState: "pending_activation",
			modeRevision: 1,
			commandId: "command_plan",
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("plan.approved"), {
			planId: "plan_fixture",
			planRevision: 3,
			approvalId: "approval_plan",
			receiptId: "receipt_plan",
		})).toBe(true);
	});
});
