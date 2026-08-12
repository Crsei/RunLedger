import { afterEach, describe, expect, it } from "vitest";
import { LateBoundHumanInputWaitPort } from "../../../src/runtime/session-runtime/approval-reverse-request.ts";
import { LateBoundAgentRunBudgetUsage } from "../../../src/runtime/session-runtime/run-timing.ts";
import type { InteractiveSessionControllerPort } from "../../../src/runtime/interactive-session-controller.ts";
import type { AgentEvent } from "../../../src/runtime/types.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { RuntimeHarness } from "./harness.ts";
import { createRuntimeHarness } from "./harness.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
});

describe("Session Runtime approval wait timing integration", () => {
	it("binds active-duration budget usage to the Runtime timing authority", async () => {
		const usage = new LateBoundAgentRunBudgetUsage();
		expect(() => usage.activeDurationMs()).toThrow(/not bound/u);
		harness = await createRuntimeHarness("run-budget-usage", { runBudgetUsageRef: usage });

		expect(usage.activeDurationMs()).toBe(0);
	});

	it("binds the approval wait port when the Session Runtime is constructed", async () => {
		const waitPort = new LateBoundHumanInputWaitPort();
		harness = await createRuntimeHarness("approval-wait-binding", { humanInputWaitPortRef: waitPort });

		await expect(waitPort.withHumanInputWait("approval-runtime-bound", "approval", async () => "ok"))
			.resolves.toBe("ok");
	});

	it("persists paired pause and resume events around an approval wait", async () => {
		const waitPort = new LateBoundHumanInputWaitPort();
		let emit: ((event: AgentEvent) => void) | undefined;
		const controller = {
			subscribe: (listener: (event: AgentEvent) => void) => {
				emit = listener;
				return () => undefined;
			},
		} as unknown as InteractiveSessionControllerPort;
		const domain: SessionDomainPort = {
			controller,
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" },
				toolCount: 0,
				inFlight: true,
				providerStatuses: [],
			}),
		};
		harness = await createRuntimeHarness("approval-wait-events", { domain, humanInputWaitPortRef: waitPort });
		expect(emit).toBeTypeOf("function");
		emit?.({ type: "agent_start", timestamp: 1_000, runId: "run-approval-wait" });
		let finish: (() => void) | undefined;
		const waiting = waitPort.withHumanInputWait("approval-event-pair", "approval", () => new Promise<void>((resolve) => {
			finish = resolve;
		}));
		await Promise.resolve();

		const beforeResume = agentEvents();
		expect(beforeResume).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "agent_work_pause", runId: "run-approval-wait", waitId: "approval-event-pair", reason: "approval" }),
		]));
		finish?.();
		await waiting;

		const afterResume = agentEvents();
		expect(afterResume).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "agent_work_resume", runId: "run-approval-wait", waitId: "approval-event-pair", reason: "approval" }),
		]));
		emit?.({ type: "agent_end", timestamp: 1_100, runId: "run-approval-wait", stopReason: "stop", messageCountAtEnd: 0 });

		function agentEvents(): Record<string, unknown>[] {
			return harness!.store.replaySessionEvents(harness!.sessionId)
				.filter((event) => event.eventType === "agent.event")
				.map((event) => JSON.parse(event.payloadJson) as Record<string, unknown>);
		}
	});
});
