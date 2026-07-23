/** 五层 Context 的版本化公共合同；排序、估算与组装行为不在本模块。 */

import type { ArtifactRef, CapabilityClaim } from "../protocol/v3/capability.ts";
import type {
	AuthorityId,
	CheckpointId,
	ContextRequestId,
	MemoryId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SessionId,
	TenantId,
	ToolCallId,
} from "../protocol/v3/ids.ts";
import type { WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";

export const CONTEXT_CONTRACT_VERSION = 1 as const;

/** 从最高治理层到当前调用层的稳定五层顺序。 */
export const CONTEXT_LAYERS = [
	"organization_policy",
	"user_memory",
	"workspace_knowledge",
	"session_memory",
	"turn_context",
] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

export const CONTEXT_TRUST_LEVELS = ["system", "user_approved", "derived", "untrusted"] as const;
export type ContextTrust = (typeof CONTEXT_TRUST_LEVELS)[number];

export const CONTEXT_TAINTS = [
	"external_input",
	"tool_output",
	"model_generated",
	"mutable_source",
	"unverified",
	"secret_candidate",
] as const;
export type ContextTaint = (typeof CONTEXT_TAINTS)[number];

interface ContextProvenanceBase {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sourceDigest: string;
	observedAt: string;
}

export type ContextProvenance =
	| (ContextProvenanceBase & { kind: "organization_policy"; policyId: ResourceId })
	| (ContextProvenanceBase & { kind: "principal"; principalId: PrincipalId })
	| (ContextProvenanceBase & { kind: "session_range"; sessionId: SessionId; fromSequence: number; toSequence: number })
	| (ContextProvenanceBase & { kind: "workspace"; workspace: WorkspaceBindingRef })
	| (ContextProvenanceBase & { kind: "artifact"; artifact: ArtifactRef })
	| (ContextProvenanceBase & { kind: "memory"; memoryId: MemoryId; recordDigest: string })
	| (ContextProvenanceBase & { kind: "tool"; toolCallId: ToolCallId; resultDigest: string });

interface ContextFragmentBase {
	schemaVersion: typeof CONTEXT_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	fragmentId: ResourceId;
	layer: ContextLayer;
	order: number;
	contentDigest: string;
	trust: ContextTrust;
	taint: readonly ContextTaint[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	priority: "required" | "high" | "normal" | "optional";
	maxTokens: number;
	maxChars: number;
	provenance: ContextProvenance;
}

export type ContextFragment =
	| (ContextFragmentBase & { storage: "inline"; content: string })
	| (ContextFragmentBase & { storage: "artifact"; artifact: ArtifactRef; excerpt?: string });

export interface ContextAssemblyBudget {
	contextWindowTokens: number;
	reservedOutputTokens: number;
	reservedToolSchemaTokens: number;
	providerSafetyTokens: number;
	maxFragments: number;
	maxTotalChars: number;
}

export interface ContextAssemblyRequest {
	schemaVersion: typeof CONTEXT_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: ContextRequestId;
	sessionId: SessionId;
	modelId: string;
	modelProfileId: ResourceId;
	workspace?: WorkspaceBindingRef;
	requiredCapabilities: readonly CapabilityClaim[];
	budget: ContextAssemblyBudget;
	fragments: readonly ContextFragment[];
}

export interface ContextFragmentReceipt {
	authorityId: AuthorityId;
	tenantId: TenantId;
	fragmentId: ResourceId;
	contentDigest: string;
	layer: ContextLayer;
	estimatedTokens: number;
	includedChars: number;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export const CONTEXT_OMISSION_REASONS = [
	"budget_exceeded",
	"fragment_cap_exceeded",
	"untrusted_for_layer",
	"taint_rejected",
	"scope_mismatch",
	"invalid_reference",
	"superseded",
] as const;
export type ContextOmissionReason = (typeof CONTEXT_OMISSION_REASONS)[number];

export interface ContextOmissionDiagnostic {
	fragmentId: ResourceId;
	layer: ContextLayer;
	reason: ContextOmissionReason;
	diagnosticDigest: string;
}

export interface ContextAssemblyReceipt {
	schemaVersion: typeof CONTEXT_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: ContextRequestId;
	receiptId: ReceiptId;
	sessionId: SessionId;
	modelId: string;
	modelProfileId: ResourceId;
	budget: ContextAssemblyBudget;
	included: readonly ContextFragmentReceipt[];
	omitted: readonly ContextOmissionDiagnostic[];
	estimatedInputTokens: number;
	contextDigest: string;
	projectionCheckpointId?: CheckpointId;
	assembledAt: string;
}
