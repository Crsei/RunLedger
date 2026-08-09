import { describe, expect, it } from "vitest";
import { AgentRunTimingTracker, projectAgentRunSummaries } from "../../../src/runtime/session-runtime/run-timing.ts";
import type { SessionEventRecord } from "../../../src/storage/session-store/session-store.ts";

describe("Session Runtime run timing", () => {
	it("uses a monotonic clock and excludes nested human waits", () => {
		let now = 10;
		const tracker = new AgentRunTimingTracker(() => now);
		expect(tracker.accept({ type: "agent_start", timestamp: 1_000, runId: "run-1" }, 1)).toMatchObject({ type: "agent_start", runId: "run-1" });
		now = 110;
		expect(tracker.pause("wait-a", "approval", 1_100)).toMatchObject({ type: "agent_work_pause", runId: "run-1", waitId: "wait-a", activeDurationMs: 100 });
		now = 160;
		expect(tracker.pause("wait-b", "credential", 1_150)).toBeUndefined();
		now = 260;
		expect(tracker.resume("wait-a", 1_250)).toBeUndefined();
		now = 310;
		expect(tracker.resume("wait-b", 1_300)).toMatchObject({ type: "agent_work_resume", runId: "run-1", waitId: "wait-b", activeDurationMs: 100 });
		now = 410;
		expect(tracker.accept({ type: "agent_end", timestamp: 1_400, runId: "run-1", stopReason: "stop", elapsedMs: 0, activeDurationMs: 0, messageCountAtEnd: 3 }, 3)).toEqual({
			type: "agent_end", timestamp: 1_400, runId: "run-1", stopReason: "stop", elapsedMs: 400, activeDurationMs: 200, messageCountAtEnd: 3,
		});
	});

	it("closes an active run as aborted without counting an open human wait", () => {
		let now = 0;
		const tracker = new AgentRunTimingTracker(() => now);
		tracker.accept({ type: "agent_start", timestamp: 2_000, runId: "run-abort" }, 0);
		now = 75;
		tracker.pause("wait", "credential", 2_075);
		now = 500;
		expect(tracker.abort(2_500, 2)).toMatchObject({ type: "agent_end", stopReason: "aborted", elapsedMs: 500, activeDurationMs: 75, messageCountAtEnd: 2 });
		expect(tracker.activeRun).toBeUndefined();
	});
});

describe("durable Agent run summary projection", () => {
	it("projects multiple runs and keeps tool-use turns inside one run", () => {
		const events = [
			event(1, { type: "agent_start", timestamp: 1_000, runId: "run-1" }),
			event(2, { type: "turn_end", timestamp: 1_100, turn: 1, stopReason: "toolUse" }),
			event(3, { type: "agent_end", timestamp: 1_300, runId: "run-1", stopReason: "stop", elapsedMs: 300, activeDurationMs: 250, messageCountAtEnd: 4 }),
			event(4, { type: "agent_start", timestamp: 2_000, runId: "run-2" }),
			event(5, { type: "agent_end", timestamp: 2_010, runId: "run-2", stopReason: "error", elapsedMs: 10, activeDurationMs: 10, messageCountAtEnd: 6 }),
		];
		expect(projectAgentRunSummaries(events, 6)).toEqual([
			expect.objectContaining({ runId: "run-1", status: "completed", stopReason: "stop", messageCountAtEnd: 4 }),
			expect.objectContaining({ runId: "run-2", status: "completed", stopReason: "error", messageCountAtEnd: 6 }),
		]);
	});

	it("infers paired legacy events but does not fabricate orphan completion markers", () => {
		const summaries = projectAgentRunSummaries([
			event(1, { type: "agent_start", timestamp: 1_000 }),
			event(2, { type: "turn_end", timestamp: 1_120, turn: 1, stopReason: "length" }),
			event(3, { type: "agent_end", timestamp: 1_125 }),
			event(4, { type: "agent_end", timestamp: 2_000 }),
			event(5, { type: "agent_start", timestamp: 3_000 }),
		], 2);
		expect(summaries).toEqual([
			expect.objectContaining({ runId: "legacy-run-1", status: "completed", stopReason: "length", activeDurationMs: 125, messageCountAtEnd: 2 }),
			expect.objectContaining({ runId: "legacy-run-5", status: "recovery_required" }),
		]);
	});
});

function event(sequence: number, payload: Record<string, unknown>): SessionEventRecord {
	return {
		sessionId: "session_timing", sequence, eventId: `event-${sequence}`, ownerGeneration: 1, eventType: "agent.event",
		payloadJson: JSON.stringify(payload), previousEventHash: sequence === 1 ? null : "a".repeat(64), currentEventHash: "b".repeat(64), createdAtMs: Number(payload.timestamp ?? 0),
	};
}
