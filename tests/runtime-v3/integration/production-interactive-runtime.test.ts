import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../../../src/models.ts";
import type { Api, Model } from "../../../src/types.ts";
import { ArtifactAccessService } from "../../../src/runtime/artifacts/access.ts";
import type {
	ArtifactAccessLogPort,
	ArtifactCapabilityGatewayPort,
	ArtifactResult,
} from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { InputSourceRef } from "../../../src/runtime/protocol/v3/taint.ts";
import { workspaceBindingDigest } from "../../../src/runtime/protocol/v3/workspace.ts";
import { projectExternalReceiptReferences } from "../../../src/runtime/lifecycle/canonical-references.ts";
import { createProductionCapabilityGrantPolicy } from "../../../src/runtime/agents/integration/capability-subset.ts";
import { ProductionChildSessionLauncher } from "../../../src/runtime/agents/integration/child-session-launcher.ts";
import type { ParentCapabilityGrantRef } from "../../../src/runtime/agents/types.ts";
import type { SessionMutationAdmissionGatePort } from "../../../src/runtime/lifecycle/mutation-gate.ts";
import {
	createExternalReceiptAuditReceipt,
	type ExternalReceiptAuditReceipt,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
} from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import type { SecuritySnapshot } from "../../../src/security/types.ts";
import type {
	EnterprisePortResult,
	CredentialAudienceBindingRef,
	CredentialAudienceBindingRequest,
} from "../../../src/runtime/identity/enterprise-types.ts";
import type { CredentialAudienceBindingResolverPort } from "../../../src/security/integration/credential-broker-adapter.ts";
import { MemoryCapabilityRateLimiter } from "../../../src/security/integration/capability-rate-limiter.ts";
import { PortBackedToolExecutionGateway } from "../../../src/security/integration/tool-execution-gateway.ts";
import { MemoryApprovalStateStore } from "../../../src/security/permission/approval-coordinator.ts";
import {
	createProductionToolManifest,
	type ToolInvocationInputClassificationPort,
} from "../../../src/security/integration/production-tool-components.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessResult,
} from "../../../src/security/sandbox/types.ts";
import type { SecurityResult } from "../../../src/security/types.ts";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../src/runtime/orchestrator/budget-guard.ts";
import { LoopBreaker } from "../../../src/runtime/orchestrator/loop-breaker.ts";
import type { OperationBindings } from "../../../src/runtime/orchestrator/types.ts";
import type {
	AgentTool,
	ToolExecutionAuthorizationGrant,
	ToolExecutionGatewayRequest,
} from "../../../src/runtime/types.ts";
import { TrustedBaselineCoordinator } from "../../../src/runtime/verification/baseline.ts";
import { VerificationPipeline } from "../../../src/runtime/verification/pipeline.ts";
import { TrustedVerifierIssuerRegistry } from "../../../src/runtime/verification/security.ts";
import type {
	TrustedGateSourcePort,
	TrustedVerificationPolicyPort,
	VerificationRunnerPort,
	VerifierIssuerPort,
} from "../../../src/runtime/verification/types.ts";
import type { WorkspaceServicePort } from "../../../src/runtime/protocol/v3/workspace.ts";
import type { ProductionVerificationServices } from "../../../src/runtime/integration/production-session-runtime.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import {
	createProductionInteractiveRuntime,
	type ProductionInteractiveInitialBindingsInput,
	type ProductionInteractiveRuntimeOptions,
} from "../../../src/storage/production-interactive-runtime.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import { createV3SessionMutationAdmissionGate } from "../../../src/storage/v3-runtime-adapter.ts";
import { WorktreeManager } from "../../../src/worktree/manager.ts";
import type { WorktreeCreateResult } from "../../../src/worktree/types.ts";
import type { WorktreeForensicAuthorizationPort } from "../../../src/worktree/ports.ts";
import { createArtifactHarness, type ArtifactHarness, NOW } from "../artifacts/helpers.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "../../worktree/fixtures.ts";

const NOW_DATE = new Date(NOW);
const AUDIENCE_DIGEST = canonicalDigest("production interactive audience");
const RATE_LIMIT_ID = createRuntimeId("rateLimit", "production-interactive");
const TOOL_SCHEMA = Type.Object({ path: Type.String() });

const worktrees: WorktreeTestHarness[] = [];
const artifacts: ArtifactHarness[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	for (const harness of worktrees.splice(0)) await harness.cleanup();
	for (const harness of artifacts.splice(0)) await harness.cleanup();
});

type CapturedWorkspaceBind = Pick<WorktreeCreateResult, "runtimeBinding" | "lease" | "receiptId">;

interface WorkspaceOperationCapture {
	readonly bindings: CapturedWorkspaceBind[];
	readonly releaseReceiptIds: WorktreeCreateResult["receiptId"][];
}

type MutationAdmissionRequest = Parameters<SessionMutationAdmissionGatePort["revalidate"]>[0];

class RejectingRecordingMutationGate implements SessionMutationAdmissionGatePort {
	public readonly requests: MutationAdmissionRequest[] = [];

	public async revalidate(
		request: MutationAdmissionRequest,
	): Promise<Awaited<ReturnType<SessionMutationAdmissionGatePort["revalidate"]>>> {
		this.requests.push(structuredClone(request));
		return {
			ok: false,
			error: {
				code: "external_unavailable",
				message: "production mutation gate rejected the operation",
				retryable: false,
			},
		};
	}
}

class ExactExternalReceiptAuditor implements StartupExternalReceiptAuditPort {
	public async auditWorkspaceLease(
		sessionId: ReturnType<typeof createRuntimeId<"session">>,
		lease: Parameters<StartupExternalReceiptAuditPort["auditWorkspaceLease"]>[1],
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		const subjectDigest = canonicalDigest(lease);
		return {
			ok: true,
			value: createExternalReceiptAuditReceipt({
				authorityId: lease.authorityId,
				tenantId: lease.tenantId,
				sessionId,
				subjectKind: "workspace_lease",
				subjectId: lease.leaseId,
				subjectDigest,
				authoritativeDigest: subjectDigest,
				observedRevision: lease.leaseRevision,
				status: "valid",
				outcomeReason: "exact_match",
				checkedAt: NOW,
				validThrough: null,
			}),
		};
	}

	public async auditApprovalDecision(
		sessionId: ReturnType<typeof createRuntimeId<"session">>,
		receipt: ApprovalReceiptRef,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		const subjectDigest = canonicalDigest(receipt);
		return {
			ok: true,
			value: createExternalReceiptAuditReceipt({
				authorityId: receipt.authorityId,
				tenantId: receipt.tenantId,
				sessionId,
				subjectKind: "approval_decision",
				subjectId: receipt.receiptId,
				subjectDigest,
				authoritativeDigest: subjectDigest,
				observedRevision: receipt.decisionRevision,
				status: "valid",
				outcomeReason: "exact_match",
				checkedAt: NOW,
				validThrough: receipt.expiresAt ?? null,
			}),
		};
	}
}

