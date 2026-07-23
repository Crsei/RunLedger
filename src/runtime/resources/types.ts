/**
 * 动态资源的 Runtime 中立合同。
 *
 * 本模块只保存版本化数据和 adapter 端口参数，不保存 loader、handler、client、
 * 进程句柄或具体 Plugin/MCP/Skill/Hook 配置。
 */

export * as resourceLegacyV1 from "./legacy-v1.ts";

import type { ArtifactRef, CapabilityClaim, CapabilityDecision } from "../protocol/v3/capability.ts";
import type { InputSourceRef } from "../protocol/v3/taint.ts";
import type {
	AuthorityId,
	CommandId,
	PrincipalId,
	ReceiptId,
	ResourceId,
	SessionId,
	SnapshotId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";

export const RESOURCE_CONTRACT_SCHEMA_VERSION = 2 as const;
export type ResourceContractSchemaVersion = typeof RESOURCE_CONTRACT_SCHEMA_VERSION;
export const RESOURCE_PROTOCOL_VERSION = 2 as const;

export const RESOURCE_KINDS = [
	"native-tool",
	"browser-tool",
	"repository-instruction",
	"user-instruction",
	"organization-instruction",
	"plugin",
	"plugin-component",
	"skill",
	"skill-body",
	"skill-assets",
	"skill-script",
	"hook",
	"mcp-server",
	"mcp-tool",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_SOURCES = ["builtin", "user", "project", "plugin", "session"] as const;
export type ResourceSource = (typeof RESOURCE_SOURCES)[number];

export const RESOURCE_TRUST_STATES = ["untrusted", "trusted", "stale", "revoked"] as const;
export type ResourceTrustState = (typeof RESOURCE_TRUST_STATES)[number];

export const RESOURCE_ACTIVATION_STATES = ["disabled", "ready", "blocked", "failed"] as const;
export type ResourceActivationState = (typeof RESOURCE_ACTIVATION_STATES)[number];

export const RESOURCE_EXPOSURES = ["direct", "deferred", "direct-model-only", "hidden"] as const;
export type ResourceExposure = (typeof RESOURCE_EXPOSURES)[number];

export const RESOURCE_EXPOSURE_CONSUMERS = [
	"root_model",
	"nested_model",
	"deferred_executor",
	"runtime_internal",
] as const;
export type ResourceExposureConsumer = (typeof RESOURCE_EXPOSURE_CONSUMERS)[number];

export const RESOURCE_RISK_LEVELS = ["low", "moderate", "high", "critical"] as const;
export type ResourceRiskLevel = (typeof RESOURCE_RISK_LEVELS)[number];

export const RESOURCE_SIDE_EFFECTS = ["none", "read", "write", "external", "privileged"] as const;
export type ResourceSideEffect = (typeof RESOURCE_SIDE_EFFECTS)[number];

export const RESOURCE_CONTENT_KINDS = ["text", "image", "resource", "json"] as const;
export type ResourceContentKind = (typeof RESOURCE_CONTENT_KINDS)[number];

export interface ResourceScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export interface ResourceAuthorizationContext extends ResourceScope {
	principalId: PrincipalId;
}

/**
 * Catalog/invoker handshake 是调用绑定，不是授权事实。peerFeatures 仅供诊断；
 * capability 与 scope 仍必须由 Gateway receipt 决定。
 */
export interface ResourceProtocolHandshake extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	protocol: "runledger.resource";
	protocolVersion: typeof RESOURCE_PROTOCOL_VERSION;
	sessionId: SessionId;
	adapterId: ResourceId;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	snapshotId: SnapshotId;
	snapshotSequence: number;
	catalogDigest: string;
	peerFeatures: readonly string[];
	handshakeDigest: string;
}

/** displayName 不在 identity 中，因而不能成为 resolve/invoke 路由键。 */
export interface ResourceIdentity extends ResourceScope {
	schemaVersion: ResourceContractSchemaVersion;
	resourceId: ResourceId;
	kind: ResourceKind;
	qualifiedId: string;
	version: string;
	source: ResourceSource;
	digest: string;
}

export interface ResourcePublisherRef extends ResourceScope {
	publisherId: string;
	identityDigest: string;
	signatureDigest: string;
}

export interface ResourceLocatorReceipt extends ResourceScope {
	schemaVersion: ResourceContractSchemaVersion;
	canonicalLocator: string;
	sourceRoot: string;
	locatorDigest: string;
	sourceRootDigest: string;
	containmentDigest: string;
	contained: true;
}

export interface ResourceProvenance extends ResourceScope {
	schemaVersion: ResourceContractSchemaVersion;
	source: ResourceSource;
	canonicalLocator: string;
	locatorReceipt: ResourceLocatorReceipt;
	publisher?: ResourcePublisherRef;
	signatureReceiptId?: ReceiptId;
	parentPlugin?: ResourceIdentity;
	provenanceBindingDigest: string;
}

/**
 * manifest/config/command/assets/capability 均是独立绑定；空内容也必须使用其
 * canonical digest，不能省略字段。
 */
export interface ResourceManifestDigest {
	schemaVersion: ResourceContractSchemaVersion;
	rootDigest: string;
	manifestDigest: string;
	configDigest: string;
	commandDigest: string;
	assetsDigest: string;
	capabilityDigest: string;
	combinedDigest: string;
}

export type ResourceApprovalScope = "session" | "project" | "user";

export interface ResourceApprovalReceipt extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	receiptId: ReceiptId;
	identity: ResourceIdentity;
	binding: ResourceManifestDigest;
	scope: ResourceApprovalScope;
	scopeBindingDigest: string;
	issuedAt: string;
	expiresAt: string | null;
	revocationRevision: number;
	locatorDigest: string;
	publisherDigest: string | null;
	policyRevision: number;
	hookRevision: number;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	approvalState: "approved";
	receiptDigest: string;
}

