import { describe, expect, it } from "vitest";
import { builtinCommandDescriptors, commandsForContext, findCommand, isCommandAvailable } from "../../../src/tui/commands/registry.ts";
import { createDefaultFooterFieldRegistry } from "../../../src/tui/footer/field-registry.ts";
import { transcriptBlockLines } from "../../../src/tui/transcript-view.ts";

describe("goal and loop slash commands", () => {
	it("registers both commands with their negotiated operations", () => {
		const goal = findCommand("goal");
		expect(goal).toMatchObject({
			actionType: "goal.inspect",
			requiredOperation: "goal.inspect",
			supportsInlineArgs: true,
			availableDuringTask: false,
		});
		const loop = findCommand("loop");
		expect(loop).toMatchObject({
			actionType: "loop.control",
			requiredOperation: "loop.start",
			supportsInlineArgs: true,
			availableDuringTask: false,
		});
		expect(builtinCommandDescriptors().filter((command) => command.actionType === "goal.inspect" || command.actionType === "loop.control")).toHaveLength(2);
	});

	it("marks the commands unavailable when the Session does not negotiate the operation", () => {
		const never = () => false;
		for (const name of ["goal", "loop"]) {
			const entry = findCommand(name)!;
			expect(isCommandAvailable(entry, never), name).toBe(false);
			expect(commandsForContext({ supportsOperation: never }).find((command) => command.canonicalName === name)!.description, name)
				.toContain("Unavailable in this session");
		}
		const negotiates = (operation: string) => operation === "goal.inspect" || operation === "loop.start";
		expect(isCommandAvailable(findCommand("goal")!, negotiates)).toBe(true);
		expect(isCommandAvailable(findCommand("loop")!, negotiates)).toBe(true);
		expect(commandsForContext({ supportsOperation: negotiates }).find((command) => command.canonicalName === "goal")!.description)
			.not.toContain("Unavailable in this session");
	});
});

describe("goal footer badge", () => {
	it("projects the goal status with an explicit lower-bound marker for partial accounting", () => {
		const registry = createDefaultFooterFieldRegistry();
		const goalField = registry.list("identity").find((entry) => entry.definition.id === "identity.goal")?.definition;
		expect(goalField, "identity.goal field must be registered").toBeDefined();

		const base = {
			nowMs: 0, isStreaming: false, modelId: "fixture", queue: { steering: 0, followUp: 0 },
		} as const;
		expect(goalField!.project({ ...base })).toBeUndefined();
		expect(goalField!.project({ ...base, goal: { status: "inactive", tokensUsed: 0, accountingCompleteness: "complete", continuations: 0 } })).toBeUndefined();
		expect(goalField!.project({ ...base, goal: { status: "active", tokensUsed: 1_200, accountingCompleteness: "complete", continuations: 0 } }))
			.toBe("Goal: active 1200");
		// partial 完整度必须显示为下界，避免被当作精确值。
		expect(goalField!.project({ ...base, goal: { status: "active", tokensUsed: 1_200, accountingCompleteness: "partial", continuations: 2 } }))
			.toBe("Goal: active ≥1200 ·+2");
		expect(goalField!.project({ ...base, goal: { status: "budget_limited", tokensUsed: 10, accountingCompleteness: "complete", continuations: 3 } }))
			.toBe("Goal: budget_limited 10 ·+3");
	});
});

describe("runtime-origin transcript folding", () => {
	it("renders an owner-injected continuation as a runtime marker, not a user prompt", () => {
		expect(transcriptBlockLines({ kind: "text", role: "runtime", content: "Continue the active goal." }))
			.toEqual(["[runtime] Continue the active goal."]);
		expect(transcriptBlockLines({ kind: "text", role: "user", content: "fix the tests" }))
			.toEqual(["fix the tests"]);
	});
});
