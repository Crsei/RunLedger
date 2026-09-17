import { describe, expect, it, vi } from "vitest";
import { commandsForContext, type SlashCommandContext } from "../../../src/tui/commands/registry.ts";
import { InteractiveMode } from "../../../src/tui/interactive-mode.ts";
import { ContractController, ContractTerminal } from "../fixtures/contract-integration.ts";
import type { GoalLoopWorkflow } from "../../../src/tui/interactive/goal-loop-workflow.ts";

const description = (context: SlashCommandContext) => commandsForContext(context).find(command => command.canonicalName === "goal")?.description;

describe("goal command projection", () => {
	it.each(["inactive", "active", "paused", "budget_limited", "complete"])("describes %s from the current projection", status => {
		expect(description({ goal: { status, tokensUsed: 12, tokenBudget: 100, accountingCompleteness: "complete" } })).toContain(status);
	});
	it("marks partial usage as a lower bound, never as exact usage", () => {
		expect(description({ goal: { status: "active", tokensUsed: 12, tokenBudget: 100, accountingCompleteness: "partial" } })).toContain("≥12/100 tokens (observed lower bound)");
	});
	it("does not retain state when a new session has no projection or no capability", () => {
		description({ goal: { status: "paused", tokensUsed: 12, accountingCompleteness: "complete" } });
		expect(description({})).toContain("unknown");
		expect(description({ supportsOperation: () => false })).toContain("Unavailable");
		expect(description({})).not.toContain("paused");
	});
	it("discards stale asynchronous results after a session change and clears failed queries", async () => {
		const mode = new InteractiveMode({ controller: new ContractController(), terminal: new ContractTerminal() });
		const workflow = (mode as unknown as { goalLoopWorkflow: GoalLoopWorkflow }).goalLoopWorkflow;
		const badge = { status: "active", tokensUsed: 12, accountingCompleteness: "partial" as const, continuations: 1 };
		let resolveOld!: (value: { badge: typeof badge }) => void;
		const inspect = vi.spyOn(workflow, "inspectGoalBadge").mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
		const session = vi.spyOn(mode, "getSessionId").mockReturnValue("old");
		mode.noteGoalChanged();
		session.mockReturnValue("new");
		inspect.mockResolvedValueOnce(undefined);
		mode.noteGoalChanged();
		await Promise.resolve();
		resolveOld({ badge });
		await Promise.resolve();
		expect(mode.getFooterSnapshot().goal).toBeUndefined();
		inspect.mockResolvedValueOnce({ badge });
		mode.noteGoalChanged();
		await Promise.resolve();
		expect(mode.getFooterSnapshot().goal?.status).toBe("active");
		inspect.mockRejectedValueOnce(new Error("disconnected"));
		mode.noteGoalChanged();
		await Promise.resolve();
		expect(mode.getFooterSnapshot().goal).toBeUndefined();
		mode.quit();
	});
});
