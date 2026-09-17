import { describe, expect, it, vi } from "vitest";
import { SessionWorkflow } from "../../../src/tui/interactive/session-workflow.ts";
import type { InteractiveModePorts } from "../../../src/tui/interactive/types.ts";
import type { LoopResetHandoff } from "../../../src/runtime/loop/handoff.ts";

const handoff: LoopResetHandoff = { handoffId: "handoff-1", sourceSessionId: "source", prompt: "work", action: "reset", limit: { kind: "iterations", initial: 2, remaining: 0 }, iteration: 2 };

function harness(failure?: "claim" | "create" | "finish" | "start") {
	const command = vi.fn(async (operation: string) => {
		if (operation === `loop.${failure === "claim" ? "claim_reset" : failure === "finish" ? "finish_reset" : failure}`) return { ok: false, code: "driver_lost" };
		return { ok: true, value: operation === "loop.claim_reset" ? { handoff } : {} };
	});
	const dispatch = vi.fn();
	const exit = vi.fn();
	const notice = vi.fn();
	const port = {
		controller: { supports: () => true, commandSessionDomain: command },
		getSessionId: () => "source", inFlight: () => false,
		nextCorrelationId: () => 1, nextEffectId: () => 1,
		store: { getState: () => ({ capabilities: { sessionMutation: { state: "available" }, sessionCatalog: { state: "available" } } }), dispatch: () => undefined },
		runner: { dispatch }, createEffect: (type: string, payload: unknown) => ({ type, payload, correlationId: type }),
		waitForWorkflow: async (_key: string, id: string) => id === "session.list"
			? { state: "ready", value: { kind: "catalog", items: [], revision: 1 } }
			: failure === "create" ? { state: "error", message: "creation failed" } : { state: "ready", value: { kind: "transition", targetSessionId: "target" } },
		requestExit: exit, showNotice: notice,
	} as unknown as InteractiveModePorts;
	return { workflow: new SessionWorkflow(port), command, dispatch, exit, notice };
}

describe("loop reset client workflow", () => {
	it("uses catalog CAS and the existing new-session exit path after one claim", async () => {
		const h = harness();
		await Promise.all([h.workflow.resetLoopSession("handoff-1"), h.workflow.resetLoopSession("handoff-1")]);
		expect(h.command.mock.calls.filter(call => call[0] === "loop.claim_reset")).toHaveLength(1);
		expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "session.create", payload: { expectedRevision: 1 } }));
		expect(h.exit).toHaveBeenCalledExactlyOnceWith({ kind: "switch", action: "new", target: { sessionId: "target" }, loopHandoff: handoff });
	});
	it.each(["claim", "create", "finish"] as const)("does not switch on %s failure", async failure => {
		const h = harness(failure);
		await h.workflow.resetLoopSession("handoff-1");
		expect(h.exit).not.toHaveBeenCalled();
		if (failure === "claim") expect(h.dispatch).not.toHaveBeenCalled();
		else expect(h.command).toHaveBeenCalledWith("loop.finish_reset", { handoffId: "handoff-1" }, expect.any(Object));
	});
	it("forwards the consumed zero budget unchanged and reports target admission failure", async () => {
		const h = harness("start");
		await h.workflow.continueResetLoop(handoff);
		expect(h.command).toHaveBeenCalledWith("loop.start", expect.objectContaining({ handoff, prompt: "work", clientReset: true }), expect.any(Object));
		expect(h.notice).toHaveBeenCalledWith(expect.stringContaining("handoff-1 from source stopped"), "error");
	});
});
