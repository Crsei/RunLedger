import { describe, expect, it } from "vitest";
import type { SessionRecoveryStatus } from "../../src/runtime/interactive-session-controller.ts";
import { timelineToBlocks } from "../../src/tui/timeline/selectors.ts";
import { plainExecText } from "../../src/tui/opentui/exec-renderable.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { contractAssistantMessage, ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

class RecoveryController extends ContractController {
	status: SessionRecoveryStatus = {
		state: "recovery_required",
		barrierState: "open",
		unresolvedAttempts: 1,
		sideEffectSpawnCount: 0,
	};

	async recoveryStatus() {
		return this.status;
	}

	async recoveryAssess() {
		this.status = {
			state: "ready",
			barrierState: "closed",
			unresolvedAttempts: 0,
			sideEffectSpawnCount: 0,
		};
		return { state: "ready", unresolvedRemaining: 0 };
	}
}

describe("Session Owner recovery command", () => {
	it("settles recovered tool rows as unknown without inventing a successful or cancelled result", async () => {
		const controller = new RecoveryController({ messages: [contractAssistantMessage({
			content: [{ type: "toolCall", id: "old-call", name: "bash", arguments: { command: "echo pending" } }], stopReason: "toolUse",
		})] });
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const running = mode.run();
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(mode.getTuiState().timeline.activeOrder).toEqual([]);
			expect(mode.getTuiState().timeline.committedRows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool", status: "unknown" })]));
			await mode.runRecoveryWorkflow("assess");
			expect(mode.getTuiState().recoveryRequired).toBe(false);
			const footer = (mode as unknown as { refs: { footer: { render(width: number): string[] } } }).refs.footer;
			expect(footer.render(100).join("\n")).not.toContain("Recovery required");
			const blocks = timelineToBlocks(mode.getTuiState().timeline);
			const exec = blocks.find((block) => block.kind === "exec");
			expect(exec?.kind).toBe("exec");
			if (exec?.kind === "exec") expect(plainExecText(exec)).toContain("Outcome unknown");
		} finally { mode.quit(); await running; }
	});

	it("hydrates recovery-required before the first interactive frame and renders it in the footer", async () => {
		const controller = new RecoveryController();
		const terminal = new ContractTerminal();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(mode.getTuiState()).toMatchObject({ recoveryRequired: true, transitionFrozen: true });
			const footer = (mode as unknown as { refs: { footer: { render(width: number): string[] } } }).refs.footer;
			expect(footer.render(100).join("\n")).toContain("Recovery required");
		} finally {
			mode.quit();
			await running;
		}
	});

	it("refreshes recovery state after a recovery command settles", async () => {
		const controller = new RecoveryController();
		const terminal = new ContractTerminal();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(mode.getTuiState().recoveryRequired).toBe(true);
			await mode.runRecoveryWorkflow("assess");
			expect(mode.getTuiState()).toMatchObject({ recoveryRequired: false, transitionFrozen: false });
		} finally {
			mode.quit();
			await running;
		}
	});
});
