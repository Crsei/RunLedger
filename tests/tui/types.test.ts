import { describe, expect, it } from "vitest";
import { adaptAgentEvent } from "../../src/tui/types.ts";

describe("TUI Agent event adapter", () => {
	it("preserves the structured budget termination reason", () => {
		expect(adaptAgentEvent({
			type: "agent_end",
			timestamp: 1_000,
			runId: "run-budget",
			stopReason: "length",
			terminationReason: "approval_expiration_limit",
		})).toMatchObject({
			type: "agent_end",
			terminationReason: "approval_expiration_limit",
		});
	});
});
