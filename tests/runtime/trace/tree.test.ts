import { describe, expect, it } from "vitest";
import { TraceTreeProjection } from "../../../src/runtime/trace/tree.ts";
import type { TraceEvent } from "../../../src/runtime/trace/types.ts";

function event(overrides: Partial<TraceEvent> = {}): TraceEvent {
	return {
		eventId: "event_1",
		traceId: "trace_demo",
		nodeId: "trace_demo",
		parentNodeId: null,
		kind: "trace",
		name: "agent.run",
		phase: "started",
		timestamp: "2026-08-02T00:00:00.000Z",
		sequence: 1,
		previousEventHash: null,
		eventHash: "hash_1",
		...overrides,
	};
}

describe("TraceTreeProjection", () => {
	it("reconstructs model and tool nodes by explicit parent IDs", () => {
		const projection = new TraceTreeProjection();
		projection.apply(event());
		projection.apply(event({ eventId: "event_2", sequence: 2, eventHash: "hash_2", nodeId: "turn_1", parentNodeId: "trace_demo", kind: "turn", name: "turn", phase: "started" }));
		projection.apply(event({ eventId: "event_3", sequence: 3, eventHash: "hash_3", nodeId: "model_1", parentNodeId: "turn_1", kind: "model", name: "deepseek", phase: "started" }));
		projection.apply(event({ eventId: "event_4", sequence: 4, eventHash: "hash_4", nodeId: "tool_1", parentNodeId: "model_1", kind: "tool", name: "read", phase: "finished", durationMs: 18 }));

		const tree = projection.tree("trace_demo");
		expect(tree?.children[0]?.children[0]?.children[0]).toMatchObject({ nodeId: "tool_1", durationMs: 18, phase: "finished" });
	});

	it("keeps an out-of-order node as an orphan instead of guessing a parent", () => {
		const projection = new TraceTreeProjection();
		projection.apply(event({ nodeId: "tool_1", parentNodeId: "missing_model", kind: "tool", name: "read" }));

		expect(projection.tree("trace_demo")).toBeUndefined();
		expect(projection.orphans("trace_demo").map((node) => node.nodeId)).toEqual(["tool_1"]);
	});
});
