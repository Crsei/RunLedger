import { describe, expect, it, vi } from "vitest";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { PlanModeState } from "../../src/runtime/modes/plan/types.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { PlanWorkflow } from "../../src/tui/interactive/plan-workflow.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";

function reviewState(): PlanModeState {
	const sessionId = createRuntimeId("session", "plan-review");
	const goalId = createRuntimeId("goal", "plan-review");
	const digest = runtimeDigest("Reviewed plan");
	return {
		status: "awaiting_approval", sessionId, goalId, revision: 4,
		plan: { goalId, workspaceId: createRuntimeId("workspace", "plan-review"), revision: 1, digest, artifactRef: { subjectKind: "artifact", digest, mediaType: "text/markdown", size: 13 } },
		approval: { approvalId: createRuntimeId("approval", "plan-review"), goalId, revision: 1, digest, status: "pending" },
		policyCeilingDigest: digest, sourceHead: { streamId: sessionId, sequence: 4, eventHash: digest },
		projectionDigest: digest, completeness: "complete", updatedAt: "2026-09-05T00:00:00.000Z",
	};
}

describe("Plan mode review", () => {
	it("binds approval to the displayed artifact and leaves a stale rejection visible", async () => {
		const state = reviewState();
		const controller = new ContractController({ supportedOperations: ["plan.inspect", "plan.request_approval", "plan.resolve_approval"] });
		const command = vi.fn(async () => ({ ok: false as const, status: "stale" as const, code: "domain_revision_conflict", operation: "plan.resolve_approval" }));
		Object.assign(controller, {
			querySessionDomain: vi.fn(async () => ({ ok: true, status: "ok", operation: "plan.inspect", domainRevision: state.revision, value: { state, content: "Reviewed plan" } })),
			commandSessionDomain: command,
		});
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const internal = mode as unknown as { planWorkflow: PlanWorkflow; ui: { getOverlay(): { render(width: number): string[]; handleInput(data: string): void } }; showNotice(text: string, kind?: string): void };
		const notice = vi.spyOn(internal, "showNotice");
		try {
			await internal.planWorkflow.openPlanWorkflow();
			const modal = internal.ui.getOverlay();
			expect(modal.render(80).join("\n")).toContain("Reviewed plan");
			modal.handleInput("\r");
			await settleFrames();
			expect(command).toHaveBeenCalledWith("plan.resolve_approval", {
				expectedRevision: 4, expectedPlanRevision: 1, expectedPlanDigest: state.plan!.digest,
				approvalId: state.approval!.approvalId, decision: "approved",
			}, expect.objectContaining({ expectedRevision: 4 }));
			// stale 审批必须作为 error 暴露出来，且不进入实施；具体文案不作断言。
			expect(notice.mock.calls.some(([text, kind]) => kind === "error" && String(text).includes("domain_revision_conflict"))).toBe(true);
		} finally { mode.quit(); }
	});

	it("Esc closes review without mutating a pending approval", async () => {
		const state = reviewState();
		const command = vi.fn();
		const controller = new ContractController({ supportedOperations: ["plan.inspect", "plan.request_approval"] });
		Object.assign(controller, { querySessionDomain: async () => ({ ok: true, status: "ok", operation: "plan.inspect", domainRevision: 4, value: { state, content: "Reviewed plan" } }), commandSessionDomain: command });
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const internal = mode as unknown as { planWorkflow: PlanWorkflow; ui: { getOverlay(): { handleInput(data: string): void } | undefined } };
		try {
			await internal.planWorkflow.openPlanWorkflow();
			internal.ui.getOverlay()!.handleInput("\x1b");
			expect(command).not.toHaveBeenCalled();
			expect(internal.ui.getOverlay()).toBeUndefined();
		} finally { mode.quit(); }
	});
});