export interface LegacyResourceApprovalImport {
	legacySchemaVersion: 1;
	receiptId: ReceiptId;
	identityDigest: string;
	receiptDigest: string;
	state: "reapproval_required";
}

export type ResourceCapabilityBoundary =
	| {
			kind: "filesystem";
			access: "read" | "write";
			pathScopeDigest: string;
	  }
	| {
			kind: "network";
			access: "connect" | "listen";
			hostScopeDigest: string;
	  }
	| {
			kind: "process";
			access: "spawn" | "signal";
			commandScopeDigest: string;
	  }
	| {
			kind: "credential";
			access: "use";
			credentialScopeDigest: string;
	  }
	| {
			kind: "browser";
			access: "navigate" | "dom_read" | "script" | "download" | "upload" | "cookie" | "credential" | "network_egress";
			originScopeDigest: string;
	  };

export interface ResourceCapabilityDeclaration extends ResourceScope {
	capabilityId: ResourceId;
	claim: CapabilityClaim;
	boundary: ResourceCapabilityBoundary;
	required: boolean;
}

export interface ResourceRiskProfile {
	level: ResourceRiskLevel;
	sideEffect: ResourceSideEffect;
	rationaleDigest: string;
}

/** schemaJson 必须是 canonical JSON，且 schemaDigest 必须匹配。 */
export interface RuntimeInputSchemaDescriptor {
	schemaVersion: ResourceContractSchemaVersion;
	mediaType: "application/schema+json";
	schemaJson: string;
	schemaDigest: string;
	maxInputBytes: number;
}

export interface RuntimeExecutionMetadata {
	readOnly: boolean;
	destructive: boolean;
	concurrencySafe: boolean;
}

interface RuntimeResourceDescriptorCommon extends ResourceScope {
	schemaVersion: ResourceContractSchemaVersion;
	identity: ResourceIdentity;
	provenance: ResourceProvenance;
	manifest: ResourceManifestDigest;
	displayName: string;
	description: string;
	capabilities: readonly ResourceCapabilityDeclaration[];
	risk: ResourceRiskProfile;
	exposure: ResourceExposure;
	trust: ResourceTrustState;
	activation: ResourceActivationState;
	approvalReceiptId?: ReceiptId;
}

export interface RuntimeMetadataDescriptorBody extends RuntimeResourceDescriptorCommon {
	descriptorType: "metadata";
}

export interface RuntimeMetadataDescriptor extends RuntimeMetadataDescriptorBody {
	descriptorDigest: string;
}