/** Production composition 丢弃了 adapter receipt，因此测试只截取可持久化 refs，不保留 raw fencing token。 */
function captureWorkspaceOperations(): WorkspaceOperationCapture {
	const capture: WorkspaceOperationCapture = { bindings: [], releaseReceiptIds: [] };
	const bindSource = WorktreeManager.prototype.bindSource;
	const resume = WorktreeManager.prototype.resume;
	const release = WorktreeManager.prototype.release;
	vi.spyOn(WorktreeManager.prototype, "bindSource").mockImplementation(async function (request) {
		const result = await bindSource.call(this, request);
		if (result.ok) {
			capture.bindings.push({
				runtimeBinding: structuredClone(result.value.runtimeBinding),
				lease: structuredClone(result.value.lease),
				receiptId: result.value.receiptId,
			});
		}
		return result;
	});
	vi.spyOn(WorktreeManager.prototype, "resume").mockImplementation(async function (
		workspaceId,
		context,
		ownerRuntimeId,
	) {
		const result = await resume.call(this, workspaceId, context, ownerRuntimeId);
		if (result.ok) {
			capture.bindings.push({
				runtimeBinding: structuredClone(result.value.runtimeBinding),
				lease: structuredClone(result.value.lease),
				receiptId: result.value.receiptId,
			});
		}
		return result;
	});
	vi.spyOn(WorktreeManager.prototype, "release").mockImplementation(async function (request) {
		const result = await release.call(this, request);
		if (result.ok) capture.releaseReceiptIds.push(result.value.receiptId);
		return result;
	});
	return capture;
}

async function canonicalEvents(manager: V3SessionManager): Promise<readonly RuntimeEventV3[]> {
	const replay = await readAllRuntimeEvents(manager.eventStore());
	if (!replay.ok) throw new Error(`canonical event replay failed: ${replay.error.message}`);
	return replay.value;
}

function eventsOfType<TType extends RuntimeEventV3["type"]>(
	events: readonly RuntimeEventV3[],
	type: TType,
): readonly Extract<RuntimeEventV3, { type: TType }>[] {
	return events.filter((event) => event.type === type) as readonly Extract<RuntimeEventV3, { type: TType }>[];
}

class AllowArtifactGateway implements ArtifactCapabilityGatewayPort {
	public async recheckArtifactAccess(request: Parameters<ArtifactCapabilityGatewayPort["recheckArtifactAccess"]>[0]) {
		return {
			ok: true as const,
			value: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				decision: "allow" as const,
				receiptId: createRuntimeId("receipt", canonicalDigest(request).slice(0, 48)),
			},
		};
	}
}

class NullArtifactAccessLog implements ArtifactAccessLogPort {
	public async append(): Promise<ArtifactResult<void>> {
		return { ok: true, value: undefined };
	}
}

class AllowForensicCapture implements WorktreeForensicAuthorizationPort {
	public async authorizeCapture() {
		return {
			ok: true as const,
			value: {
				approvalId: createRuntimeId("approval", "production-interactive"),
				purpose: "production interactive recovery",
			},
		};
	}
}

class EnforcedSandbox implements SandboxBackend {
	public async probe(): Promise<SandboxBackendCapability> {
		return {
			backendId: "production-enforced-sandbox",
			platform: "external",
			status: "available",
			supportsFilesystemIsolation: true,
			supportsNetworkDeny: true,
			supportsChildIsolation: true,
		};
	}

	public async prepare(_request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "process execution is outside this test", retryable: false } };
	}

	public async spawn(_plan: SandboxLaunchPlan): Promise<SecurityResult<SandboxProcessResult>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "process execution is outside this test", retryable: false } };
	}
}

class WorkspaceSnapshotResolver {
	#workspaceRoot: string;
	readonly #stateRoot: string;

	public constructor(workspaceRoot: string, stateRoot: string) {
		this.#workspaceRoot = workspaceRoot;
		this.#stateRoot = stateRoot;
	}

	public setWorkspaceRoot(workspaceRoot: string): void {
		this.#workspaceRoot = workspaceRoot;
	}

