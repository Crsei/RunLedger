import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { evaluatePlanModeCapabilities } from "../../../src/runtime/modes/plan/policy.ts";
import { createCheckpointTool, checkpointSchema } from "../../../src/runtime/tools/checkpoint.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";

describe("checkpoint tool", () => {
	it("has a bounded closed schema", () => {
		expect(Value.Check(checkpointSchema, { goal: "Before refactor" })).toBe(true);
		expect(Value.Check(checkpointSchema, { goal: "", report: "not accepted" })).toBe(false);
	});

	it("creates through its injected Session authority and is denied in Plan mode", async () => {
		const checkpointId = createRuntimeId("snapshot", "checkpoint-tool");
		const tool = createCheckpointTool({
			create: async (goal) => ({ ok: true, checkpoint: {
				checkpointId, sessionId: createRuntimeId("session", "checkpoint-tool"), goal, summaryDigest: runtimeDigest(goal).digest,
				boundarySequence: 4, boundaryEventHash: "a".repeat(64), createdAtMs: 1, ownerGeneration: 1,
			} }),
			rewind: async () => ({ ok: false, code: "not_called" }),
		});
		const result = await tool.execute("tool-checkpoint", { goal: "Before refactor" });
		expect(result).toMatchObject({ details: { ok: true, checkpoint: { checkpointId } } });

		const registry = createStdlibTools("/workspace", { namedCheckpoint: {
			create: async () => ({ ok: false, code: "not_called" }),
			rewind: async () => ({ ok: false, code: "not_called" }),
		} });
		expect(registry.has("checkpoint")).toBe(true);
		expect(registry.has("rewind")).toBe(true);
		expect(evaluatePlanModeCapabilities({ state: undefined, claims: registry.get("checkpoint")?.capabilityClaims ?? [], enforceReadonly: true }))
			.toMatchObject({ decision: "deny" });
	});
});
