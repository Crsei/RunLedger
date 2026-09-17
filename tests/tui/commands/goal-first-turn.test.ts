import { describe, expect, it, vi } from "vitest";
import { GoalLoopWorkflow } from "../../../src/tui/interactive/goal-loop-workflow.ts";
import { InputController } from "../../../src/tui/interactive/input-controller.ts";
import type { InteractiveModePorts } from "../../../src/tui/interactive/types.ts";

function harness(options: { mutationFails?: boolean; busyAfterSave?: boolean; sessionChanges?: boolean; driverLost?: boolean } = {}) {
	let saved = false;
	const prompt = vi.fn(async () => { if (options.driverLost) throw new Error("driver_required"); });
	const command = vi.fn(async () => {
		saved = true;
		return options.mutationFails ? { ok: false, code: "domain_revision_conflict" } : { ok: true, value: {} };
	});
	const notice = vi.fn();
	const port = {
		controller: { supports: () => true, querySessionDomain: async () => ({ ok: true, value: { state: { status: "inactive", revision: 0 } } }), commandSessionDomain: command, prompt },
		getSessionId: () => options.sessionChanges && saved ? "session_other" : "session_goal",
		inFlight: () => saved && options.busyAfterSave === true,
		hostConnectionState: "ready", clearIdleRecapStatus: () => undefined, setStreaming: () => undefined,
		setStopReason: () => undefined, uiRequestRender: () => undefined,
		showNotice: notice, noteGoalChanged: () => undefined,
		nextCorrelationId: () => 1, nextEffectId: () => 1,
		echoPrompt: (text: string, input: { expectedSessionId?: string; requireIdle?: boolean }) => inputController.submitPrompt(text, input),
	} as unknown as InteractiveModePorts;
	const inputController = new InputController(port);
	return { workflow: new GoalLoopWorkflow(port), prompt, command, notice };
}

describe("goal first turn through normal user submission", () => {
	it("starts exactly once after saving and treats a slash-prefixed objective as text", async () => {
		const h = harness();
		await h.workflow.runGoal("set /fix the flaky test");
		expect(h.command).toHaveBeenCalledTimes(1);
		expect(h.command).toHaveBeenCalledWith("goal.set", { objective: "/fix the flaky test", setBy: "user" }, expect.any(Object));
		expect(h.prompt).toHaveBeenCalledTimes(1);
		expect(h.prompt).toHaveBeenCalledWith("/fix the flaky test", undefined);
	});
	it("does not submit after a failed goal mutation", async () => {
		const h = harness({ mutationFails: true });
		await h.workflow.runGoal("set fix tests");
		expect(h.prompt).not.toHaveBeenCalled();
	});
	it.each([{ busyAfterSave: true }, { sessionChanges: true }])("does not queue a first turn when admission changes: %j", async options => {
		const h = harness(options);
		await h.workflow.runGoal("set fix tests");
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.notice).toHaveBeenCalledWith(expect.stringContaining("Goal saved, but its first turn did not start"), "error");
	});
	it("reports the saved goal separately from a driver admission failure", async () => {
		const h = harness({ driverLost: true });
		await h.workflow.runGoal("set fix tests");
		expect(h.prompt).toHaveBeenCalledTimes(1);
		expect(h.notice).toHaveBeenCalledWith(expect.stringContaining("driver_required"), "error");
		expect(h.notice).toHaveBeenCalledWith(expect.stringContaining("Goal saved, but its first turn did not start"), "error");
	});
});