	#snapshot(): SecuritySnapshot {
		const body = {
			profile: {
				name: "workspace-write" as const,
				approvalPolicy: "on-request" as const,
				filesystemMode: "workspace-write" as const,
				network: { mode: "deny" as const, allowedHosts: [] },
				sandbox: "workspace-write" as const,
			},
			filesystem: {
				readRoots: [this.#workspaceRoot],
				writeRoots: [this.#workspaceRoot],
				denyRead: [this.#stateRoot],
				denyWrite: [this.#stateRoot],
				protectedPaths: [join(this.#workspaceRoot, ".git"), this.#stateRoot],
			},
			rules: [],
			sources: ["builtin" as const],
			workspaceRoot: this.#workspaceRoot,
			tempRoot: join(this.#workspaceRoot, ".runledger-tmp"),
			createdAt: NOW,
		};
		return { ...body, policyDigest: canonicalDigest(body) };
	}

	public async currentPolicyDigest(): Promise<string> {
		return this.#snapshot().policyDigest;
	}

	public async resolve(policyDigest: string): Promise<SecurityResult<SecuritySnapshot>> {
		const snapshot = this.#snapshot();
		return snapshot.policyDigest === policyDigest
			? { ok: true, value: snapshot }
			: { ok: false, error: { code: "invalid_config", message: "snapshot is stale", retryable: false } };
	}
}

class AudienceResolver implements CredentialAudienceBindingResolverPort {
	public async resolve(
		request: CredentialAudienceBindingRequest,
	): Promise<EnterprisePortResult<CredentialAudienceBindingRef>> {
		const body = {
			...request,
			audienceDigest: AUDIENCE_DIGEST,
			issuedAt: NOW,
			expiresAt: new Date(NOW_DATE.getTime() + 60_000).toISOString(),
		};
		return { ok: true, value: { ...body, bindingDigest: canonicalDigest(body) } };
	}
}

function classification(): ToolInvocationInputClassificationPort {
	return {
		classify: async (request, envelope) => {
			const source: InputSourceRef = {
				schemaVersion: 1,
				authorityId: envelope.authorityId,
				tenantId: envelope.tenantId,
				sourceId: createRuntimeId("inputSource", `interactive-${request.toolCallId}`),
				kind: "user",
				sourceDigest: canonicalDigest(request.arguments),
				trust: "trusted",
				taintLabels: [],
				observedAt: NOW,
			};
			return { ok: true, value: { inputSources: [source], declassificationReceipts: [] } };
		},
	};
}

function governedReadTool(): AgentTool<typeof TOOL_SCHEMA> {
	return {
		name: "read_fixture",
		label: "read fixture",
		description: "read a file through the governed ExecutionEnv",
		parameters: TOOL_SCHEMA,
		governedExecution: "tool-context",
		isReadOnly: () => true,
		async execute(_toolCallId, params, _signal, _update, context) {
			if (!context) throw new Error("ToolContext is required");
			const content = await context.env.fs.readFile(params.path);
			return { content: [{ type: "text", text: content.toString("utf8") }] };
		},
	};
}

function limits(): BudgetLimits {
	return Object.fromEntries(
		BUDGET_DIMENSIONS.map((dimension) => [dimension, { soft: 100_000, hard: 1_000_000 }]),
	) as BudgetLimits;
}

function initialBindings(input: ProductionInteractiveInitialBindingsInput): OperationBindings {
	return {
		model: {
			modelId: "fixture/model",
			profileId: createRuntimeId("resource", "production-interactive-model"),
			manifestDigest: canonicalDigest("production interactive model manifest"),
			profileDigest: canonicalDigest("production interactive model profile"),
		},
		tools: {
			snapshotId: createRuntimeId("snapshot", `interactive-tools-${input.toolSnapshotDigest.slice(0, 32)}`),
			snapshotDigest: input.toolSnapshotDigest,
			toolIdentityDigests: input.toolIdentityDigests,
		},
		resources: {
			snapshotId: createRuntimeId("snapshot", "production-interactive-resources"),
			snapshotDigest: canonicalDigest("production interactive resources"),
			adapterGeneration: input.extensionCatalog?.generation ?? 1,
			adapterGenerationDigest: canonicalDigest(input.extensionCatalog ?? { generation: 1 }),
		},
		config: { revision: 1, configDigest: canonicalDigest("production interactive config") },
		workspace: {
			workspaceId: input.workspace.workspaceId,
			bindingRevision: input.workspace.leaseRevision,
			bindingDigest: input.workspace.bindingDigest,
		},
		capabilities: [],
	};
}

function verification(manager: V3SessionManager): ProductionVerificationServices {
	const unavailable = {
		ok: false as const,
		error: { code: "evidence_unavailable" as const, message: "not invoked by composition", retryable: false },
	};
	const policy: TrustedVerificationPolicyPort = { resolve: async () => unavailable };
	const workspace: WorkspaceServicePort = {
		request: async (request) => ({
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "rejected",
			code: "unavailable",
			messageDigest: canonicalDigest("not invoked by composition"),
			retryable: false,
		}),
	};
	const baseline = new TrustedBaselineCoordinator({ policy, workspace });
	const gateSource: TrustedGateSourcePort = { read: async () => unavailable };
	const runner: VerificationRunnerPort = { run: async () => unavailable };
	const issuer: VerifierIssuerPort = { issue: async () => unavailable };
	const sessionRuntime = manager.createVerificationSessionRuntime();
	const pipeline = new VerificationPipeline({
		baseline,
		gateSource,
		runner,
		issuer,
		issuerRegistry: new TrustedVerifierIssuerRegistry({ environment: "production" }),
		journal: sessionRuntime,
	});
	const identity = manager.identity();
	return {
		implementation: "production",
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: manager.sessionId(),
		evidenceDigest: canonicalDigest({ implementation: "production", sessionId: manager.sessionId() }),
		pipeline,
		sessionRuntime,
		completionTrust: { verify: async () => false },
	};
}

interface Fixture {
	worktree: WorktreeTestHarness;
	artifact: ArtifactHarness;
	manager: V3SessionManager;
	features: RuntimeFeatureFlags;
	stateRoot: string;
	tool: AgentTool;
	options(
		binding?: ProductionInteractiveRuntimeOptions["workspace"]["binding"],
		activeManager?: V3SessionManager,
	): ProductionInteractiveRuntimeOptions;
}

async function fixture(): Promise<Fixture> {
	const worktree = await createWorktreeHarness();
	const artifact = await createArtifactHarness();
	worktrees.push(worktree);
	artifacts.push(artifact);
	const features: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
	const manager = await V3SessionManager.create({
		cwd: worktree.sourceCwd,
		sessionDir: join(worktree.root, "sessions"),
		features,
	});
	managers.push(manager);
	const stateRoot = join(worktree.root, "production-state");
	const artifactAccess = new ArtifactAccessService({
		cas: artifact.cas,
		metadata: artifact.metadata,
		gateway: new AllowArtifactGateway(),
		accessLog: new NullArtifactAccessLog(),
		keyProvider: artifact.keyProvider,
		clock: () => new Date(NOW_DATE),
	});
	const tool = governedReadTool();
	const manifest = createProductionToolManifest({
		toolName: tool.name,
		kind: "native",
		primaryCapability: "repository_read",
		requiredCapabilities: ["repository_read"],
		targetSink: "context",
		idempotent: true,
		retrySafe: true,
	});
	const options = (
		binding: ProductionInteractiveRuntimeOptions["workspace"]["binding"] = {
			kind: "source",
			repositoryId: createRuntimeId("repository", "production-interactive"),
			sourceRepo: worktree.sourceRepo,
			sourceCwd: worktree.sourceCwd,
		},
		activeManager: V3SessionManager = manager,
	): ProductionInteractiveRuntimeOptions => {
		const identity = activeManager.identity();
		return {
			manager: activeManager,
			models: createModels(),
			mutationGate: createV3SessionMutationAdmissionGate(
				activeManager,
				new ExactExternalReceiptAuditor(),
				{ clock: () => new Date(NOW_DATE) },
			),
			tools: [tool],
			workspace: {
				managedRoot: join(worktree.root, "production-managed"),
				stateRoot,
				liveness: worktree.liveness,
				artifactAccess,
				forensicAuthorization: new AllowForensicCapture(),
				binding,
			},
			toolGateway: {
				snapshots: new WorkspaceSnapshotResolver(worktree.sourceRepo, stateRoot),
				manifests: [manifest],
				classification: classification(),
				peerBinding: {
					authorityId: identity.authorityId,
					tenantId: identity.tenantId,
					principalId: identity.principalId,
					channel: "local_process",
					channelBindingDigest: canonicalDigest("production interactive local peer"),
					keyRevision: 1,
					issuedAt: NOW,
					expiresAt: new Date(NOW_DATE.getTime() + 3_600_000).toISOString(),
				},
				rateLimiter: new MemoryCapabilityRateLimiter([{
					rateLimitId: RATE_LIMIT_ID,
					capability: "repository_read",
					maxUnits: 100,
					maxWindowMs: 60_000,
				}], () => new Date(NOW_DATE)),
				rateLimitPolicy: () => ({ rateLimitId: RATE_LIMIT_ID, windowMs: 60_000, units: 1 }),
				prompter: { request: async () => ({ decision: "allow-once", decidedBy: identity.principalId }) },
				credentials: {
					materials: {
						resolve: async () => unavailableCredential(),
						revoke: async () => ({ ok: true, value: undefined }),
					},
					injection: {
						inject: async () => unavailableCredential(),
						revoke: async () => ({ ok: true, value: undefined }),
					},
					audienceResolver: new AudienceResolver(),
					maxBrokerTtlMs: 60_000,
					maxRuntimeGrantTtlMs: 30_000,
				},
				sandboxBackend: new EnforcedSandbox(),
				baseEnvironment: { PATH: "/usr/bin:/bin" },
			},
			session: {
				verification: verification(activeManager),
				compaction: { sampler: { sample: async () => "bounded production summary" } },
				orchestrator: {
					budgetLimits: limits(),
					loopBreaker: new LoopBreaker({
						maxRepeatedToolSignature: 3,
						maxRepeatedFailure: 3,
						maxNoProgress: 3,
						maxRemediationAttempts: 3,
					}),
					createInitialBindings: initialBindings,
				},
				memoryRoots: {
					userRoot: join(worktree.root, "memory-user"),
					projectRoot: join(worktree.root, "memory-project"),
				},
			},
			clock: () => new Date(NOW_DATE),
		};
	};
	return { worktree, artifact, manager, features, stateRoot, tool, options };
}

function agentOptions(setup: Fixture): NonNullable<ProductionInteractiveRuntimeOptions["agents"]> {
	const identity = setup.manager.identity();
	const parentGrant: ParentCapabilityGrantRef = {
		receiptId: createRuntimeId("receipt", "production-interactive-close-root-grant"),
		receiptDigest: canonicalDigest("production interactive close root grant"),
		decisionRevision: 1,
	};
	return {
		root: {
			role: "build",
			capabilityGrant: parentGrant,
			capabilityPolicies: [createProductionCapabilityGrantPolicy({
				policyReceiptId: createRuntimeId("receipt", "production-interactive-close-policy"),
				parentGrant,
				allowedRequests: [],
				delegableToolKinds: [],
				childSpawnAllowed: false,
				decisionRevision: 1,
				evaluatorId: identity.principalId,
				issuedAt: NOW,
			})],
			denialPolicy: {
				policyDigest: canonicalDigest("production interactive close denial policy"),
				decisionRevision: 1,
				deniedAgentIds: new Set(),
			},
			inputSources: [],
			declassificationReceipts: [],
		},
		child: {
			sessionDir: join(setup.worktree.root, "production-close-child-sessions"),
			features: setup.features,
			maxActiveChildren: 2,
		},
	};
}

function unavailableCredential() {
	return {
		ok: false as const,
		error: { code: "credential_unavailable" as const, message: "credential is not configured", retryable: false },
	};
}

function invocation(tool: AgentTool, cwd: string, seed: string): ToolExecutionGatewayRequest {
	return {
		turnId: createRuntimeId("turn", seed),
		toolCallId: createRuntimeId("toolCall", seed),
		providerToolCallId: `provider-${seed}`,
		tool,
		arguments: { path: join(cwd, "index.ts") },
		cwd,
		envVars: {},
	};
}

function rejectedExecutionGrant(request: ToolExecutionGatewayRequest): ToolExecutionAuthorizationGrant {
	const authorityId = createRuntimeId("authority", "production-mutation-gate");
	const tenantId = createRuntimeId("tenant", "production-mutation-gate");
	const principalId = createRuntimeId("principal", "production-mutation-gate");
	const workspaceEnvelopeDigest = canonicalDigest("production mutation gate workspace envelope");
	const authorizationBody = {
		receiptId: createRuntimeId("receipt", "production-mutation-gate-authorization"),
		requestId: createRuntimeId("command", "production-mutation-gate-authorization"),
		approvalId: createRuntimeId("approval", "production-mutation-gate-authorization"),
		sessionId: createRuntimeId("session", "production-mutation-gate"),
		runtimeId: createRuntimeId("runtime", "production-mutation-gate"),
		runtimeGeneration: 1,
		turnId: request.turnId,
		toolCallId: request.toolCallId,
		requestDigest: canonicalDigest("production mutation gate request"),
		decisionDigest: canonicalDigest("production mutation gate decision"),
	};
	const sandboxBody = {
		receiptId: createRuntimeId("receipt", "production-mutation-gate-sandbox"),
		profileId: createRuntimeId("resource", "production-mutation-gate-sandbox"),
		requested: "workspace-write" as const,
		resolved: "workspace-write" as const,
		policyDigest: canonicalDigest("production mutation gate policy"),
		backendId: "production-mutation-gate-fixture",
		effectiveEnforcement: "enforced" as const,
	};
	const body = {
		schemaVersion: 1 as const,
		toolCallId: request.toolCallId,
		providerToolCallDigest: canonicalDigest(request.providerToolCallId),
		toolIdentityDigest: canonicalDigest(request.tool.name),
		argumentsDigest: canonicalDigest(request.arguments),
		invocationDigest: canonicalDigest({
			toolCallId: request.toolCallId,
			arguments: request.arguments,
		}),
		workspaceEnvelopeDigest,
		workspaceValidation: {
			authorityId,
			tenantId,
			principalId,
			receiptId: createRuntimeId("receipt", "production-mutation-gate-workspace"),
			workspaceId: createRuntimeId("workspace", "production-mutation-gate"),
			envelopeDigest: workspaceEnvelopeDigest,
			validatorId: principalId,
			validatedAt: NOW,
			outcome: "valid" as const,
		},
		authorization: {
			...authorizationBody,
			receiptDigest: canonicalDigest(authorizationBody),
		},
		capability: "repository_read" as const,
		policyDigest: sandboxBody.policyDigest,
		sandbox: {
			...sandboxBody,
			resolutionDigest: canonicalDigest(sandboxBody),
		},
	};
	return { ...body, grantDigest: canonicalDigest(body) };
}

describe("production interactive runtime composition", () => {
	it.each(["source", "readonly_checkout"] as const)(
		"constructs the production supervisor from an active %s Workspace and exact canonical gate without advertising it",
		async (bindingKind) => {
		const setup = await fixture();
		let compositionSnapshots: WorkspaceSnapshotResolver | undefined;
		let options = setup.options(bindingKind === "source" ? undefined : {
			kind: "readonly_checkout",
			repositoryId: createRuntimeId("repository", "production-interactive"),
			sourceRepo: setup.worktree.sourceRepo,
			sourceCwd: setup.worktree.sourceCwd,
			label: "production-readonly-root",
		});
		if (bindingKind === "readonly_checkout") {
			const snapshots = new WorkspaceSnapshotResolver(setup.worktree.sourceRepo, setup.stateRoot);
			compositionSnapshots = snapshots;
			const create = WorktreeManager.prototype.create;
			vi.spyOn(WorktreeManager.prototype, "create").mockImplementation(async function (request, signal) {
				const result = await create.call(this, request, signal);
				if (result.ok) snapshots.setWorkspaceRoot(result.value.binding.worktreePath);
				return result;
			});
			options = { ...options, toolGateway: { ...options.toolGateway, snapshots } };
		}
		const identity = setup.manager.identity();
		const parentGrant: ParentCapabilityGrantRef = {
			receiptId: createRuntimeId("receipt", "production-interactive-root-grant"),
			receiptDigest: canonicalDigest("production interactive root grant"),
			decisionRevision: 1,
		};
		const agents: NonNullable<ProductionInteractiveRuntimeOptions["agents"]> = {
			root: {
				role: "build",
				capabilityGrant: parentGrant,
				capabilityPolicies: [createProductionCapabilityGrantPolicy({
					policyReceiptId: createRuntimeId("receipt", "production-interactive-delegation-policy"),
					parentGrant,
					allowedRequests: [],
					delegableToolKinds: [],
					childSpawnAllowed: false,
					decisionRevision: 1,
					evaluatorId: identity.principalId,
					issuedAt: NOW,
				})],
				denialPolicy: {
					policyDigest: canonicalDigest("production interactive Agent denial policy"),
					decisionRevision: 1,
					deniedAgentIds: new Set(),
				},
				inputSources: [],
				declassificationReceipts: [],
			},
			child: {
				sessionDir: join(setup.worktree.root, "production-child-sessions"),
				features: setup.features,
				maxActiveChildren: 2,
			},
		};
		const runtime = await createProductionInteractiveRuntime({
			...options,
			agents,
		});

		const graph = await runtime.agents?.supervisor.graph();
		expect(graph).toMatchObject({
			ok: true,
			value: {
				rootAgentId: setup.manager.sessionEvents().lineage().agentId,
				nodes: expect.any(Map),
			},
		});
		if (graph?.ok) {
			expect(graph.value.nodes.get(graph.value.rootAgentId!)).toMatchObject({
				sessionId: setup.manager.sessionId(),
				workspaceReceipt: {
					workspaceId: runtime.workspace.workspaceId,
					strategy: { kind: bindingKind === "source" ? "isolated_lease" : "readonly_checkout" },
					status: bindingKind === "source" ? "active" : "readonly",
				},
			});
		}
		expect(runtime.featureEvidence.features).not.toContain("multi-agent");
		const workspaceId = runtime.workspace.workspaceId;
		const firstWorkspaceRevision = graph?.ok
			? graph.value.nodes.get(graph.value.rootAgentId!)?.workspaceReceipt.bindingRevision
			: undefined;
		const filePath = setup.manager.filePath();
		await runtime.close();
		const reopened = await V3SessionManager.open(filePath, setup.features, identity);
		managers.push(reopened);
		const resumedOptions = setup.options({ kind: "resume", workspaceId }, reopened);
		const resumed = await createProductionInteractiveRuntime({
			...resumedOptions,
			...(compositionSnapshots ? {
				toolGateway: { ...resumedOptions.toolGateway, snapshots: compositionSnapshots },
			} : {}),
			agents,
		});
		const resumedGraph = await resumed.agents?.supervisor.graph();
		expect(resumedGraph?.ok).toBe(true);
		if (resumedGraph?.ok) {
			expect(resumedGraph.value.nodes.get(resumedGraph.value.rootAgentId!)?.workspaceReceipt.bindingRevision)
				.toBeGreaterThan(firstWorkspaceRevision ?? -1);
		}
		const resumedEvents = await readAllRuntimeEvents(reopened.eventStore());
		expect(resumedEvents.ok && resumedEvents.value.some((event) => event.type === "agent.root_revalidated")).toBe(true);
		await resumed.close();
		},
	);

	it("returns controller-ready bindings without advertising an absent extension and closes idempotently", async () => {
		const setup = await fixture();
		const runtime = await createProductionInteractiveRuntime(setup.options());
		expect(runtime).toMatchObject({
			sessionId: setup.manager.sessionId(),
			cwd: setup.worktree.sourceCwd,
			tools: [{ name: "read_fixture" }],
			featureEvidence: { sessionMutationReady: true },
		});
		expect(runtime.featureEvidence.features).toEqual(["session", "turn", "queue", "approval", "artifact"]);
		expect(runtime.extensionRuntime).toBeUndefined();
		expect(runtime.extensionCatalog).toBeUndefined();
		expect(runtime.beforeToolCall).toBeUndefined();
		expect(runtime.afterToolCall).toBeUndefined();
		expect(JSON.stringify({
			workspace: runtime.workspace,
			evidence: runtime.featureEvidence,
			paths: runtime.paths,
		})).not.toContain("fencingToken");

		await Promise.all([runtime.close(), runtime.close()]);
			expect(setup.manager.isClosed()).toBe(true);
			const afterCloseRequest = invocation(setup.tool, runtime.cwd, "after-close");
			expect(await runtime.toolExecutionGateway.authorize(afterCloseRequest)).toMatchObject({
				status: "unavailable",
			});
			const afterCloseStart = vi.fn(async () => undefined);
			expect(await runtime.toolExecutionGateway.start(
				{ invocation: afterCloseRequest, grant: rejectedExecutionGrant(afterCloseRequest) },
				afterCloseStart,
			)).toMatchObject({ status: "unavailable", outcomeCertain: true });
			expect(afterCloseStart).not.toHaveBeenCalled();
		const registry = await readFile(runtime.paths.workspace.registryFile, "utf8");
		expect(registry).toContain('"state":"retained"');
	});

	it("keeps parent Workspace and manager open when Agent close fails, then retries teardown", async () => {
		const setup = await fixture();
		const closeFailure = new Error("injected production Agent close failure");
		const childClose = vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle")
			.mockRejectedValueOnce(closeFailure);
		const runtime = await createProductionInteractiveRuntime({
			...setup.options(),
			agents: agentOptions(setup),
		});
		const workspaceRelease = vi.spyOn(WorktreeManager.prototype, "release");
		const managerClose = vi.spyOn(setup.manager, "closeAll");

		await expect(runtime.close()).rejects.toThrow(
			"production interactive Agent close blocked parent resource teardown",
		);
		expect(setup.manager.isClosed()).toBe(false);
		expect(workspaceRelease).not.toHaveBeenCalled();
		expect(managerClose).not.toHaveBeenCalled();

		await expect(runtime.close()).resolves.toBeUndefined();
		expect(childClose).toHaveBeenCalledTimes(2);
		expect(workspaceRelease).toHaveBeenCalledTimes(1);
		expect(managerClose).toHaveBeenCalledTimes(1);
		expect(setup.manager.isClosed()).toBe(true);
	});

	it("keeps the manager open when Workspace release persistence fails, then retries the exact teardown", async () => {
		const setup = await fixture();
		const runtime = await createProductionInteractiveRuntime(setup.options());
		const workspaceRelease = vi.spyOn(WorktreeManager.prototype, "release");
		const managerClose = vi.spyOn(setup.manager, "closeAll");
		vi.spyOn(setup.manager.writer(), "append").mockResolvedValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected workspace release event failure",
				retryable: true,
				effect: "none",
			},
		});

		await expect(runtime.close()).rejects.toThrow(
			"production interactive Workspace release blocked parent manager teardown",
		);
		expect(setup.manager.isClosed()).toBe(false);
		expect(workspaceRelease).toHaveBeenCalledTimes(1);
		expect(managerClose).not.toHaveBeenCalled();

		await expect(runtime.close()).resolves.toBeUndefined();
		expect(workspaceRelease).toHaveBeenCalledTimes(1);
		expect(managerClose).toHaveBeenCalledTimes(1);
		expect(setup.manager.isClosed()).toBe(true);
	});

	it("uses the exact injected mutation gate for model preparation, authorization, and durable start", async () => {
		const setup = await fixture();
		const gate = new RejectingRecordingMutationGate();
			const rawAuthorize = vi.spyOn(PortBackedToolExecutionGateway.prototype, "authorize");
			const rawStart = vi.spyOn(PortBackedToolExecutionGateway.prototype, "start");
			const rawExecute = vi.spyOn(PortBackedToolExecutionGateway.prototype, "execute");
		const options = setup.options();
		const runtime = await createProductionInteractiveRuntime({ ...options, mutationGate: gate });
		const modelDelegate = vi.spyOn(runtime.modelRuntime.coordinator, "prepare");
		const selectedModel: Model<Api> = {
			id: "production-mutation-gate-fixture",
			name: "production mutation gate fixture",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		};
		const modelRequestId = createRuntimeId("modelRequest", "production-mutation-gate");
		const toolRequest = invocation(setup.tool, runtime.cwd, "production-mutation-gate");
		const grant = rejectedExecutionGrant(toolRequest);

		await expect(runtime.prepareModelRequest({
			turn: 1,
			turnId: toolRequest.turnId,
			modelRequestId,
			model: selectedModel,
			context: { systemPrompt: "production mutation gate fixture", messages: [], tools: [] },
			messages: [],
		})).rejects.toMatchObject({
			name: "SessionMutationAdmissionError",
			message: "production mutation gate rejected the operation",
		});
		expect(await runtime.toolExecutionGateway.authorize(toolRequest)).toMatchObject({
			status: "unavailable",
			reason: "production mutation gate rejected the operation",
		});
			const durableStart = vi.fn(async () => undefined);
			expect(await runtime.toolExecutionGateway.start(
				{ invocation: toolRequest, grant },
				durableStart,
			)).toEqual({
			status: "unavailable",
			grantDigest: grant.grantDigest,
			reason: "production mutation gate rejected the operation",
			outcomeCertain: true,
			});
			expect(durableStart).not.toHaveBeenCalled();

		expect(gate.requests).toStrictEqual([
			{ kind: "model_request", correlationId: modelRequestId },
			{ kind: "tool_authorize", correlationId: toolRequest.toolCallId },
			{ kind: "tool_execute", correlationId: toolRequest.toolCallId },
		]);
			expect(modelDelegate).not.toHaveBeenCalled();
			expect(rawAuthorize).not.toHaveBeenCalled();
			expect(rawStart).not.toHaveBeenCalled();
			expect(rawExecute).not.toHaveBeenCalled();
		await runtime.close();
	});

	it("keeps startup start leases only after one correlated completed durable callback", async () => {
		const setup = await fixture();
		type StartMode = "missing_callback" | "late_callback" | "repeated_callback" | "duplicate" | "uncorrelated";
		let mode: StartMode = "missing_callback";
		let releaseDuplicate: () => void = () => undefined;
		let reportDuplicateEntered: () => void = () => undefined;
		let reportLateCallback: () => void = () => undefined;
		const duplicateRelease = new Promise<void>((resolve) => { releaseDuplicate = resolve; });
		const duplicateEntered = new Promise<void>((resolve) => { reportDuplicateEntered = resolve; });
		const lateCallbackAttempted = new Promise<void>((resolve) => { reportLateCallback = resolve; });
		const delegateTokens = new Set<string>();
		const rawStart = vi.spyOn(PortBackedToolExecutionGateway.prototype, "start").mockImplementation(async (request, durableStart) => {
			if (mode === "missing_callback") {
				delegateTokens.add(request.grant.grantDigest);
				return { status: "ready", grantDigest: request.grant.grantDigest };
			}
			if (mode === "late_callback") {
				delegateTokens.add(request.grant.grantDigest);
				setTimeout(() => {
					void durableStart().finally(reportLateCallback);
				}, 0);
				return { status: "ready", grantDigest: request.grant.grantDigest };
			}
			if (mode === "repeated_callback") {
				await durableStart();
				void durableStart();
				delegateTokens.add(request.grant.grantDigest);
				return { status: "ready", grantDigest: request.grant.grantDigest };
			}
			await durableStart();
			delegateTokens.add(request.grant.grantDigest);
			if (mode === "duplicate") {
				reportDuplicateEntered();
				await duplicateRelease;
				return { status: "ready", grantDigest: request.grant.grantDigest };
			}
			return { status: "ready", grantDigest: "f".repeat(64) };
		});
		const rawExecute = vi.spyOn(PortBackedToolExecutionGateway.prototype, "execute").mockImplementation(async (request) => {
			delegateTokens.delete(request.grant.grantDigest);
			return {
				status: "completed",
				grantDigest: request.grant.grantDigest,
				result: { content: [{ type: "text", text: "fixture completed" }] },
			};
		});
		const runtime = await createProductionInteractiveRuntime(setup.options());

		const missingRequest = invocation(setup.tool, runtime.cwd, "startup-missing-callback");
		const missingGrant = rejectedExecutionGrant(missingRequest);
		const missingCallback = vi.fn(async () => undefined);
		expect(await runtime.toolExecutionGateway.start(
			{ invocation: missingRequest, grant: missingGrant },
			missingCallback,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: missingGrant.grantDigest,
			reason: expect.stringContaining("without one completed durable start callback"),
		});
		expect(missingCallback).not.toHaveBeenCalled();

		mode = "late_callback";
		const lateRequest = invocation(setup.tool, runtime.cwd, "startup-late-callback");
		const lateGrant = rejectedExecutionGrant(lateRequest);
		const lateCallback = vi.fn(async () => undefined);
		expect(await runtime.toolExecutionGateway.start(
			{ invocation: lateRequest, grant: lateGrant },
			lateCallback,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: lateGrant.grantDigest,
			reason: expect.stringContaining("without one completed durable start callback"),
		});
		await lateCallbackAttempted;
		expect(lateCallback).not.toHaveBeenCalled();

		mode = "repeated_callback";
		const repeatedRequest = invocation(setup.tool, runtime.cwd, "startup-repeated-callback");
		const repeatedGrant = rejectedExecutionGrant(repeatedRequest);
		const repeatedCallback = vi.fn(async () => undefined);
		expect(await runtime.toolExecutionGateway.start(
			{ invocation: repeatedRequest, grant: repeatedGrant },
			repeatedCallback,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: repeatedGrant.grantDigest,
			reason: expect.stringContaining("repeated durable start callback"),
		});
		expect(repeatedCallback).toHaveBeenCalledOnce();

		mode = "duplicate";
		const duplicateRequest = invocation(setup.tool, runtime.cwd, "startup-duplicate");
		const duplicateGrant = rejectedExecutionGrant(duplicateRequest);
		const firstCallback = vi.fn(async () => undefined);
		const firstStart = runtime.toolExecutionGateway.start(
			{ invocation: duplicateRequest, grant: duplicateGrant },
			firstCallback,
		);
		await duplicateEntered;
		const delegateCallsBeforeDuplicate = rawStart.mock.calls.length;
		const duplicateCallback = vi.fn(async () => undefined);
		expect(await runtime.toolExecutionGateway.start(
			{ invocation: duplicateRequest, grant: duplicateGrant },
			duplicateCallback,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: duplicateGrant.grantDigest,
			reason: expect.stringContaining("duplicate active start"),
		});
		expect(rawStart).toHaveBeenCalledTimes(delegateCallsBeforeDuplicate);
		expect(duplicateCallback).not.toHaveBeenCalled();
		releaseDuplicate();
		expect(await firstStart).toEqual({ status: "ready", grantDigest: duplicateGrant.grantDigest });
		expect(firstCallback).toHaveBeenCalledOnce();
		expect(await runtime.toolExecutionGateway.execute(
			{ invocation: duplicateRequest, grant: duplicateGrant },
			() => undefined,
		)).toMatchObject({ status: "completed", grantDigest: duplicateGrant.grantDigest });

		mode = "uncorrelated";
		const uncorrelatedRequest = invocation(setup.tool, runtime.cwd, "startup-uncorrelated");
		const uncorrelatedGrant = rejectedExecutionGrant(uncorrelatedRequest);
		const uncorrelatedCallback = vi.fn(async () => undefined);
		expect(await runtime.toolExecutionGateway.start(
			{ invocation: uncorrelatedRequest, grant: uncorrelatedGrant },
			uncorrelatedCallback,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: uncorrelatedGrant.grantDigest,
			reason: expect.stringContaining("uncorrelated start"),
		});
		expect(uncorrelatedCallback).toHaveBeenCalledOnce();
		expect(rawExecute).toHaveBeenCalledOnce();
		expect(delegateTokens).toEqual(new Set([
			missingGrant.grantDigest,
			lateGrant.grantDigest,
			repeatedGrant.grantDigest,
			uncorrelatedGrant.grantDigest,
		]));
		await runtime.close();
	});

	it("does not let an uncorrelated same-digest execute consume an active startup lease", async () => {
		const setup = await fixture();
		const rawStart = vi.spyOn(PortBackedToolExecutionGateway.prototype, "start").mockImplementation(async (request, durableStart) => {
			await durableStart();
			return { status: "ready", grantDigest: request.grant.grantDigest };
		});
		const rawExecute = vi.spyOn(PortBackedToolExecutionGateway.prototype, "execute").mockImplementation(async (request) => ({
			status: "completed",
			grantDigest: request.grant.grantDigest,
			result: { content: [{ type: "text", text: "fixture completed" }] },
		}));
		const runtime = await createProductionInteractiveRuntime(setup.options());
		const request = invocation(setup.tool, runtime.cwd, "startup-malformed-execute");
		const grant = rejectedExecutionGrant(request);
		const executionRequest = { invocation: request, grant };
		expect(await runtime.toolExecutionGateway.start(executionRequest, async () => undefined)).toEqual({
			status: "ready",
			grantDigest: grant.grantDigest,
		});
		expect(rawStart).toHaveBeenCalledOnce();

		const malformedGrant = { ...grant, invocationDigest: "f".repeat(64) };
		expect(await runtime.toolExecutionGateway.execute(
			{ invocation: request, grant: malformedGrant },
			() => undefined,
		)).toMatchObject({
			status: "uncertain",
			grantDigest: grant.grantDigest,
			reason: expect.stringContaining("uncorrelated execute"),
			outcomeCertain: false,
		});
		expect(rawExecute).not.toHaveBeenCalled();

		let closeSettled = false;
		const close = runtime.close().then(() => { closeSettled = true; });
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(await runtime.toolExecutionGateway.execute(executionRequest, () => undefined)).toMatchObject({
			status: "completed",
			grantDigest: grant.grantDigest,
		});
		expect(rawExecute).toHaveBeenCalledOnce();
		await close;
		expect(closeSettled).toBe(true);
	});

	it("rejects execute without an exact startup lease before calling the delegate", async () => {
		const setup = await fixture();
		const rawExecute = vi.spyOn(PortBackedToolExecutionGateway.prototype, "execute");
		const runtime = await createProductionInteractiveRuntime(setup.options());
		const request = invocation(setup.tool, runtime.cwd, "startup-no-start-execute");
		const grant = rejectedExecutionGrant(request);

		expect(await runtime.toolExecutionGateway.execute(
			{ invocation: request, grant },
			() => undefined,
		)).toEqual({
			status: "unavailable",
			grantDigest: grant.grantDigest,
			reason: "production interactive Tool Gateway has no active start lease",
			outcomeCertain: true,
		});
		expect(rawExecute).not.toHaveBeenCalled();
		await runtime.close();
	});

	it("records the exact production workspace binding, lease, and adapter receipt in canonical events", async () => {
		const setup = await fixture();
		const capture = captureWorkspaceOperations();
		const runtime = await createProductionInteractiveRuntime(setup.options());
		expect(capture.bindings).toHaveLength(1);
		const boundResult = capture.bindings[0];
		if (!boundResult) throw new Error("production workspace bind result was not captured");

		const events = await canonicalEvents(setup.manager);
		const boundEvents = eventsOfType(events, "workspace.bound");
		expect(boundEvents).toHaveLength(1);
		const bound = boundEvents[0];
		if (!bound) throw new Error("canonical workspace.bound event is missing");
		expect(bound.payload).toEqual({
			binding: boundResult.runtimeBinding,
			bindingDigest: workspaceBindingDigest(boundResult.runtimeBinding),
			lease: boundResult.lease,
		});
		expect(bound.payload.binding).toEqual(runtime.runtimeWorkspace);
		expect(bound.payload.lease).toMatchObject({
			leaseId: runtime.workspace.leaseId,
			workspaceId: runtime.workspace.workspaceId,
			ownerRuntimeId: runtime.workspace.ownerRuntimeId,
			leaseRevision: runtime.workspace.leaseRevision,
			state: "active",
		});

		const acquiredEvents = eventsOfType(events, "lease.acquired");
		expect(acquiredEvents).toHaveLength(1);
		const acquired = acquiredEvents[0];
		if (!acquired) throw new Error("canonical lease.acquired event is missing");
		expect(acquired.sequence).toBe(bound.sequence + 1);
		expect(acquired.payload).toEqual({
			lease: boundResult.lease,
			receiptId: boundResult.receiptId,
		});

		await runtime.close();
	});

	it("fails closed when a required production manifest is absent", async () => {
		const setup = await fixture();
		const options = setup.options();
		await expect(createProductionInteractiveRuntime({
			...options,
			toolGateway: { ...options.toolGateway, manifests: [] },
		})).rejects.toThrow(/manifest/u);
		expect(setup.manager.isClosed()).toBe(true);
	});

	it("rejects a provider-owned Approval store instead of creating a second source of truth", async () => {
		const setup = await fixture();
		const options = setup.options();
		const toolGateway = {
			...options.toolGateway,
			approvalStore: new MemoryApprovalStateStore(),
		};

		await expect(createProductionInteractiveRuntime({
			...options,
			toolGateway,
		})).rejects.toThrow(/Approval store is owned by the canonical state root/u);
		expect(setup.manager.isClosed()).toBe(true);
	});

	it("reopens the durable session and resumes the released workspace without duplicate goal genesis", async () => {
		const setup = await fixture();
		const capture = captureWorkspaceOperations();
		const first = await createProductionInteractiveRuntime(setup.options());
		const firstGoal = first.sessionRuntime.goal.snapshot();
		const workspaceId = first.workspace.workspaceId;
		const sessionId = first.sessionId;
		const filePath = setup.manager.filePath();
		const firstEvents = await canonicalEvents(setup.manager);
		const goalGenesisCount = eventsOfType(firstEvents, "goal.created").length;
		expect(goalGenesisCount).toBe(1);
		expect(capture.bindings).toHaveLength(1);
		const firstBinding = capture.bindings[0];
		if (!firstBinding) throw new Error("initial production workspace bind result was not captured");
		await first.close();
		expect(capture.releaseReceiptIds).toHaveLength(1);
		const firstReleaseReceiptId = capture.releaseReceiptIds[0];
		if (!firstReleaseReceiptId) throw new Error("initial production workspace release result was not captured");

		const reopenedManager = await V3SessionManager.open(filePath, setup.features);
		managers.push(reopenedManager);
		const releasedEvents = await canonicalEvents(reopenedManager);
		const releases = eventsOfType(releasedEvents, "workspace.released");
		expect(releases).toHaveLength(1);
		const released = releases[0];
		if (!released) throw new Error("canonical workspace.released event is missing");
		expect(released.payload).toEqual({
			workspaceId: firstBinding.runtimeBinding.workspaceId,
			leaseId: firstBinding.lease.leaseId,
			leaseRevision: firstBinding.lease.leaseRevision,
			bindingDigest: workspaceBindingDigest(firstBinding.runtimeBinding),
			receiptId: firstReleaseReceiptId,
		});
		expect(releasedEvents.at(-1)).toEqual(released);
		const identity = reopenedManager.identity();
		const releasedReferences = projectExternalReceiptReferences(releasedEvents, {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: reopenedManager.sessionId(),
		});
		if (!releasedReferences.ok) throw new Error(releasedReferences.error.message);
		expect(releasedReferences.value.workspaceLeases).toEqual([]);

		const reopenedOptions = setup.options({ kind: "resume", workspaceId }, reopenedManager);
		const second = await createProductionInteractiveRuntime(reopenedOptions);
		expect(second.sessionId).toBe(sessionId);
		expect(second.workspace).toMatchObject({ workspaceId, leaseRevision: 2, ownerRuntimeId: reopenedManager.runtimeId() });
		expect(second.sessionRuntime.goal.snapshot()).toEqual(firstGoal);
		expect(capture.bindings).toHaveLength(2);
		const secondBinding = capture.bindings[1];
		if (!secondBinding) throw new Error("resumed production workspace bind result was not captured");
		expect(secondBinding.lease).toMatchObject({
			leaseId: firstBinding.lease.leaseId,
			workspaceId,
			ownerRuntimeId: reopenedManager.runtimeId(),
			leaseRevision: firstBinding.lease.leaseRevision + 1,
			state: "active",
		});

		const reboundEvents = await canonicalEvents(reopenedManager);
		expect(eventsOfType(reboundEvents, "goal.created")).toHaveLength(goalGenesisCount);
		const rebound = eventsOfType(reboundEvents, "workspace.bound").at(-1);
		const reacquired = eventsOfType(reboundEvents, "lease.acquired").at(-1);
		if (!rebound || !reacquired) throw new Error("resumed workspace canonical binding is incomplete");
		expect(rebound.sequence).toBeGreaterThan(released.sequence);
		expect(rebound.payload).toEqual({
			binding: secondBinding.runtimeBinding,
			bindingDigest: workspaceBindingDigest(secondBinding.runtimeBinding),
			lease: secondBinding.lease,
		});
		expect(reacquired.sequence).toBe(rebound.sequence + 1);
		expect(reacquired.payload).toEqual({
			lease: secondBinding.lease,
			receiptId: secondBinding.receiptId,
		});
		const reboundReferences = projectExternalReceiptReferences(reboundEvents, {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: reopenedManager.sessionId(),
		});
		if (!reboundReferences.ok) throw new Error(reboundReferences.error.message);
		expect(reboundReferences.value.workspaceLeases).toEqual([secondBinding.lease]);
		expect(reboundReferences.value.workspaceLeases).not.toContainEqual(firstBinding.lease);
		await second.close();
	});
});
