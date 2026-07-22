import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyToolResultBudget } from "../../../src/runtime/agent-loop.ts";

describe("governed tool-result budget", () => {
	it("fails closed without an Artifact sink and never creates the legacy tmp fallback", async () => {
		const toolCallId = `governed-no-sink-${Date.now()}`;
		const legacyPath = join("tmp", `tool-output-${toolCallId}.txt`);

		expect(() => applyToolResultBudget(
			[{ type: "text", text: "output that exceeds the governed prompt budget" }],
			8,
			toolCallId,
			"fail_closed",
		)).toThrow("ArtifactToolResultSink is not configured");
		await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
