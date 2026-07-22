import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isModelCapabilityProfile,
	isModelRouteDecision,
	isModelRouteRequest,
} from "../../../src/runtime/model-routing/schema.ts";
import type {
	ModelCapabilityProfile,
	ModelRouteDecision,
	ModelRouteRequest,
} from "../../../src/runtime/model-routing/types.ts";
import { isPlanApprovalRef, isPlanArtifactRef, isPlanModeState } from "../../../src/runtime/modes/plan/schema.ts";
import type { PlanModeState } from "../../../src/runtime/modes/plan/types.ts";
import {
	isContextAssemblyReceipt,
	isContextAssemblyRequest,
	isContextFragment,
} from "../../../src/runtime/context/schema.ts";
import type {
	ContextAssemblyReceipt,
	ContextAssemblyRequest,
	ContextFragment,
} from "../../../src/runtime/context/types.ts";
import { isCompactionCheckpoint } from "../../../src/runtime/context/compaction/schema.ts";
import type { CompactionCheckpoint } from "../../../src/runtime/context/compaction/types.ts";
import {
	isMemoryProposal,
	isMemoryRecord,
	isMemorySearchReceipt,
} from "../../../src/runtime/context/memory/schema.ts";
import type {
	MemoryProposal,
	MemoryRecord,
	MemorySearchReceipt,
} from "../../../src/runtime/context/memory/types.ts";
import { RUNTIME_EVENT_TYPES } from "../../../src/runtime/protocol/v3/events.ts";

function fixture(path: string): Record<string, unknown> {
	const value = JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture must be an object");
	return value as Record<string, unknown>;
}

describe("Plan/Context/Compaction/Memory contract consumer", () => {
	it("consumes frozen public contract modules without redefining their types", () => {
		const model = fixture("model-routing/compatible.json");
		const manifest = model.manifest as { profiles: readonly unknown[] };
		const profile = manifest.profiles[0] as ModelCapabilityProfile;
		const routeRequest = model.request as ModelRouteRequest;
		const route = model.decision as ModelRouteDecision;

		const planFixture = fixture("plan-mode/approval-resume.json");
		const plan = planFixture.state as PlanModeState;

		const contextFixture = fixture("context/assembled.json");
		const contextRequest = contextFixture.request as ContextAssemblyRequest;
		const fragment = contextRequest.fragments[0] as ContextFragment;
		const context = contextFixture.receipt as ContextAssemblyReceipt;

		const compactionFixture = fixture("compaction/multi-chain.json");
		const compaction = compactionFixture.current as CompactionCheckpoint;

		const memoryFixture = fixture("memory/lifecycle.json");
		const memory = memoryFixture.record as MemoryRecord;
		const proposal = memoryFixture.proposal as MemoryProposal;
		const search = memoryFixture.searchReceipt as MemorySearchReceipt;

		expect(isModelCapabilityProfile(profile)).toBe(true);
		expect(isModelRouteRequest(routeRequest)).toBe(true);
		expect(isModelRouteDecision(route)).toBe(true);
		expect(plan.kind === "inactive" || plan.kind === "pending_activation" ? true : isPlanArtifactRef(plan.plan)).toBe(true);
		expect(plan.kind === "awaiting_approval" ? isPlanApprovalRef(plan.approval) : true).toBe(true);
		expect(isPlanModeState(plan)).toBe(true);
		expect(isContextFragment(fragment)).toBe(true);
		expect(isContextAssemblyRequest(contextRequest)).toBe(true);
		expect(isContextAssemblyReceipt(context)).toBe(true);
		expect(isCompactionCheckpoint(compaction)).toBe(true);
		expect(isMemoryRecord(memory)).toBe(true);
		expect(isMemoryProposal(proposal)).toBe(true);
		expect(isMemorySearchReceipt(search)).toBe(true);
		expect(RUNTIME_EVENT_TYPES).toContain("compaction.completed");
	});

	it("rejects unknown fields and cross-tenant nested refs", () => {
		const model = fixture("model-routing/compatible.json");
		expect(isModelRouteDecision({ ...(model.decision as object), future: true })).toBe(false);

		const memoryFixture = fixture("memory/lifecycle.json");
		const memory = memoryFixture.record as Record<string, unknown>;
		const sources = memory.sourceRefs;
		if (!Array.isArray(sources)) throw new Error("invalid memory fixture");
		expect(isMemoryRecord({
			...memory,
			sourceRefs: [{ ...(sources[0] as object), tenantId: "tenant_other" }],
		})).toBe(false);
	});
});
