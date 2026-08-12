import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createInitialProcessOverlayState, processOverlayReducer } from "../../../src/tui/process/reducer.ts";
import { renderProcessOverlay } from "../../../src/tui/process/presentation.ts";
import type { ProcessOverlayState } from "../../../src/tui/process/types.ts";

function state(): ProcessOverlayState {
	return createInitialProcessOverlayState({
		processes: [{
			executionId: createRuntimeId("execution", "tui"),
			attemptId: createRuntimeId("attempt", "tui_1"),
			state: "running",
			outputCursor: { sequence: 1, byteOffset: 4 },
			outputSize: 12,
			canWrite: true,
			canResize: true,
			canStop: true,
			commandDisplay: { authority: "unavailable" },
		}],
		driver: true,
	});
}

describe("R9 process overlay pure state", () => {
	it("opens detail, keeps cursor pages bounded, and restores editor focus on close", () => {
		const initial = state();
		const executionId = initial.processes[0]!.executionId;
		const detail = processOverlayReducer(initial, { type: "open_detail", executionId });
		const withOutput = processOverlayReducer(detail, { type: "output_page", text: "hello😀\n", nextCursor: { sequence: 1, byteOffset: 12 }, truncated: false });
		const closed = processOverlayReducer(withOutput, { type: "close" });
		expect(detail.mode).toBe("detail");
		expect(withOutput.output).toBe("hello😀\n");
		expect(withOutput.cursor).toEqual({ sequence: 1, byteOffset: 12 });
		expect(closed.open).toBe(false);
		expect(closed.editorFocusRestored).toBe(true);
	});

	it("does not expose mutation actions to an observer", () => {
		const observer = createInitialProcessOverlayState({ processes: [], driver: false });
		const next = processOverlayReducer(observer, { type: "request_stop" });
		expect(next).toEqual(observer);
	});

	it("fits UTF-8 output and chrome inside narrow frames", () => {
		const current = processOverlayReducer(processOverlayReducer(state(), { type: "open_detail", executionId: state().processes[0]!.executionId }), { type: "output_page", text: "一二三四五六七八九十\n", nextCursor: { sequence: 3, byteOffset: 30 }, truncated: true });
		const lines = renderProcessOverlay(current, 40, 12);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.every((line) => [...line].length <= 40)).toBe(true);
		expect(lines.join("\n")).toContain("running");
	});
});
