import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createProcessOverlayController } from "../../../src/tui/process/controller-adapter.ts";
import { ProcessOverlayComponent } from "../../../src/tui/process/overlay-component.ts";
import type { ProcessOverlayItem } from "../../../src/tui/process/types.ts";

const executionId = createRuntimeId("execution", "overlay-component");
const item: ProcessOverlayItem = {
	executionId,
	attemptId: createRuntimeId("attempt", "overlay-component_1"),
	state: "running",
	outputCursor: { sequence: 0, byteOffset: 0 },
	outputSize: 0,
	canWrite: true,
	canResize: true,
	canStop: true,
	commandDisplay: { authority: "spawned", label: "npm test", receiptDigest: { algorithm: "sha256", digest: "a".repeat(64) } },
};

describe("R9 process overlay component", () => {
	it("opens list/detail/terminal lazily, sends driver input, and closes with focus restoration", async () => {
		const calls: string[] = [];
		const controller = createProcessOverlayController({
			listProcesses: async () => [item],
			processOutput: async (_id, cursor) => ({ ok: true as const, text: "lazy😀\n", startCursor: cursor, endCursor: { sequence: 1, byteOffset: 8 }, nextCursor: { sequence: 1, byteOffset: 8 }, truncated: false, head: { sequence: 1, byteOffset: 8 } }),
			writeStdin: async (_id, input) => { calls.push(`write:${input}`); return { ok: true as const }; },
			resizeProcess: async () => ({ ok: true as const }),
			stopProcess: async () => ({ ok: true as const }),
		}, { driver: true });
		let closed = 0;
		const component = new ProcessOverlayComponent({ controller, onClose: () => { closed += 1; } });

		await component.openList();
		component.handleInput("enter");
		component.handleInput("t");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		component.handleInput("x");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(component.render(60).join("\n")).toContain("lazy😀");
		expect(component.render(60).join("\n")).toContain("npm test · spawned");
		expect(calls).toEqual(["write:x"]);
		component.handleInput("\x1b");
		expect(closed).toBe(1);
		expect(controller.snapshot().editorFocusRestored).toBe(true);
	});

	it("renders observer terminal as read-only without mutation controls", async () => {
		const controller = createProcessOverlayController({
			listProcesses: async () => [item],
			processOutput: async (_id, cursor) => ({ ok: true as const, text: "read only", startCursor: cursor, endCursor: { sequence: 1, byteOffset: 9 }, nextCursor: { sequence: 1, byteOffset: 9 }, truncated: false, head: { sequence: 1, byteOffset: 9 } }),
		}, { driver: false });
		const component = new ProcessOverlayComponent({ controller, onClose: () => {} });
		await component.openTerminal(executionId);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const rendered = component.render(60).join("\n");
		expect(rendered).toContain("observer · read only");
		expect(rendered).not.toContain("stdin/resize/stop enabled");
	});
});
