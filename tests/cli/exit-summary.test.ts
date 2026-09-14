import { describe, expect, it } from "vitest";
import { formatExitSummary } from "../../src/cli/exit-summary.ts";
import { applyUsageObservation, createUsageAccumulator, usageSnapshot } from "../../src/runtime/usage/index.ts";

function sampleUsage() {
	return usageSnapshot(applyUsageObservation(createUsageAccumulator(), {
		id: "request",
		usage: {
			input: 41_693, output: 1_087, cacheRead: 134_400, cacheWrite: 0, reasoning: 56,
			totalTokens: 177_180,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			reported: { input: true, output: true, cacheRead: true, cacheWrite: true },
		},
	}), undefined, "idle");
}

describe("CLI exit summary", () => {
	it("prints the canonical reconnect command and cumulative usage without double-counting cache reads or reasoning", () => {
		const text = formatExitSummary({ sessionId: "session-123", resumable: true, usage: sampleUsage() });
		expect(text).toContain("Reconnect: runledger --session-id session-123");
		expect(text).toContain("total=42,780 input=41,693 (+ 134,400 cached) cache-write=0 output=1,087 (reasoning 56)");
		expect(text).toContain("The interactive turn is no longer running.");
		expect(text).not.toContain("work continues");
	});

	it("does not advertise a removed empty session or invent zero usage", () => {
		const text = formatExitSummary({ sessionId: "empty", resumable: false, usage: usageSnapshot(createUsageAccumulator(), undefined, "idle") });
		expect(text).toContain("this empty session was removed");
		expect(text).not.toContain("Reconnect:");
		expect(text).toContain("total=unknown input=unknown output=unknown");
		expect(text).not.toContain("reasoning");
	});

	it("preserves an explicit home and safely quotes shell metacharacters", () => {
		const text = formatExitSummary({ sessionId: "session-123", resumable: true, usage: sampleUsage(), runledgerDir: "/tmp/a'b $(false)" });
		expect(text).toContain("Reconnect: RUNLEDGER_DIR='/tmp/a'\\''b $(false)' runledger --session-id session-123");
	});
});
