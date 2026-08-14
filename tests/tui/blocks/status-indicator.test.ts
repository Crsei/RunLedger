import { describe, expect, it } from "vitest";
import { projectStatusIndicator } from "../../../src/tui/presentation/projectors.ts";
import type { ActiveRunState } from "../../../src/tui/timeline/types.ts";

function activeRun(overrides: Partial<ActiveRunState> = {}): ActiveRunState {
	return {
		runId: "run-1",
		state: "working",
		startedAtMs: 1_000,
		activeDurationMs: 0,
		lastResumedAtMs: 1_000,
		...overrides,
	};
}

describe("Codex session display S5 status indicator", () => {
	it("projects a working run with an animated indicator, compact elapsed time, interrupt hint, and bounded details", () => {
		const view = projectStatusIndicator(activeRun(), {
			nowMs: 13_000,
			animationFrame: 0,
			interruptKey: "^C",
			details: [
				{ text: "first", truncated: false, byteLength: 5 },
				{ text: "second", truncated: false, byteLength: 6 },
				{ text: "third", truncated: false, byteLength: 5 },
				{ text: "fourth", truncated: false, byteLength: 6 },
			],
		});

		expect(view).toMatchObject({
			indicator: "⠋",
			header: "Working",
			elapsed: "12s",
			interruptKey: "^C",
		});
		expect(view?.details).toHaveLength(3);
	});

	it("projects waiting without an interrupt hint and freezes active elapsed time", () => {
		const view = projectStatusIndicator(activeRun({
			state: "waiting",
			activeDurationMs: 12_000,
			lastResumedAtMs: undefined,
		}), { nowMs: 99_000, interruptKey: "^C" });

		expect(view).toMatchObject({
			indicator: "⏸",
			header: "Waiting",
			elapsed: "12s",
		});
		expect(view?.interruptKey).toBeUndefined();
	});

	it("does not project a status row after a run has ended or entered recovery", () => {
		expect(projectStatusIndicator(undefined, { nowMs: 13_000 })).toBeUndefined();
		expect(projectStatusIndicator(activeRun({ state: "recovery_required" }), { nowMs: 13_000 })).toBeUndefined();
	});
});
