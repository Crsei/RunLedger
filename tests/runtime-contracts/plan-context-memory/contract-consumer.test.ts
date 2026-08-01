import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { RUNTIME_EVENT_TYPES } from "../../../src/runtime/protocol/events.ts";
import { isModelRouteDecision } from "../../../src/runtime/model-routing/schema.ts";
import type { ModelRouteDecision } from "../../../src/runtime/model-routing/types.ts";
import { isPlanModeState } from "../../../src/runtime/modes/plan/schema.ts";
import type { PlanModeState } from "../../../src/runtime/modes/plan/types.ts";
import { isContextAssemblyReceipt } from "../../../src/runtime/context/schema.ts";
import type { ContextAssemblyReceipt } from "../../../src/runtime/context/types.ts";
import { isCompactionCheckpoint } from "../../../src/runtime/context/compaction/schema.ts";
import type { CompactionCheckpoint } from "../../../src/runtime/context/compaction/types.ts";
import { isMemoryRecord, isMemorySearchReceipt } from "../../../src/runtime/context/memory/schema.ts";
import type { MemoryRecord, MemorySearchReceipt } from "../../../src/runtime/context/memory/types.ts";

describe("Plan/Context/Compaction/Memory contract consumer", () => {
	it("consumes public contract modules without redefining their types", () => {
		const route: ModelRouteDecision = {
			outcome: "compatible",
			targetModelId: "fixture-model",
			reason: "verified fixture profile",
			decisionDigest: "route-digest",
		};
		const plan: PlanModeState = {
			status: "active",
			revision: 1,
			updatedAt: "2026-07-22T00:00:00.000Z",
		};
		const context: ContextAssemblyReceipt = {
			requestId: "context-request",
			modelId: "fixture-model",
			fragmentIds: ["identity"],
			omittedFragmentIds: [],
			estimatedInputTokens: 12,
			reservedOutputTokens: 8,
			contextDigest: "context-digest",
			diagnostics: [],
		};
		const compaction: CompactionCheckpoint = {
			compactionId: "compaction-fixture",
			sessionId: "session-fixture",
			reason: "manual",
			status: "completed",
			cutSequence: 4,
			retainedTailStart: 5,
			invariantDigest: "invariant-digest",
			projectionDigest: "projection-digest",
			createdAt: "2026-07-22T00:00:00.000Z",
		};
		const memory: MemoryRecord = {
			memoryId: "memory-fixture",
			scope: "workspace",
			workspaceId: "workspace-fixture",
			title: "fixture",
			body: "approved records only",
			digest: "memory-digest",
			trust: "approved",
			provenance: {
				sourceKind: "user",
				sourceRef: "user-fixture",
				sourceDigest: "source-digest",
				createdAt: "2026-07-22T00:00:00.000Z",
			},
			revocationRevision: 0,
		};
		const search: MemorySearchReceipt = {
			queryDigest: "query-digest",
			scope: "workspace",
			mode: "lexical",
			resultIds: [memory.memoryId],
			indexDigest: "index-digest",
			createdAt: "2026-07-22T00:00:00.000Z",
		};

		expect(isModelRouteDecision(route)).toBe(true);
		expect(isPlanModeState(plan)).toBe(true);
		expect(isContextAssemblyReceipt(context)).toBe(true);
		expect(isCompactionCheckpoint(compaction)).toBe(true);
		expect(isMemoryRecord(memory)).toBe(true);
		expect(isMemorySearchReceipt(search)).toBe(true);
		expect(RUNTIME_EVENT_TYPES).toContain("compaction.completed");
		expect(createRuntimeId("snapshot", "contract-consumer")).toMatch(/^snapshot_/);
	});
});
