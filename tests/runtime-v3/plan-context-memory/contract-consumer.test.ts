import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isModelCapabilityProfile,
	isModelRouteDecision,
	isModelRouteRequest,
	modelRouteDecisionPreservesInputSources,
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
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";

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

	it("preserves taint evidence through context, compaction, model switch and memory v1", () => {
		const chain = fixture("taint/model-switch-chain-v1.json");
		expect(chain.stages).toEqual(["context", "compaction", "model_switch", "memory"]);
		const taintLabels = chain.taintLabels as readonly ["external_untrusted", "model_derived"];
		const model = fixture("model-routing/compatible.json");
		const request = model.request as ModelRouteRequest;
		const originalSource = request.inputSources[0];
		if (originalSource === undefined) throw new Error("model fixture has no source lineage");
		const source = { ...originalSource, trust: "tainted" as const, taintLabels };
		const routedRequest = { ...request, inputSources: [source] };
		const decision = model.decision as Exclude<ModelRouteDecision, { outcome: "deny" }>;
		const lineageDigest = canonicalDigest({ inputSources: [source], declassificationReceipts: [] });
		const conversionBody = {
			...decision.conversionReceipt,
			inputLineageDigest: lineageDigest,
			outputLineageDigest: lineageDigest,
		};
		const { receiptDigest: _receiptDigest, ...unsignedConversion } = conversionBody;
		const routedDecision: ModelRouteDecision = {
			...decision,
			inputSources: [source],
			conversionReceipt: {
				...unsignedConversion,
				receiptDigest: canonicalDigest(unsignedConversion),
			},
		};
		expect(isModelRouteRequest(routedRequest)).toBe(true);
		expect(isModelRouteDecision(routedDecision)).toBe(true);
		expect(modelRouteDecisionPreservesInputSources(routedRequest, routedDecision)).toBe(true);

		const contextFixture = fixture("context/assembled.json");
		const contextRequest = contextFixture.request as ContextAssemblyRequest;
		const fragment = {
			...contextRequest.fragments[1],
			taint: ["external_input", "model_generated"] as const,
			inputSources: [source],
		};
		expect(isContextFragment(fragment)).toBe(true);

		const compactionFixture = fixture("compaction/multi-chain.json");
		const checkpoint = compactionFixture.current as CompactionCheckpoint;
		const compacted = {
			...checkpoint,
			invariantsBefore: { ...checkpoint.invariantsBefore, inputSources: [source] },
			invariantsAfter: { ...checkpoint.invariantsAfter, inputSources: [source] },
		};
		expect(isCompactionCheckpoint(compacted)).toBe(true);

		const memoryFixture = fixture("memory/lifecycle.json");
		const memory = memoryFixture.record as MemoryRecord;
		const memorySource = memory.sourceRefs[0];
		if (memorySource === undefined) throw new Error("memory fixture has no source lineage");
		const preservedMemory = {
			...memory,
			sourceRefs: [{
				...memorySource,
				sourceDigest: source.sourceDigest,
				trust: "derived" as const,
				taint: ["external_input", "model_generated"] as const,
			}],
		};
		expect(isMemoryRecord(preservedMemory)).toBe(true);
	});
});