export interface RuntimeToolDescriptorBody extends RuntimeResourceDescriptorCommon {
	descriptorType: "tool";
	runtimeName: string;
	inputSchema: RuntimeInputSchemaDescriptor;
	resultContentKinds: readonly ResourceContentKind[];
	execution: RuntimeExecutionMetadata;
}

export interface RuntimeToolDescriptor extends RuntimeToolDescriptorBody {
	descriptorDigest: string;
}

export interface RuntimeInstructionDescriptorBody extends RuntimeResourceDescriptorCommon {
	descriptorType: "instruction";
	inputSource: InputSourceRef;
	instructionDigest: string;
	priority: "repository" | "user" | "organization";
	separationOfDutyReceiptId: ReceiptId;
}

export interface RuntimeInstructionDescriptor extends RuntimeInstructionDescriptorBody {
	descriptorDigest: string;
}

export type RuntimeResourceDescriptor =
	| RuntimeMetadataDescriptor
	| RuntimeToolDescriptor
	| RuntimeInstructionDescriptor;
export type RuntimeResourceDescriptorBody =
	| RuntimeMetadataDescriptorBody
	| RuntimeToolDescriptorBody
	| RuntimeInstructionDescriptorBody;

export type SkillResourceRole = "metadata" | "body" | "assets" | "script";

export interface SkillResourceFacet {
	role: SkillResourceRole;
	identity: ResourceIdentity;
	capabilities: readonly ResourceCapabilityDeclaration[];
	snapshotId: SnapshotId;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	contentDigest: string;
	byteLength: number;
	entryCount: number;
}

/**
 * Skill 正文、资产和脚本使用不同 ResourceIdentity 与 capabilityId；读取正文
 * 不会把 script/process capability 带入调用。
 */
export interface SkillResourceSet extends ResourceScope {
	schemaVersion: ResourceContractSchemaVersion;
	qualifiedId: string;
	metadata: SkillResourceFacet;
	body: SkillResourceFacet;
	assets?: SkillResourceFacet;
	script?: SkillResourceFacet;
	budget: ResourceFacetBudget;
}

export interface ResourceFacetBudget {
	maxBytes: number;
	maxEntries: number;
}

export interface ResourceFacetReadRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshotId: SnapshotId;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	resource: ResourceIdentity;
	facet: SkillResourceRole;
	budget: ResourceFacetBudget;
}

export type ResourceFacetReadResult =
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "read";
			snapshotId: SnapshotId;
			adapterGeneration: number;
			adapterGenerationDigest: string;
			resource: ResourceIdentity;
			facet: SkillResourceRole;
			content: readonly ResourceContent[];
			contentDigest: string;
			byteLength: number;
			entryCount: number;
	  })
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "rejected";
			error: ResourcePortError;
	  });

/** 调用者输入。requestedClaims 只表示请求，不能直接用于最终授权。 */
export interface RuntimeToolInvocationRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	handshake: ResourceProtocolHandshake;
	tool: ResourceIdentity;
	snapshotId: SnapshotId;
	rawInput: unknown;
	requestedClaims: readonly CapabilityClaim[];
	correlationId: TraceId;
}

/** 由受信 Runtime adapter 对 rawInput canonicalize 并从 descriptor 推导。 */
export interface ResourceClaimDerivationReceipt extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	receiptId: ReceiptId;
	requestId: CommandId;
	handshakeDigest: string;
	snapshotId: SnapshotId;
	toolIdentityDigest: string;
	descriptorDigest: string;
	canonicalInputJson: string;
	canonicalInputDigest: string;
	inputRevision: number;
	claims: readonly CapabilityClaim[];
	claimsDigest: string;
	issuedAt: string;
	receiptDigest: string;
}

export interface ResourcePortError {
	code: "invalid_request" | "not_found" | "not_ready" | "denied" | "conflict" | "unavailable";
	messageDigest: string;
	retryable: boolean;
}

export type ResourceClaimDerivationResult =
	| {
			schemaVersion: ResourceContractSchemaVersion;
			status: "derived";
			receipt: ResourceClaimDerivationReceipt;
	  }
	| {
			schemaVersion: ResourceContractSchemaVersion;
			status: "rejected";
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			requestId: CommandId;
			error: ResourcePortError;
	  };

