import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { evaluatePlanModeCapabilities } from "../../../src/runtime/modes/plan/policy.ts";
import { createManageSkillTool, manageSkillSchema } from "../../../src/runtime/tools/manage-skill.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";

describe("manage_skill tool", () => {
	it("validates create/update/delete contracts without accepting arbitrary fields", () => {
		expect(Value.Check(manageSkillSchema, { action: "create", name: "release-notes", description: "Draft notes", body: "Use history." })).toBe(true);
		expect(Value.Check(manageSkillSchema, { action: "delete", name: "release-notes" })).toBe(true);
		expect(Value.Check(manageSkillSchema, { action: "create", name: "../escape", description: "x", body: "x" })).toBe(false);
		expect(Value.Check(manageSkillSchema, { action: "create", name: "release-notes", description: "x", body: "x", root: "/tmp" })).toBe(false);
	});

	it("reports mutation and carries a write capability claim", async () => {
		const calls: unknown[] = [];
		const tool = createManageSkillTool({
			mutate: async (input) => {
				calls.push(input);
				return { ok: true, action: "create", name: input.name, reload: "pending" };
			},
		});
		const result = await tool.execute("manage-skill-1", { action: "create", name: "release-notes", description: "Draft notes", body: "Use history." });
		expect(calls).toEqual([{ action: "create", name: "release-notes", description: "Draft notes", body: "Use history." }]);
		expect(result).toMatchObject({ details: { ok: true, reload: "pending" } });
		expect((result.content[0] as { text: string }).text).toContain("after this turn");

		const registered = createStdlibTools("/workspace", { manageSkill: { mutate: async () => ({ ok: true, action: "delete", name: "release-notes" }) } }).get("manage_skill");
		expect(registered?.isDestructive?.()).toBe(true);
		expect(evaluatePlanModeCapabilities({ state: undefined, claims: registered?.capabilityClaims ?? [], enforceReadonly: true }))
			.toMatchObject({ decision: "deny" });
	});
});
