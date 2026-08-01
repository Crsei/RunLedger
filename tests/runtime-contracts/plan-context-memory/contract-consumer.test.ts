import { describe, expect, it } from "vitest";
import { isCompactionCheckpoint } from "../../../src/runtime/context/compaction/schema.ts";
import type { CompactionCheckpoint } from "../../../src/runtime/context/compaction/types.ts";
import { isMemoryRecord, isMemorySearchReceipt } from "../../../src/runtime/context/memory/schema.ts";
import type { MemoryRecord, MemorySearchReceipt } from "../../../src/runtime/context/memory/types.ts";
import { isContextAssemblyReceipt } from "../../../src/runtime/context/schema.ts";
import type { ContextAssemblyReceipt } from "../../../src/runtime/context/types.ts";
import { isModelRouteDecision } from "../../../src/runtime/model-routing/schema.ts";
import type { ModelRouteDecision } from "../../../src/runtime/model-routing/types.ts";
import { isPlanModeState } from "../../../src/runtime/modes/plan/schema.ts";
import type { PlanModeState } from "../../../src/runtime/modes/plan/types.ts";
import { RUNTIME_EVENT_TYPES } from "../../../src/runtime/protocol/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";

const digest = { algorithm: "sha256", digest: "8".repeat(64) } as const;
const sessionId = createRuntimeId("session", "contract-consumer");
const sourceHead = { streamId: sessionId, sequence: 4, eventHash: digest } as const;
const sourceRange = {
	stream: { scope: "session", streamId: sessionId, sessionId },
	startSequence: 0,
	endSequence: 4,
	head: sourceHead,
	rangeDigest: digest,
	complete: true,
} as const;

describe("Plan/Context/Compaction/Memory contract consumer", () => {
	it("consumes public contract modules without redefining their types", () => {
		const requestId = createRuntimeId("command", "contract-consumer");
		const route: ModelRouteDecision = {
			requestId,
			outcome: "compatible",
			targetProviderId: "fixture-provider",
			targetModelId: "fixture-model",
			targetProfileId: "fixture-profile",
			manifestDigest: digest,
			reasonCode: "verified_fixture_profile",
			diagnostics: [],
			decisionDigest: digest,
		};
		const goalId = createRuntimeId("goal", "contract-consumer");
		const plan: PlanModeState = {
			status: "active",
			sessionId,
			goalId,
			revision: 1,
			policyCeilingDigest: digest,
			sourceHead,
			projectionDigest: digest,
			completeness: "complete",
			updatedAt: "2026-07-22T00:00:00.000Z",
		};
		const context: ContextAssemblyReceipt = {
			requestId,
			modelProfileId: "fixture-profile",
			fragmentIds: ["identity"],
			omittedFragments: [],
			estimatedInputTokens: 12,
			reservedOutputTokens: 8,
			contextDigest: digest,
			diagnostics: [],
			sourceHead,
			projectionDigest: digest,
			assembledAt: "2026-07-22T00:00:00.000Z",
		};
		const compaction: CompactionCheckpoint = {
			compactionId: createRuntimeId("snapshot", "contract-consumer"),
			sessionId,
			reason: "manual",
			status: "completed",
			sourceRange,
			replacementArtifactRef: { subjectKind: "artifact", digest },
			invariantDigest: digest,
			attempt: 1,
			terminalReceiptRef: { subjectKind: "receipt", digest },
			projectionDigest: digest,
			completeness: "complete",
			createdAt: "2026-07-22T00:00:00.000Z",
		};
		const memoryId = createRuntimeId("memory", "contract-consumer");
		const memory: MemoryRecord = {
			memoryId,
			scope: "workspace",
			workspaceId: createRuntimeId("workspace", "contract-consumer"),
			title: "fixture",
			contentDigest: digest,
			contentRef: { subjectKind: "content", digest },
			revision: 1,
			trust: "approved",
			provenance: {
				sourceKind: "user",
				sourceRef: { subjectKind: "receipt", digest },
				sourceDigest: digest,
				createdAt: "2026-07-22T00:00:00.000Z",
			},
			revocationRevision: 0,
		};
		const search: MemorySearchReceipt = {
			receiptId: createRuntimeId("receipt", "memory-search"),
			queryDigest: digest,
			scope: "workspace",
			workspaceId: memory.workspaceId,
			mode: "lexical",
			resultIds: [memoryId],
			indexDigest: digest,
			sourceHead,
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
