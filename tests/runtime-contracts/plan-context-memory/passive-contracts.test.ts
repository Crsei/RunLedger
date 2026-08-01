import { describe, expect, it } from "vitest";
import { isCompactionCheckpoint } from "../../../src/runtime/context/compaction/schema.ts";
import {
	isMemoryProposal,
	isMemoryRecord,
	isMemorySearchReceipt,
} from "../../../src/runtime/context/memory/schema.ts";
import {
	isContextAssemblyReceipt,
	isContextAssemblyRequest,
	isContextFragment,
} from "../../../src/runtime/context/schema.ts";
import {
	isModelCapabilityProfile,
	isModelRouteDecision,
	isModelRouteRequest,
} from "../../../src/runtime/model-routing/schema.ts";
import {
	isPlanApprovalRef,
	isPlanArtifactRef,
	isPlanModeState,
} from "../../../src/runtime/modes/plan/schema.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";

const digest = { algorithm: "sha256", digest: "7".repeat(64) } as const;
const sourceHead = {
	streamId: createRuntimeId("session", "pcm"),
	sequence: 9,
	eventHash: digest,
} as const;
const contentRef = { subjectKind: "content", digest, mediaType: "text/plain", size: 256 } as const;

describe("Model, plan, context, compaction, and memory passive contracts", () => {
	it("freezes exact model profiles and correlated route decisions", () => {
		const profile = {
			profileId: "deepseek-v4-governed",
			providerId: "deepseek",
			modelId: "deepseek-v4",
			manifestVersion: "2026-08-02",
			manifestDigest: digest,
			contextWindow: 128_000,
			maxOutputTokens: 8_192,
			reasoningProtocol: "native",
			toolProtocol: "json",
			imageInput: false,
			compaction: "summary",
			status: "verified",
			adapterStateRef: { subjectKind: "receipt", digest },
		};
		const request = {
			requestId: createRuntimeId("command", "model-route"),
			operation: "switch",
			sourceProfileId: "deepseek-previous-governed",
			targetProfileId: profile.profileId,
			contextDigest: digest,
			planDigest: digest,
			resourceDigest: digest,
			requiredContextTokens: 4_000,
			requiredOutputTokens: 1_000,
			requiresTools: true,
			requiresReasoningReplay: false,
			requiresImages: false,
			traceId: createRuntimeId("trace", "model-route"),
		};
		const decision = {
			requestId: request.requestId,
			outcome: "compatible",
			targetProviderId: profile.providerId,
			targetModelId: profile.modelId,
			targetProfileId: profile.profileId,
			manifestDigest: digest,
			reasonCode: "profile_verified",
			diagnostics: [],
			decisionDigest: digest,
		};

		expect(isModelCapabilityProfile(profile)).toBe(true);
		expect(isModelCapabilityProfile({ ...profile, privateProviderState: { token: "secret" } })).toBe(false);
		expect(isModelRouteRequest(request)).toBe(true);
		expect(isModelRouteDecision(decision)).toBe(true);
		expect(isModelRouteDecision({ ...decision, outcome: "fork" })).toBe(false);
	});

	it("binds plan state to artifact, approval, policy, and source-head refs", () => {
		const plan = {
			goalId: createRuntimeId("goal", "pcm"),
			workspaceId: createRuntimeId("workspace", "pcm"),
			revision: 2,
			digest,
			artifactRef: { subjectKind: "artifact", digest, mediaType: "text/markdown", size: 256 },
		};
		const approval = {
			approvalId: createRuntimeId("approval", "plan"),
			goalId: plan.goalId,
			revision: 2,
			digest,
			status: "approved",
			receiptRef: { subjectKind: "receipt", digest },
		};
		const state = {
			status: "active",
			sessionId: createRuntimeId("session", "pcm"),
			goalId: plan.goalId,
			revision: 2,
			plan,
			approval,
			policyCeilingDigest: digest,
			sourceHead,
			projectionDigest: digest,
			completeness: "complete",
			updatedAt: "2026-08-02T00:00:00.000Z",
		};

		expect(isPlanArtifactRef(plan)).toBe(true);
		expect(isPlanApprovalRef(approval)).toBe(true);
		expect(isPlanModeState(state)).toBe(true);
		expect(isPlanModeState({ ...state, planText: "unbounded plan" })).toBe(false);
		expect(isPlanModeState({ ...state, grantsCapability: true })).toBe(false);
	});

	it("uses ordered context descriptors and bounded diagnostics instead of raw prompt content", () => {
		const fragment = {
			fragmentId: "identity",
			layer: "identity",
			order: 0,
			contentRef,
			contentDigest: digest,
			estimatedTokens: 24,
			trust: "trusted",
			taint: "none",
			priority: "required",
		};
		const request = {
			requestId: createRuntimeId("command", "context"),
			modelProfileId: "deepseek-v4-governed",
			contextWindow: 128_000,
			outputReserve: 8_192,
			toolReserve: 2_048,
			fragments: [fragment],
			traceId: createRuntimeId("trace", "context"),
		};
		const receipt = {
			requestId: request.requestId,
			modelProfileId: request.modelProfileId,
			fragmentIds: [fragment.fragmentId],
			omittedFragments: [],
			estimatedInputTokens: 24,
			reservedOutputTokens: 8_192,
			contextDigest: digest,
			diagnostics: [{ code: "context_ready", severity: "info", message: "assembled" }],
			sourceHead,
			projectionDigest: digest,
			assembledAt: "2026-08-02T00:00:00.000Z",
		};

		expect(isContextFragment(fragment)).toBe(true);
		expect(isContextFragment({ ...fragment, content: "private prompt" })).toBe(false);
		expect(isContextAssemblyRequest(request)).toBe(true);
		expect(isContextAssemblyReceipt(receipt)).toBe(true);
		expect(isContextAssemblyReceipt({
			...receipt,
			diagnostics: [{ code: "oversize", severity: "error", message: "x".repeat(2049) }],
		})).toBe(false);
	});

	it("binds compaction terminal state to an event range and terminal receipt", () => {
		const checkpoint = {
			compactionId: createRuntimeId("snapshot", "compaction"),
			sessionId: createRuntimeId("session", "pcm"),
			reason: "manual",
			status: "completed",
			sourceRange: {
				stream: { scope: "session", streamId: createRuntimeId("session", "pcm"), sessionId: createRuntimeId("session", "pcm") },
				startSequence: 0,
				endSequence: 9,
				head: sourceHead,
				rangeDigest: digest,
				complete: true,
			},
			replacementArtifactRef: { subjectKind: "artifact", digest },
			invariantDigest: digest,
			attempt: 1,
			terminalReceiptRef: { subjectKind: "receipt", digest },
			projectionDigest: digest,
			completeness: "complete",
			createdAt: "2026-08-02T00:00:00.000Z",
		};

		expect(isCompactionCheckpoint(checkpoint)).toBe(true);
		expect(isCompactionCheckpoint({ ...checkpoint, terminalReceiptRef: undefined })).toBe(false);
		expect(isCompactionCheckpoint({ ...checkpoint, summary: "unbounded model output" })).toBe(false);
	});

	it("stores memory content by ref with provenance, revision, and scoped search receipts", () => {
		const record = {
			memoryId: createRuntimeId("memory", "pcm"),
			scope: "workspace",
			workspaceId: createRuntimeId("workspace", "pcm"),
			title: "Approved convention",
			contentDigest: digest,
			contentRef,
			revision: 3,
			trust: "approved",
			provenance: {
				sourceKind: "user",
				sourceRef: { subjectKind: "receipt", digest },
				sourceDigest: digest,
				createdAt: "2026-08-02T00:00:00.000Z",
			},
			approvedAt: "2026-08-02T00:01:00.000Z",
			revocationRevision: 0,
		};
		const proposal = {
			proposalId: createRuntimeId("proposal", "memory"),
			memoryId: record.memoryId,
			scope: record.scope,
			recordDigest: digest,
			status: "approved",
			approvalRef: { subjectKind: "receipt", digest },
			createdAt: "2026-08-02T00:00:00.000Z",
		};
		const search = {
			receiptId: createRuntimeId("receipt", "memory-search"),
			queryDigest: digest,
			scope: "workspace",
			workspaceId: record.workspaceId,
			mode: "lexical",
			resultIds: [record.memoryId],
			indexDigest: digest,
			sourceHead,
			createdAt: "2026-08-02T00:02:00.000Z",
		};

		expect(isMemoryRecord(record)).toBe(true);
		expect(isMemoryRecord({ ...record, body: "raw memory" })).toBe(false);
		expect(isMemoryProposal(proposal)).toBe(true);
		expect(isMemorySearchReceipt(search)).toBe(true);
		expect(isMemorySearchReceipt({ ...search, resultIds: Array.from({ length: 257 }, () => record.memoryId) })).toBe(false);
	});
});
