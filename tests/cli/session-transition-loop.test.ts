import { describe, expect, it } from "vitest";
import { runSessionTransitionLoop } from "../../src/cli/session-transition-loop.ts";
import type { InteractiveExitIntent } from "../../src/tui/interactive-mode.ts";

interface FakeView {
	readonly sessionId: string;
	readonly runIntent: InteractiveExitIntent;
}

describe("S2 CLI session transition loop", () => {
	it("detaches the current view when renderer startup or run fails", async () => {
		const order: string[] = [];
		await expect(runSessionTransitionLoop<FakeView>({
			initialSessionId: "session-a",
			open: async (sessionId) => ({ sessionId, runIntent: { kind: "quit" } }),
			run: async (view) => {
				order.push(`run:${view.sessionId}`);
				throw new Error("renderer failed");
			},
			detach: async (view) => { order.push(`detach:${view.sessionId}`); },
		})).rejects.toThrow("renderer failed");
		expect(order).toEqual(["run:session-a", "detach:session-a"]);
	});

	it("always detaches the current view before opening the switch target", async () => {
		const order: string[] = [];
		const intents = new Map<string, InteractiveExitIntent>([
			["session-a", { kind: "switch", action: "resume", target: { sessionId: "session-b" } }],
			["session-b", { kind: "quit" }],
		]);
		await runSessionTransitionLoop<FakeView>({
			initialSessionId: "session-a",
			open: async (sessionId) => {
				order.push(`open:${sessionId}`);
				return { sessionId, runIntent: intents.get(sessionId)! };
			},
			run: async (view) => {
				order.push(`run:${view.sessionId}`);
				return view.runIntent;
			},
			detach: async (view) => { order.push(`detach:${view.sessionId}`); },
		});
		expect(order).toEqual([
			"open:session-a",
			"run:session-a",
			"detach:session-a",
			"open:session-b",
			"run:session-b",
			"detach:session-b",
		]);
	});

	it("reopens the original Session only through the same canonical open path when target attach fails", async () => {
		const order: string[] = [];
		let originalOpenCount = 0;
		await runSessionTransitionLoop<FakeView>({
			initialSessionId: "session-a",
			open: async (sessionId) => {
				order.push(`open:${sessionId}`);
				if (sessionId === "session-b") throw new Error("target attach failed");
				originalOpenCount += 1;
				return {
					sessionId,
					runIntent: originalOpenCount === 1
						? { kind: "switch", action: "resume", target: { sessionId: "session-b" } }
						: { kind: "quit" },
				};
			},
			run: async (view) => view.runIntent,
			detach: async (view) => { order.push(`detach:${view.sessionId}`); },
			onSwitchFailure: (failure) => order.push(`failed:${failure.fromSessionId}:${failure.targetSessionId}`),
		});
		expect(order).toEqual([
			"open:session-a",
			"detach:session-a",
			"open:session-b",
			"failed:session-a:session-b",
			"open:session-a",
			"detach:session-a",
		]);
	});
});
