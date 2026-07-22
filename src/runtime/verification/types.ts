/** Phase 8 独立验证流水线的稳定公共合同。 */

import type { ArtifactRef, CapabilityName, SandboxExecutionReceiptRef } from "../protocol/v3/capability.ts";
import type {
	AgentId,
	ArtifactId,
	AuthorityId,
	ChangeProposalId,
	CommandId,
	EpisodeSealId,
	FindingId,
	HumanGateId,
	PrincipalId,
	ReceiptId,
	RepositoryId,
	SessionId,
	TenantId,
	TraceId,
	VerificationId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../protocol/v3/workspace.ts";
import type { ArtifactLineageStatus } from "../artifacts/types.ts";
import type { TaintLabel } from "../protocol/v3/taint.ts";

export const VERIFICATION_SCHEMA_VERSION = 1 as const;
export const GATE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const TRUSTED_BASELINE_SCHEMA_VERSION = 1 as const;
export const VERIFIER_RECEIPT_SCHEMA_VERSION = 1 as const;
export const CHANGE_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const DRAFT_PR_RECEIPT_SCHEMA_VERSION = 1 as const;
export const HUMAN_GATE_SCHEMA_VERSION = 1 as const;
export const REVIEW_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const TEST_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const DEPENDENCY_ADMISSION_SCHEMA_VERSION = 1 as const;
export const SECRET_SCAN_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_ADMISSION_SCHEMA_VERSION = 1 as const;

export const SECRET_SCAN_SCOPES = [
	"candidate_diff",
	"tracked_workspace",
	"untracked_workspace",
	"pending_artifact",
	"generated_config",
] as const;
export type SecretScanScope = (typeof SECRET_SCAN_SCOPES)[number];

export const ADMISSION_OUTCOMES = ["passed", "blocked", "inconclusive"] as const;
export type AdmissionOutcome = (typeof ADMISSION_OUTCOMES)[number];

export const VERIFICATION_GATE_KINDS = ["build", "test", "lint", "security", "browser"] as const;
export type VerificationGateKind = (typeof VERIFICATION_GATE_KINDS)[number];

export const BROWSER_EVIDENCE_ARTIFACT_KINDS = [
	"screenshot",
	"dom_snapshot",
	"console_log",
	"network_trace",
] as const satisfies readonly ArtifactRef["kind"][];

export const VERIFICATION_OUTCOMES = ["passed", "failed", "inconclusive"] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export interface TrustedVerificationPolicy extends VerificationScope {
	schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
	policyId: string;
	policyRevision: number;
	repositoryId: RepositoryId;
	baseCommit: string;
	baseBranch: string;
	protectedRoot: string;
	gateManifestPath: string;
	expectedGateManifestDigest: string;
	gateSchemaDigest: string;
	policyDigest: string;
}

export interface TrustedBaselinePolicyRequest extends VerificationScope {
	repositoryId: RepositoryId;
	gateKey: string;
}

/** 此端口必须由受保护配置域实现，候选 workspace 不是 policy 输入。 */
export interface TrustedVerificationPolicyPort {
	resolve(request: TrustedBaselinePolicyRequest): Promise<VerificationCoreResult<TrustedVerificationPolicy>>;
}

export interface TrustedBaselineRequestContext extends VerificationScope {
	requestId: CommandId;
	principalId: PrincipalId;
	sessionId: SessionId;
	agentId: AgentId;
	traceId: TraceId;
	repositoryId: RepositoryId;
	gateKey: string;
	ownerRuntimeId: WorkspaceExecutionEnvelope["ownerRuntimeId"];
}

export interface TrustedBaselineReceipt extends VerificationScope {
	schemaVersion: typeof TRUSTED_BASELINE_SCHEMA_VERSION;
	receiptId: ReceiptId;
	policyId: string;
	policyRevision: number;
	policyDigest: string;
	repositoryId: RepositoryId;
	workspaceId: WorkspaceId;
	bindingDigest: string;
	leaseRevision: number;
	baseCommit: string;
	materializedCommit: string;
	protectedRoot: string;
	gateManifestPath: string;
	gateSchemaDigest: string;
	issuedAt: string;
	receiptDigest: string;
}

export interface TrustedGateSourceRequest {
	policy: TrustedVerificationPolicy;
	baseline: TrustedBaselineReceipt;
	protectedPath: string;
}

export interface TrustedGateDocument {
	baselineReceiptDigest: string;
	sourceCommit: string;
	protectedPath: string;
	document: unknown;
	documentDigest: string;
}

/** 只允许从 materialized trusted baseline 读取 gate document。 */
export interface TrustedGateSourcePort {
	read(request: TrustedGateSourceRequest): Promise<VerificationCoreResult<TrustedGateDocument>>;
}

export type GateArgument =
	| { kind: "literal"; value: string }
	| { kind: "candidate_path"; relativePath: string }
	| { kind: "baseline_path"; relativePath: string }
	| { kind: "artifact_output"; name: string };

export interface GateEnvironmentValue {
	name: string;
	source: "fixed" | "trusted_runner";
	value?: string;
}

export interface GateExpectedArtifact {
	name: string;
	kind: ArtifactRef["kind"];
	mediaType: string;
	schemaDigest: string;
	required: boolean;
	maxBytes: number;
}

export interface DependencyRegistrySource {
	registryId: string;
	source: string;
	identityDigest: string;
}

export const DEPENDENCY_ADMISSION_REASON_CODES = [
	"collector_unavailable",
	"coverage_incomplete",
	"evidence_truncated",
	"integrity_digest_missing",
	"integrity_digest_mismatch",
	"lifecycle_script_present",
	"lockfile_digest_mismatch",
	"lockfile_entry_missing",
	"lockfile_missing",
	"policy_mismatch",
	"publish_time_missing",
	"publish_time_invalid",
	"registry_identity_mismatch",
	"registry_not_allowed",
	"source_not_allowed",
	"cooling_period_active",
] as const;
export type DependencyAdmissionReasonCode = (typeof DEPENDENCY_ADMISSION_REASON_CODES)[number];

export interface DependencyAdmissionException {
	exceptionId: string;
	packageName: string;
	version: string;
	registryIdentityDigest: string;
	allowedReasonCodes: readonly Exclude<DependencyAdmissionReasonCode, "lifecycle_script_present" | "collector_unavailable" | "coverage_incomplete" | "evidence_truncated" | "policy_mismatch">[];
	approvalReceiptDigest: string;
	reasonDigest: string;
	expiresAt: string;
}

/** 该 policy 是 GateManifest 的一部分，来源只能是 materialized trusted base。 */
export interface DependencyAdmissionPolicy {
	schemaVersion: typeof DEPENDENCY_ADMISSION_SCHEMA_VERSION;
	policyId: string;
	policyRevision: number;
	installMode: "none" | "frozen";
	lockfileSource: "none" | "trusted_baseline" | "candidate_pinned";
	lockfilePath?: string;
	lockfileDigest?: string;
	requireLockfileEntry: boolean;
	requireIntegrityDigest: boolean;
	allowedRegistries: readonly DependencyRegistrySource[];
	minimumPublishAgeMs: number;
	lifecycleScripts: "deny";
	exceptions: readonly DependencyAdmissionException[];
	maxDependencies: number;
	maxFindings: number;
	policyDigest: string;
}

export interface DependencyObservation {
	packageName: string;
	version: string;
	registryId: string;
	source: string;
	registryIdentityDigest: string;
	integrityDigest?: string;
	lockfileIntegrityDigest?: string;
	lockfileEntryDigest?: string;
	publishedAt?: string;
	lifecycleScripts: readonly string[];
	observationDigest: string;
}

/** collector 产出的覆盖证明；它不是最终准入 receipt。 */
export interface DependencyAdmissionInput extends VerificationScope {
	schemaVersion: typeof DEPENDENCY_ADMISSION_SCHEMA_VERSION;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	policyDigest: string;
	collectorId: string;
	collectorIdentityDigest: string;
	lockfile: {
		path?: string;
		observedDigest?: string;
		entryCount: number;
		complete: boolean;
	};
	manifestInventoryDigest: string;
	manifestCount: number;
	dependencies: readonly DependencyObservation[];
	truncated: boolean;
	collectedAt: string;
	evidenceDigest: string;
}

export interface DependencyAdmissionFinding {
	code: DependencyAdmissionReasonCode;
	packageName?: string;
	version?: string;
	subjectDigest: string;
}

export interface DependencyAdmissionReceipt extends VerificationScope {
	schemaVersion: typeof DEPENDENCY_ADMISSION_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	policyId: string;
	policyRevision: number;
	policyDigest: string;
	collectorId: string;
	collectorIdentityDigest: string;
	inputEvidenceDigest: string;
	outcome: AdmissionOutcome;
	dependencyCount: number;
	findings: readonly DependencyAdmissionFinding[];
	findingsTruncated: boolean;
	evaluatedAt: string;
	receiptDigest: string;
}

export interface SecretScanRule {
	ruleId: string;
	label: string;
	pattern: string;
	caseSensitive: boolean;
}

export interface SecretScanAllowlistEntry {
	allowlistId: string;
	findingDigest: string;
	approvalReceiptDigest: string;
	reasonDigest: string;
	expiresAt: string;
}

export interface SecretScanPolicy {
	schemaVersion: typeof SECRET_SCAN_SCHEMA_VERSION;
	policyId: string;
	policyRevision: number;
	rules: readonly SecretScanRule[];
	allowlist: readonly SecretScanAllowlistEntry[];
	requiredScopes: readonly SecretScanScope[];
	maxItems: number;
	maxInputBytes: number;
	maxFindings: number;
	policyDigest: string;
}

/** raw content 只存在于 scanner 调用栈，禁止写入 event、Artifact 或 telemetry。 */
export interface SecretScanContent {
	scope: SecretScanScope;
	path: string;
	content: string;
	contentDigest: string;
}

export interface SecretScanCoverage {
	scope: SecretScanScope;
	complete: boolean;
	itemCount: number;
	itemDigests: readonly string[];
	inventoryDigest: string;
}

export interface SecretScanInput extends VerificationScope {
	schemaVersion: typeof SECRET_SCAN_SCHEMA_VERSION;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	policyDigest: string;
	scannerId: string;
	scannerIdentityDigest: string;
	coverage: readonly SecretScanCoverage[];
	items: readonly SecretScanContent[];
	truncated: boolean;
	collectedAt: string;
	inventoryDigest: string;
}

export interface SecretScanFinding {
	ruleId: string;
	label: string;
	scope: SecretScanScope;
	path: string;
	line: number;
	column: number;
	locationDigest: string;
	findingDigest: string;
}

export interface SecretScanReceipt extends VerificationScope {
	schemaVersion: typeof SECRET_SCAN_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	policyId: string;
	policyRevision: number;
	policyDigest: string;
	scannerId: string;
	scannerIdentityDigest: string;
	inputInventoryDigest: string;
	outcome: AdmissionOutcome;
	coverage: readonly Omit<SecretScanCoverage, "itemDigests">[];
	findings: readonly SecretScanFinding[];
	findingsTruncated: boolean;
	reasonCodes: readonly ("scanner_unavailable" | "coverage_incomplete" | "evidence_truncated" | "policy_mismatch" | "secret_detected")[];
	evaluatedAt: string;
	receiptDigest: string;
}

export interface VerificationAdmissionBundle extends VerificationScope {
	schemaVersion: typeof VERIFICATION_ADMISSION_SCHEMA_VERSION;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	candidateCommit: string;
	dependency: DependencyAdmissionReceipt;
	secretScan: SecretScanReceipt;
	outcome: AdmissionOutcome;
	reasonCodes: readonly string[];
	bundleDigest: string;
}

export interface VerificationAdmissionInput {
	dependency: DependencyAdmissionInput;
	secretScan: SecretScanInput;
}

/** production adapter 必须覆盖 candidate、untracked、Artifact 与 generated config。 */
export interface VerificationAdmissionInputPort {
	readonly collectorId: string;
	readonly collectorIdentityDigest: string;
	collect(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationAdmissionInput>>;
}

export interface BrowserVerificationGate {
	runtime: {
		resourceId: string;
		version: string;
		identityDigest: string;
	};
	profile: {
		resourceId: string;
		identityDigest: string;
		policyDigest: string;
	};
	entryUrl: string;
	origin: string;
	stepSchemaDigest: string;
	stepsDigest: string;
	assertionSchemaDigest: string;
	trustedAssertionsDigest: string;
	networkPolicyDigest: string;
	networkEvidence: {
		maxEntries: number;
		maxBodyBytes: number;
		redactionPolicyDigest: string;
	};
}

export interface GateManifestBody {
	schemaVersion: typeof GATE_MANIFEST_SCHEMA_VERSION;
	gateId: string;
	gateVersion: number;
	kind: VerificationGateKind;
	executable: {
		source: "trusted_baseline";
		path: string;
		digest: string;
	};
	arguments: readonly GateArgument[];
	cwd: {
		source: "candidate_workspace";
		relativePath: string;
	};
	baseConfiguration: readonly {
		path: string;
		digest: string;
	}[];
	dependencyPolicy: DependencyAdmissionPolicy;
	secretScanPolicy: SecretScanPolicy;
	environment: {
		inherit: false;
		allowlist: readonly string[];
		values: readonly GateEnvironmentValue[];
	};
	sandbox: {
		profile: "read-only" | "workspace-write" | "strict" | "external";
		policyDigest: string;
		requireEnforced: boolean;
	};
	network: {
		mode: "deny" | "allowlist";
		hosts: readonly string[];
	};
	/** browser gate 必须提供，其他 gate 必须省略。 */
	browser?: BrowserVerificationGate;
	timeoutMs: number;
	expectedExitCodes: readonly number[];
	expectedArtifacts: readonly GateExpectedArtifact[];
}

export interface GateManifest extends GateManifestBody {
	manifestDigest: string;
}

export interface CandidateIdentity extends VerificationScope {
	repositoryId: RepositoryId;
	workspaceId: WorkspaceId;
	baseCommit: string;
	candidateCommit: string;
	bindingDigest: string;
}

export interface VerificationInvocation {
	schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
	requestId: CommandId;
	verificationId: VerificationId;
	gateId: string;
	gateDigest: string;
	baselineReceiptDigest: string;
	candidate: CandidateIdentity;
	executable: GateManifest["executable"];
	arguments: readonly GateArgument[];
	cwd: GateManifest["cwd"];
	baseConfiguration: GateManifest["baseConfiguration"];
	dependencyPolicy: GateManifest["dependencyPolicy"];
	secretScanPolicy: GateManifest["secretScanPolicy"];
	environment: readonly { name: string; value: string }[];
	environmentAllowlist: readonly string[];
	network: GateManifest["network"];
	browser?: BrowserVerificationGate;
	sandbox: GateManifest["sandbox"];
	timeoutMs: number;
	expectedExitCodes: readonly number[];
	expectedArtifacts: readonly GateExpectedArtifact[];
	invocationDigest: string;
}

export interface ArtifactEvidenceReceipt extends VerificationScope {
	receiptId: ReceiptId;
	requestId: CommandId;
	verificationId: VerificationId;
	outputName: string;
	artifact: ArtifactRef;
	candidateCommit: string;
	schemaDigest: string;
	validation: "valid" | "invalid" | "unavailable";
	lineageStatus: ArtifactLineageStatus;
	lineageDigest: string;
	taintUpperBound: readonly TaintLabel[];
	validatorId: PrincipalId;
	validatedAt: string;
	receiptDigest: string;
}

export interface VerificationRunnerIdentity {
	issuerId: string;
	runnerId: PrincipalId;
	version: string;
	identityDigest: string;
}

export interface VerificationExecutionEvidence extends VerificationScope {
	requestId: CommandId;
	verificationId: VerificationId;
	invocationDigest: string;
	sandboxReceipt: SandboxExecutionReceiptRef;
	exit: {
		code: number | null;
		signal: string | null;
		timedOut: boolean;
	};
	artifacts: readonly ArtifactEvidenceReceipt[];
	browserExecution?: BrowserExecutionReceipt;
	startedAt: string;
	finishedAt: string;
	runner: VerificationRunnerIdentity;
	evidenceDigest: string;
}

interface BrowserOperationReceiptBase {
	sequence: number;
	operationId: CommandId;
	operationDigest: string;
	capability: CapabilityName;
	capabilityRequestDigest: string;
	capabilityDecisionDigest: string;
	sandboxReceiptId: ReceiptId;
	sandboxInvocationDigest: string;
	sandboxReceiptDigest: string;
	backendReceiptId: ReceiptId;
	backendReceiptDigest: string;
	bindingDigest: string;
	receiptDigest: string;
}

/**
 * Browser backend 的每次可观察动作都生成独立、封闭的 correlation receipt。
 * 通用 Gateway/Sandbox receipt 只保存引用与 canonical digest，不在此复制。
 */
export type BrowserOperationReceipt =
	| (BrowserOperationReceiptBase & { kind: "launch" })
	| (BrowserOperationReceiptBase & {
			kind: "navigate";
			urlDigest: string;
			originDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "network";
			originDigest: string;
			networkPolicyDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "download";
			downloadScopeDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "cookie_credential";
			access: "cookie" | "credential";
			scopeDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "screenshot";
			outputName: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "dom_read";
			outputName: string;
			domScopeDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "console_read";
			outputName: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "network_evidence";
			outputName: string;
			boundsDigest: string;
	  })
	| (BrowserOperationReceiptBase & {
			kind: "evidence_seal";
			outputNamesDigest: string;
	  });

export interface BrowserExecutionReceipt extends VerificationScope {
	receiptId: ReceiptId;
	requestId: CommandId;
	verificationId: VerificationId;
	gateDigest: string;
	runtimeResourceId: string;
	runtimeIdentityDigest: string;
	profileResourceId: string;
	profileIdentityDigest: string;
	profilePolicyDigest: string;
	entryUrl: string;
	origin: string;
	stepSchemaDigest: string;
	stepsDigest: string;
	assertionSchemaDigest: string;
	trustedAssertionsDigest: string;
	networkPolicyDigest: string;
	candidateCommit: string;
	candidateIdentityDigest: string;
	workspaceValidationReceiptId: ReceiptId;
	workspaceValidationReceiptDigest: string;
	bindingDigest: string;
	operationReceipts: readonly BrowserOperationReceipt[];
	operationReceiptsDigest: string;
	evidenceArtifactsDigest: string;
	executedAt: string;
	receiptDigest: string;
}

export interface VerificationArtifactEvidenceRequest extends VerificationScope {
	requestId: CommandId;
	verificationId: VerificationId;
	invocationDigest: string;
	candidate: CandidateIdentity;
	expectedArtifacts: readonly GateExpectedArtifact[];
	sandboxReceipt: SandboxExecutionReceiptRef;
}

/** Sandbox 执行输出只能通过受信 Artifact adapter 回读，stdout 字符串不参与判定。 */
export interface VerificationArtifactPort {
	resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>>;
}

export interface VerificationRunnerRequest {
	manifest: GateManifest;
	baseline: TrustedBaselineReceipt;
	candidate: CandidateIdentity;
	candidateEnvelope: WorkspaceExecutionEnvelope;
	verificationId: VerificationId;
	requestId: CommandId;
}

export interface VerificationRunnerAttempt {
	invocation: VerificationInvocation;
	evidence?: VerificationExecutionEvidence;
	status: "executed" | "authorization_required" | "denied" | "unavailable";
	reasonCodes: readonly string[];
}

export interface VerificationRunnerPort {
	run(request: VerificationRunnerRequest, signal?: AbortSignal): Promise<VerificationCoreResult<VerificationRunnerAttempt>>;
}

export interface VerificationAdmissionPort {
	evaluate(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationAdmissionBundle>>;
}

export interface VerificationResultBody extends VerificationScope {
	schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
	verificationId: VerificationId;
	gateId: string;
	gateDigest: string;
	baseline: TrustedBaselineReceipt;
	candidate: CandidateIdentity;
	command: VerificationInvocation;
	admission: VerificationAdmissionBundle;
	exit: VerificationExecutionEvidence["exit"];
	artifacts: readonly ArtifactEvidenceReceipt[];
	browserExecution?: BrowserExecutionReceipt;
	startedAt: string;
	finishedAt: string;
	runner: VerificationRunnerIdentity;
	outcome: VerificationOutcome;
	reasonCodes: readonly string[];
}

export interface VerificationResult extends VerificationResultBody {
	resultDigest: string;
}

export interface VerifierSignature {
	algorithm: "ed25519" | "hmac-sha256";
	keyId: string;
	value: string;
}

export interface VerifierReceiptBody extends VerificationScope {
	schemaVersion: typeof VERIFIER_RECEIPT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	verificationId: VerificationId;
	issuerId: string;
	resultDigest: string;
	gateDigest: string;
	baselineReceiptDigest: string;
	candidateCommit: string;
	outcome: VerificationOutcome;
	issuedAt: string;
}

export interface VerifierReceipt extends VerifierReceiptBody {
	signature: VerifierSignature;
	receiptDigest: string;
}

export interface VerifierIssuerPort {
	issue(result: VerificationResult): Promise<VerificationCoreResult<VerifierReceipt>>;
}

export interface VerificationReport {
	result: VerificationResult;
	receipt: VerifierReceipt;
	reportDigest: string;
}

export interface EpisodeSealCompletionRef extends VerificationScope {
	sealId: EpisodeSealId;
	sealDigest: string;
	sealRecordDigest: string;
	manifestBodyDigest: string;
}

export interface ChangeProposalBody extends VerificationScope {
	schemaVersion: typeof CHANGE_PROPOSAL_SCHEMA_VERSION;
	proposalId: ChangeProposalId;
	sessionId: SessionId;
	createdBy: PrincipalId;
	repositoryId: RepositoryId;
	workspaceId: WorkspaceId;
	baseCommit: string;
	candidateCommit: string;
	candidateBindingDigest: string;
	proposalArtifact: ArtifactRef;
	verificationReceiptDigests: readonly string[];
	episodeSeal: EpisodeSealCompletionRef;
	createdAt: string;
}

export interface ChangeProposalRef extends ChangeProposalBody {
	proposalDigest: string;
}

export interface DraftPrRequest extends VerificationScope {
	requestId: CommandId;
	idempotencyKey: CommandId;
	requestedBy: PrincipalId;
	providerId: string;
	authorizationReceiptId: ReceiptId;
	authorizationReceiptDigest: string;
	proposal: ChangeProposalRef;
}

export interface DraftPrProviderReceipt extends VerificationScope {
	schemaVersion: typeof DRAFT_PR_RECEIPT_SCHEMA_VERSION;
	receiptId: ReceiptId;
	requestId: CommandId;
	providerId: string;
	proposalId: ChangeProposalId;
	proposalDigest: string;
	sealId: EpisodeSealId;
	sealDigest: string;
	repositoryId: RepositoryId;
	candidateCommit: string;
	draft: true;
	externalReferenceDigest: string;
	providerRevision: number;
	createdAt: string;
	receiptDigest: string;
}

/** Provider 必须把 requestId 用作远端幂等键，且只能创建 Draft PR。 */
export interface ChangeProposalProviderPort {
	createDraft(request: DraftPrRequest, signal?: AbortSignal): Promise<VerificationCoreResult<DraftPrProviderReceipt>>;
}

export interface HumanGateRequest extends VerificationScope {
	schemaVersion: typeof HUMAN_GATE_SCHEMA_VERSION;
	humanGateId: HumanGateId;
	requestId: CommandId;
	requestedBy: PrincipalId;
	action: "merge" | "deploy";
	proposal: ChangeProposalRef;
	requestedAt: string;
	requestDigest: string;
}

export interface HumanGateDecision extends VerificationScope {
	schemaVersion: typeof HUMAN_GATE_SCHEMA_VERSION;
	humanGateId: HumanGateId;
	requestId: CommandId;
	proposalId: ChangeProposalId;
	proposalDigest: string;
	action: HumanGateRequest["action"];
	decision: "approved" | "denied";
	decisionAuthority: "human" | "organization";
	decidedBy: PrincipalId;
	receiptId: ReceiptId;
	decisionReasonDigest: string;
	decidedAt: string;
	receiptDigest: string;
}

/** 决定必须由外部 human/organization coordinator 返回，Runtime 不执行 merge/deploy。 */
export interface HumanGateCoordinatorPort {
	request(request: HumanGateRequest, signal?: AbortSignal): Promise<VerificationCoreResult<void>>;
	resolve(request: HumanGateRequest, signal?: AbortSignal): Promise<VerificationCoreResult<HumanGateDecision>>;
}

export interface TrustedVerifierIssuerDescriptor {
	issuerId: string;
	environment: "production" | "test-only";
	schemaVersions: readonly number[];
	algorithms: readonly VerifierSignature["algorithm"][];
	keyIds: readonly string[];
	verify(signatureInputDigest: string, signature: VerifierSignature): boolean | Promise<boolean>;
}

export const FINDING_STATES = [
	"detected",
	"drafted",
	"verified",
	"published",
	"addressed",
	"reverified",
	"closed",
] as const;
export type FindingState = (typeof FINDING_STATES)[number];
export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface VerificationFinding extends VerificationScope {
	findingId: FindingId;
	verificationId: VerificationId;
	gateDigest: string;
	baseCommit: string;
	candidateCommit: string;
	source: "deterministic_gate" | "llm_review" | "security_review";
	state: FindingState;
	severity: FindingSeverity;
	policyClass: string;
	summaryDigest: string;
	evidenceArtifactIds: readonly ArtifactId[];
	confirmation: "candidate" | "verified" | "inconclusive";
	revision: number;
}

export interface FindingTransitionRequest {
	to: FindingState;
	expectedRevision: number;
	evidenceDigest: string;
	verification?: VerificationReport;
	candidateCommit?: string;
}

export interface FindingBlockingPolicy {
	blockingSeverities: readonly FindingSeverity[];
	blockingPolicyClasses: readonly string[];
}

export interface RemediationBudget {
	maxRounds: number;
	maxCostUsd: number;
	maxDurationMs: number;
}

export interface RemediationState {
	findingId: FindingId;
	startedAt: string;
	roundsCompleted: number;
	costUsd: number;
	durationMs: number;
	status: "ready" | "round_active" | "awaiting_reverification" | "succeeded" | "exhausted";
	lastCandidateCommit?: string;
	lastVerificationReceiptDigest?: string;
}

export interface ReviewerProfile {
	role: "builder" | "test_generator" | "reviewer" | "security_reviewer";
	readOnly: boolean;
	freshContext: boolean;
	startsFrom: "task" | "tests" | "diff";
	writeScope: "workspace" | "tests_only" | "none";
	network: "policy" | "deny";
}

export interface ReviewDiffReadProof {
	readonly candidateCommit: string;
	readonly diffArtifactReceiptDigest: string;
	readonly complete: boolean;
	readonly readHunkDigests: readonly string[];
	readonly proofIssuerId: PrincipalId;
	readonly proofDigest: string;
}

export interface ReviewInspectedFile {
	readonly path: string;
	readonly contentDigest: string;
	readonly inspectionDigest: string;
}

export interface ReviewReverseAuditHypothesis {
	readonly hypothesisDigest: string;
	readonly evidenceArtifactIds: readonly ArtifactId[];
}

export interface ReviewEvidenceBody extends VerificationScope {
	readonly schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
	readonly reviewId: CommandId;
	readonly reviewerId: PrincipalId;
	readonly reviewerProfile: ReviewerProfile;
	readonly candidate: CandidateIdentity;
	readonly trustedBaselineReceiptDigest: string;
	readonly diffArtifact: ArtifactEvidenceReceipt;
	readonly diffReadProof: ReviewDiffReadProof;
	readonly inspectedFiles: readonly ReviewInspectedFile[];
	readonly verificationArtifacts: readonly ArtifactEvidenceReceipt[];
	readonly reverseAuditHypotheses: readonly ReviewReverseAuditHypothesis[];
	readonly verdict: "approve" | "request_changes" | "inconclusive";
	readonly producedAt: string;
}

/** canonical digest 使 ReviewEvidence 在写入 Artifact 前后保持不可变。 */
export interface ReviewEvidence extends ReviewEvidenceBody {
	readonly evidenceDigest: string;
}

export const VERIFICATION_ERROR_CODES = [
	"invalid_schema",
	"invalid_digest",
	"scope_mismatch",
	"baseline_unavailable",
	"untrusted_gate",
	"workspace_invalid",
	"authorization_required",
	"authorization_denied",
	"sandbox_unavailable",
	"evidence_unavailable",
	"artifact_invalid",
	"untrusted_issuer",
	"invalid_signature",
	"stale_evidence",
	"cross_commit_evidence",
	"invalid_transition",
	"budget_exhausted",
	"terminal_not_ready",
	"lifecycle_paused",
	"provider_unavailable",
	"human_gate_required",
	"admission_blocked",
	"admission_unavailable",
] as const;

export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export interface VerificationError {
	code: VerificationErrorCode;
	message: string;
	retryable: boolean;
	details?: Readonly<Record<string, string | number | boolean>>;
	/** fail-closed admission 失败也必须返回 typed receipt，不能只写日志。 */
	admission?: VerificationAdmissionBundle;
}

export type VerificationCoreResult<T> = { ok: true; value: T } | { ok: false; error: VerificationError };

export interface VerificationPipelineRequest extends TrustedBaselineRequestContext {
	verificationId: VerificationId;
	runnerRequestId: CommandId;
	candidate: CandidateIdentity;
	candidateEnvelope: WorkspaceExecutionEnvelope;
}

/** 生产流水线必须通过该端口把 started/report/finished 接入 canonical Runtime。 */
export interface VerificationPipelineJournalPort {
	resolveExisting(
		request: VerificationPipelineRequest,
	): Promise<VerificationCoreResult<VerificationReport | undefined>>;
	recordStarted(
		request: VerificationPipelineRequest,
		manifest: GateManifest,
		baseline: TrustedBaselineReceipt,
	): Promise<VerificationCoreResult<void>>;
	recordFinished(
		request: VerificationPipelineRequest,
		report: VerificationReport,
	): Promise<VerificationCoreResult<void>>;
}
