/** Model Compatibility 的版本化公共数据合同；本模块不执行模型解析或切换。 */

import type {
	ArtifactRef,
	CapabilityClaim,
} from "../protocol/v3/capability.ts";
import type { ExpectedRevision } from "../protocol/v3/events.ts";
import type {
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import type { WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";

export const MODEL_ROUTING_CONTRACT_VERSION = 2 as const;

/** 当前发布物唯一允许的 pi-ai/catalog 证明基线。 */
export const PI_AI_PARITY_MANIFEST_DIGEST =
	"fcb4713c661a7de0732d9f1379bbbc0525250ebcdd7027186d076cddcd938d77" as const;
export const PI_AI_CATALOG_DIGEST =
	"14f43c2629e3aa082691c730ab7ae7c1a65ef092ad7135f52601f161fd1cded7" as const;
export const PI_AI_UPSTREAM_COMMIT =
	"3f1762cc7d3af39898aa5d21891335935011287f" as const;
export const RUNLEDGER_PARITY_BASE_COMMIT =
	"65f905452195e034c99fa5ac560a7e23a822f052" as const;

export const MODEL_CAPABILITY_ALIASES = [
	"searcher",
	"builder",
	"reviewer",
	"security_reviewer",
	"summarizer",
] as const;
export type ModelCapabilityAlias = (typeof MODEL_CAPABILITY_ALIASES)[number];

export const MODEL_TOOL_REPLAY_MODES = ["supported", "required", "unsupported"] as const;
export type ModelToolReplayMode = (typeof MODEL_TOOL_REPLAY_MODES)[number];

export const MODEL_REASONING_HISTORY_MODES = ["portable", "adapter_private", "unsupported"] as const;
export type ModelReasoningHistoryMode = (typeof MODEL_REASONING_HISTORY_MODES)[number];

export const MODEL_SWITCH_MODES = ["supported", "fork_required", "unsupported"] as const;
export type ModelSwitchMode = (typeof MODEL_SWITCH_MODES)[number];

export const MODEL_COMPACTION_STRATEGIES = ["none", "summary", "full_replace"] as const;
export type ModelCompactionStrategy = (typeof MODEL_COMPACTION_STRATEGIES)[number];

export const MODEL_PROFILE_STATUSES = ["verified", "unknown", "retired"] as const;
export type ModelProfileStatus = (typeof MODEL_PROFILE_STATUSES)[number];

export interface ModelRegressionSuiteRef {
	version: string;
	suiteDigest: string;
	passed: boolean;
	completedAt: string;
	evidence?: ArtifactRef;
}

/**
 * 每个可迁移状态面都必须有独立兼容性证明。缺失任一 hash 不是“未变化”，
 * 而是无法证明兼容，manifest loader 必须 fail closed。
 */
export interface ModelCompatibilityHashSet {
	toolHash: string;
	reasoningHash: string;
	adapterStateHash: string;
	compactionHash: string;
	contextHash: string;
	profileHash: string;
	regressionHash: string;
}

export interface ModelProfileEvidence {
	piAiParityManifestDigest: string;
	catalogDigest: string;
	upstreamCommit: string;
	runLedgerBaseCommit: string;
	catalogEntryDigest: string;
	compatibilityEvidenceDigest: string;
	evidenceDigest: string;
}

/** 一个 manifest 内可验证、可独立选择的模型能力 profile。 */
export interface ModelCapabilityProfile {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	profileId: ResourceId;
	modelId: string;
	providerId: string;
	manifestDigest: string;
	profileDigest: string;
	evidence: ModelProfileEvidence;
	compatibilityHashes: ModelCompatibilityHashSet;
	contextWindow: number;
	maxOutputTokens: number;
	apiProtocol: string;
	toolCallReplay: ModelToolReplayMode;
	reasoningHistory: ModelReasoningHistoryMode;
	midSessionSwitch: ModelSwitchMode;
	imageInput: boolean;
	compactionStrategy: ModelCompactionStrategy;
	verifiedAliases: readonly ModelCapabilityAlias[];
	capabilityClaims: readonly CapabilityClaim[];
	regressionSuite: ModelRegressionSuiteRef;
	status: ModelProfileStatus;
	verifiedByPrincipalId?: PrincipalId;
}

/** Manifest loader 的输入/输出格式；签名验证和 catalog IO 不属于此合同。 */
export interface ModelCompatibilityManifest {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	manifestId: ResourceId;
	revision: number;
	generatedAt: string;
	piAiParityManifestDigest: string;
	catalogDigest: string;
	upstreamCommit: string;
	runLedgerBaseCommit: string;
	profiles: readonly ModelCapabilityProfile[];
	manifestDigest: string;
}

export type AdapterStateDisposition = "preserve" | "drop" | "fork_required" | "deny";

/** 只描述 provider-private 状态边界，不携带私有 reasoning/cache 正文。 */
export interface ModelAdapterStateCompatibility {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sourceProfileId: ResourceId;
	targetProfileId: ResourceId;
	reasoningState: AdapterStateDisposition;
	toolReplayState: AdapterStateDisposition;
	cacheState: AdapterStateDisposition;
	stateDescriptorDigest: string;
	compatible: boolean;
}

export const MODEL_SWITCH_CONVERSION_DISPOSITIONS = [
	"preserved",
	"converted_lossless",
	"not_applicable",
	"dropped",
	"fork_required",
	"denied",
	"unproven",
] as const;
export type ModelSwitchConversionDisposition =
	(typeof MODEL_SWITCH_CONVERSION_DISPOSITIONS)[number];

export interface ModelSwitchConversionDispositions {
	reasoning: ModelSwitchConversionDisposition;
	image: ModelSwitchConversionDisposition;
	toolCallIds: ModelSwitchConversionDisposition;
	adapterPrivateState: ModelSwitchConversionDisposition;
	cache: ModelSwitchConversionDisposition;
	transport: ModelSwitchConversionDisposition;
	context: ModelSwitchConversionDisposition;
	compaction: ModelSwitchConversionDisposition;
}

/** 只记录转换处置和证明 digest，不携带 reasoning/cache/provider-private 正文。 */
export interface ModelSwitchConversionReceipt {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	receiptId: ReceiptId;
	requestId: CommandId;
	sourceProfileId?: ResourceId;
	sourceProfileDigest?: string;
	targetProfileId: ResourceId;
	targetProfileDigest: string;
	manifestDigest: string;
	dispositions: ModelSwitchConversionDispositions;
	inputLineageDigest: string;
	outputLineageDigest: string;
	conversionEvidenceDigest: string;
	receiptDigest: string;
}

export const MODEL_ROUTE_OPERATIONS = ["switch", "summarize", "compact"] as const;
export type ModelRouteOperation = (typeof MODEL_ROUTE_OPERATIONS)[number];

export const MODEL_ROUTE_DIAGNOSTIC_CODES = [
	"unknown_manifest",
	"unknown_profile",
	"retired_profile",
	"insufficient_context_window",
	"insufficient_output_budget",
	"tool_replay_incompatible",
	"reasoning_history_incompatible",
	"image_input_incompatible",
	"compaction_incompatible",
	"adapter_state_private",
	"capability_mismatch",
	"scope_mismatch",
	"compatibility_hash_mismatch",
	"parity_binding_mismatch",
	"profile_evidence_mismatch",
	"conversion_lossy",
	"conversion_unproven",
] as const;
export type ModelRouteDiagnosticCode = (typeof MODEL_ROUTE_DIAGNOSTIC_CODES)[number];

export interface ModelRouteDiagnostic {
	code: ModelRouteDiagnosticCode;
	severity: "info" | "warning" | "error";
	messageDigest: string;
	capability?: string;
}

export interface ModelRouteRequest {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: CommandId;
	sessionId: SessionId;
	operation: ModelRouteOperation;
	alias: ModelCapabilityAlias;
	fromModelId?: string;
	fromProfileId?: ResourceId;
	targetModelId?: string;
	targetProfileId?: ResourceId;
	requiredContextTokens: number;
	requiredOutputTokens: number;
	requiresToolReplay: boolean;
	requiresReasoningReplay: boolean;
	requiresImages: boolean;
	checkpointStrategy?: ModelCompactionStrategy;
	requiredCapabilities: readonly CapabilityClaim[];
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	workspace?: WorkspaceBindingRef;
	expectedRevision: ExpectedRevision;
}

interface ModelRouteDecisionBase {
	schemaVersion: typeof MODEL_ROUTING_CONTRACT_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	requestId: CommandId;
	decisionId: ReceiptId;
	targetModelId?: string;
	profileId?: ResourceId;
	manifestDigest?: string;
	profileDigest?: string;
	adapterState?: ModelAdapterStateCompatibility;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	diagnostics: readonly ModelRouteDiagnostic[];
	reason: string;
	decisionDigest: string;
}

export type ModelRouteDecision =
	| (ModelRouteDecisionBase & {
			outcome: "compatible";
			targetModelId: string;
			profileId: ResourceId;
			manifestDigest: string;
			profileDigest: string;
			conversionReceipt: ModelSwitchConversionReceipt;
	  })
	| (ModelRouteDecisionBase & {
			outcome: "fork";
			targetModelId: string;
			profileId: ResourceId;
			manifestDigest: string;
			profileDigest: string;
			conversionReceipt: ModelSwitchConversionReceipt;
			mustForkReason:
				| "provider_private_state"
				| "tool_replay_incompatible"
				| "reasoning_history_incompatible"
				| "mid_session_switch_unsupported"
				| "compatibility_hash_mismatch"
				| "conversion_lossy_or_unproven";
	  })
	| (ModelRouteDecisionBase & {
			outcome: "deny";
			missingCapabilities: readonly string[];
	  });
