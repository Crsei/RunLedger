import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createPlanImplementationHandoffReceipt,
} from "../../../src/runtime/modes/plan/implementation-handoff.ts";
import type { ApprovedPlanRef } from "../../../src/runtime/modes/plan/types.ts";
import {
	DurableControlJournal,
	type ControlJournalRecord,
} from "../../../src/runtime/orchestrator/control-journal.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import {
	approvalReceipt,
	artifact,
	authorityId,
	DIGEST,
	NOW,
	sessionId,
	tenantId,
	workspaceId,
} from "../plan-context-memory/helpers.ts";

function approvedPlan(): ApprovedPlanRef {
	const contentDigest = canonicalDigest("approved implementation plan");
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		planId: createRuntimeId("plan", "handoff-journal"),
		workspaceId,
		revision: 3,
		contentDigest,
		artifact: artifact(contentDigest),
		approvalReceipt: approvalReceipt(
			createRuntimeId("approval", "handoff-journal"),
			"allowed",
		),
	};
}

describe("durable plan implementation handoff journal", () => {
	it("replays one exact bounded receipt and deduplicates the same handoff", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<ControlJournalRecord>();
		const control = new DurableControlJournal({ journal, clock: () => new Date(NOW) });
		const receipt = createPlanImplementationHandoffReceipt({
			approvedPlan: approvedPlan(),
			sourceSessionId: sessionId,
			action: "fresh_context",
			implementationPromptDigest: DIGEST,
			policySnapshotDigest: DIGEST,
			contextSeedDigest: canonicalDigest("approved-plan-only-seed"),
			createdAt: NOW,
		});
		const key = createIdempotencyKey(`plan-handoff-${receipt.receiptDigest.slice(0, 48)}`);
		expect((await control.recordPlanImplementationHandoff(receipt, key)).ok).toBe(true);
		expect((await control.recordPlanImplementationHandoff(receipt, key)).ok).toBe(true);

		const recovered = await new DurableControlJournal({ journal }).snapshot();
		expect(recovered.ok && recovered.value.planImplementationHandoffs).toEqual([{
			kind: "control.plan_implementation_handoff",
			receipt,
			recordedAt: NOW,
		}]);
	});
});