/** invoke 只接受已 canonicalize、已推导 claims 且 Gateway 最终 allow 的输入。 */
export interface RuntimeToolInvocation extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	handshake: ResourceProtocolHandshake;
	invocationSequence: number;
	tool: ResourceIdentity;
	snapshotId: SnapshotId;
	correlationId: TraceId;
	derivationReceipt: ResourceClaimDerivationReceipt;
	decision: Extract<CapabilityDecision, "allow">;
	authorizationReceiptId: ReceiptId;
	authorizationDecisionDigest: string;
	inputRevision: number;
	hookTransformReceiptId?: ReceiptId;
}

export interface ResourceHookPatch {
	sourceOrder: number;
	hook: ResourceIdentity;
	beforeInputDigest: string;
	afterInputDigest: string;
	patchDigest: string;
	handled: boolean;
	shortCircuit: boolean;
}

export interface ResourceHookTransformRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	handshake: ResourceProtocolHandshake;
	snapshotId: SnapshotId;
	tool: ResourceIdentity;
	inputRevision: number;
	canonicalInputJson: string;
	canonicalInputDigest: string;
	systemPromptChainDigest: string;
}

export interface ResourceHookTransformReceipt extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	receiptId: ReceiptId;
	requestId: CommandId;
	handshakeDigest: string;
	snapshotId: SnapshotId;
	inputRevision: number;
	outputRevision: number;
	originalInputDigest: string;
	updatedInputJson: string;
	updatedInputDigest: string;
	patches: readonly ResourceHookPatch[];
	handled: boolean;
	shortCircuit: boolean;
	systemPromptChainDigest: string;
	hookIdentityDigest: string;
	hookGeneration: number;
	hookGenerationDigest: string;
	claimsDigest: string;
	authorizationDecisionDigest: string;
	issuedAt: string;
	receiptDigest: string;
}

export type ResourceHookTransformResult =
	| {
			schemaVersion: ResourceContractSchemaVersion;
			status: "transformed";
			receipt: ResourceHookTransformReceipt;
	  }
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "rejected";
			error: ResourcePortError;
	  });

export interface ResourceMcpAnnotation {
	schemaVersion: ResourceContractSchemaVersion;
	server: ResourceIdentity;
	tool: ResourceIdentity;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	metadataJson: string;
	metadataDigest: string;
	byteLength: number;
	trust: "untrusted_metadata";
}

export type ResourceContent =
	| { type: "text"; text: string }
	| { type: "image"; mediaType: string; dataBase64: string; contentDigest: string }
	| { type: "resource"; uri: string; text?: string; contentDigest: string }
	| { type: "json"; canonicalJson: string; contentDigest: string };

export interface RuntimeToolResult extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	receiptId: ReceiptId;
	requestId: CommandId;
	handshakeDigest: string;
	invocationSequence: number;
	terminalSequence: number;
	terminal: "completed" | "failed" | "cancelled";
	tool: ResourceIdentity;
	snapshotId: SnapshotId;
	correlationId: TraceId;
	content: readonly ResourceContent[];
	artifact?: ArtifactRef;
	isError: boolean;
	originalBytes: number;
	truncated: boolean;
	contentDigest: string;
}

export interface RuntimeResourceInvocationProgress extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	kind: "progress";
	requestId: CommandId;
	handshakeDigest: string;
	invocationSequence: number;
	sequence: number;
	messageDigest: string;
	observedAt: string;
}

export interface RuntimeResourceInvocationTerminal extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	kind: "terminal";
	requestId: CommandId;
	handshakeDigest: string;
	invocationSequence: number;
	sequence: number;
	result: RuntimeToolResult;
}

export type RuntimeResourceInvocationFrame =
	| RuntimeResourceInvocationProgress
	| RuntimeResourceInvocationTerminal;

export interface ResourceDiagnosticSummary extends ResourceScope {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	resourceId?: ResourceId;
	detailDigest?: string;
}

export interface RuntimeResourceSnapshotBody extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	snapshotId: SnapshotId;
	adapterId: ResourceId;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	createdAt: string;
	resources: readonly RuntimeResourceDescriptor[];
	diagnostics: readonly ResourceDiagnosticSummary[];
}

export interface RuntimeResourceSnapshot extends RuntimeResourceSnapshotBody {
	digest: string;
}

/** cache ticket 只证明内容 identity 命中，不携带 trust/approval/decision。 */
export interface ResourceCacheTicketBody extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	ticketId: ReceiptId;
	snapshotId: SnapshotId;
	adapterId: ResourceId;
	adapterGeneration: number;
	adapterGenerationDigest: string;
	resourceIdentityDigest: string;
	resourceDigest: string;
	verification: "content_identity_only";
	issuedAt: string;
	expiresAt: string;
}

export interface ResourceCacheTicket extends ResourceCacheTicketBody {
	ticketDigest: string;
}

interface ResourceLifecycleEventCommon extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	identity: ResourceIdentity;
	identityDigest: string;
	snapshotId: SnapshotId;
	adapterGeneration: number;
	correlationId: TraceId;
	occurredAt: string;
}

export type ResourceLifecycleEvent =
	| (ResourceLifecycleEventCommon & { state: "discovered" })
	| (ResourceLifecycleEventCommon & { state: "approved"; receiptId: ReceiptId })
	| (ResourceLifecycleEventCommon & {
			state: "revoked";
			receiptId: ReceiptId;
			revocationRevision: number;
	  })
	| (ResourceLifecycleEventCommon & { state: "activated"; receiptId: ReceiptId })
	| (ResourceLifecycleEventCommon & {
			state: "deactivated";
			reasonCode?: string;
			reasonDigest?: string;
	  })
	| (ResourceLifecycleEventCommon & { state: "failed"; reasonCode: string; reasonDigest: string });

export interface ResourceResolveRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshotId: SnapshotId;
	identity: ResourceIdentity;
}

export type ResourceResolveResult =
	| {
			schemaVersion: ResourceContractSchemaVersion;
			status: "found";
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			requestId: CommandId;
			snapshotId: SnapshotId;
			descriptor: RuntimeResourceDescriptor;
			cacheTicket: ResourceCacheTicket;
	  }
	| {
			schemaVersion: ResourceContractSchemaVersion;
			status: "not_found";
			authorityId: AuthorityId;
			tenantId: TenantId;
			principalId: PrincipalId;
			requestId: CommandId;
			snapshotId: SnapshotId;
			identity: ResourceIdentity;
	  };

export interface ResourceSearchRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshotId: SnapshotId;
	query: string;
	limit: number;
}

export interface RuntimeResourceSearchItem {
	identity: ResourceIdentity;
	descriptorDigest: string;
	displayName: string;
	description: string;
	source: ResourceSource;
	trust: ResourceTrustState;
	activation: ResourceActivationState;
	risk: ResourceRiskLevel;
	exposure: ResourceExposure;
}

export interface ResourceSearchResult extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshotId: SnapshotId;
	queryDigest: string;
	items: readonly RuntimeResourceSearchItem[];
	truncated: boolean;
}

export interface ResourceCancellationRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	reasonDigest: string;
}

export type ResourceCancellationResult =
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "accepted";
			receiptId: ReceiptId;
	  })
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "already_terminal";
			receiptId?: ReceiptId;
	  })
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			status: "not_found";
	  });

export interface ResourceSnapshotAcquireRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	minimumGeneration?: number;
}

export interface ResourceSnapshotAcquireResult extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshot: RuntimeResourceSnapshot;
	acquisitionReceiptId: ReceiptId;
	acquiredAt: string;
}

export interface ResourceSnapshotReleaseRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	requestId: CommandId;
	snapshotId: SnapshotId;
	expectedGeneration: number;
}

export type ResourceSnapshotReleaseResult =
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			snapshotId: SnapshotId;
			status: "released";
			receiptId: ReceiptId;
	  })
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			requestId: CommandId;
			snapshotId: SnapshotId;
			status: "already_released" | "not_found" | "generation_conflict";
	  });

export interface ResourceEventEmissionRequest extends ResourceAuthorizationContext {
	schemaVersion: ResourceContractSchemaVersion;
	idempotencyKey: CommandId;
	event: ResourceLifecycleEvent;
}

export type ResourceEventEmissionResult =
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			idempotencyKey: CommandId;
			status: "emitted" | "duplicate";
			receiptId: ReceiptId;
			eventDigest: string;
	  })
	| (ResourceAuthorizationContext & {
			schemaVersion: ResourceContractSchemaVersion;
			idempotencyKey: CommandId;
			status: "rejected";
			error: ResourcePortError;
	  });
