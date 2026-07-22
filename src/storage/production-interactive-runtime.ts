/** Production interactive runtime 的独立 composition root。 */

import { join } from "node:path";
import type { Models } from "../models.ts";
import {
	createProductionAdapterEvidence,
	createProductionCompositionReceipt,
	validateProductionCompositionReceipt,
	type ProductionAdapterEvidence,
	type ValidatedProductionComposition,
} from "../daemon/production-composition.ts";
import {
	ProductionExtensionRuntime,
	type ProductionExtensionCatalog,
} from "../extensions/integration/production-runtime.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	type CommandId,
	type RepositoryId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceBindingRef,
	type WorkspaceExecutionEnvelope,
} from "../runtime/protocol/v3/workspace.ts";
import type { OperationBindings } from "../runtime/orchestrator/types.ts";
import { planModeContextFragment } from "../runtime/modes/plan/service.ts";
import { ToolRegistry } from "../runtime/tool-registry.ts";
import type {
	AgentLoopConfig,
	AgentTool,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolResultArtifactSink,
} from "../runtime/types.ts";
import type { AgentToolUpdateCallback } from "../runtime/types.ts";
import type { AgentLoopSessionEvents } from "../runtime/session/agent-loop-events.ts";
import type { SandboxBackend, SandboxBackendCapability } from "../security/sandbox/types.ts";
import type { ProductionToolManifest } from "../security/integration/production-tool-components.ts";
import {
	MemoryContextProvider,
	WorkspaceContextProvider,
} from "../runtime/integration/production-context-providers.ts";
import type { GovernedContextFragmentProvider } from "../runtime/integration/governed-model-request.ts";
import {
	createProductionModelRuntime,
	type ProductionModelRuntime,
} from "../runtime/integration/production-model-runtime.ts";
import {
	createProductionSessionRuntime,
	type ProductionSessionRuntime,
	type ProductionVerificationServices,
} from "../runtime/integration/production-session-runtime.ts";
import type { CompactionSummarySampler } from "../runtime/context/compaction/summarizer.ts";
import type { BudgetLimits } from "../runtime/orchestrator/budget-guard.ts";
import type { LoopBreaker } from "../runtime/orchestrator/loop-breaker.ts";
import { VerificationPipeline } from "../runtime/verification/pipeline.ts";
import { VerificationSessionRuntime } from "../runtime/verification/session-runtime.ts";
import type { V3SessionManager } from "./v3-session-manager.ts";
import {
	createProductionWorkspaceComposition,
	type ProductionWorkspaceCompositionOptions,
	type ProductionWorkspaceStatePaths,
} from "./worktree-production.ts";
import {
	createProductionToolGatewayComposition,
	type ProductionToolGatewayComposition,
	type ProductionToolGatewayCompositionOptions,
	type ProductionToolGatewayStatePaths,
} from "./production-tool-gateway.ts";
import type {
	PersistedWorkspaceBinding,
	WorktreeCreateResult,
} from "../worktree/types.ts";

const BASE_TOOL_NAMESPACE = "production";
const COMPOSITION_CONTRACT_VERSION = 1;

export type ProductionInteractiveWorkspaceBindingRequest =
	| {
		kind: "source";
		repositoryId: RepositoryId;
		sourceRepo: string;
		sourceCwd: string;
		requestId?: CommandId;
	}
	| {
		kind: "managed_worktree" | "readonly_checkout";
		repositoryId: RepositoryId;
		sourceRepo: string;
		sourceCwd: string;
		label: string;
		baseRef?: string;
		branch?: string;
		requestId?: CommandId;
	}
	| {
		kind: "resume";
		workspaceId: WorkspaceId;
	};

export interface ProductionInteractiveWorkspaceOptions
	extends Omit<
		ProductionWorkspaceCompositionOptions,
		"scope" | "validatorPrincipalId" | "repository" | "clock"
	> {
	binding: ProductionInteractiveWorkspaceBindingRequest;
}

export interface ProductionInteractiveToolGatewayOptions
	extends Omit<
		ProductionToolGatewayCompositionOptions,
		"stateRoot" | "workspace" | "workspaceResolver" | "fallbackPrincipalId" | "sandboxBackend" | "clock"
	> {
	/** Platform backend 必须由 production caller 显式选择，composition 会实际 probe。 */
	sandboxBackend: SandboxBackend;
}

export interface ProductionInteractiveInitialBindingsInput {
	workspace: PersistedWorkspaceBinding;
	runtimeWorkspace: WorkspaceBindingRef;
	tools: readonly AgentTool[];
	toolIdentityDigests: readonly string[];
	toolSnapshotDigest: string;
	manifests: readonly ProductionToolManifest[];
	extensionCatalog?: ProductionExtensionCatalog;
}

export interface ProductionInteractiveSessionOptions {
	/** 必须是调用方已经组合并 probe 的 production services；本模块不会创建替身。 */
	verification: ProductionVerificationServices;
	compaction: { sampler: CompactionSummarySampler };
	orchestrator: {
		budgetLimits: BudgetLimits;
		loopBreaker: LoopBreaker;
		createInitialBindings(
			input: ProductionInteractiveInitialBindingsInput,
		): OperationBindings | Promise<OperationBindings>;
	};
	memoryRoots?: {
		userRoot?: string;
		projectRoot?: string;
	};
}

export interface ProductionInteractiveExtensionAdapter {
	runtime: ProductionExtensionRuntime;
	/** Adapter 必须负责把 hook input 与 AgentLoop 的 durable tool identity 正确关联。 */
	beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
	afterToolCall: NonNullable<AgentLoopConfig["afterToolCall"]>;
	fragmentProviders?: readonly GovernedContextFragmentProvider[];
}

export interface ProductionInteractiveExtensionFactoryPort {
	create(input: {
		registry: ToolRegistry;
		gateway: ToolExecutionGatewayPort;
		sessionId: string;
		cwd: string;
	}): ProductionInteractiveExtensionAdapter | Promise<ProductionInteractiveExtensionAdapter>;
}

export interface ProductionInteractiveRuntimeOptions {
	/** Composition 接管 manager；启动失败或 close 时均会关闭 writer 与 lease。 */
	manager: V3SessionManager;
	models: Models;
	tools: readonly AgentTool[];
	workspace: ProductionInteractiveWorkspaceOptions;
	toolGateway: ProductionInteractiveToolGatewayOptions;
	session: ProductionInteractiveSessionOptions;
	extension?: ProductionInteractiveExtensionFactoryPort;
	clock?: () => Date;
}

export interface ProductionInteractiveRuntimePaths {
	workspace: ProductionWorkspaceStatePaths;
	toolGateway: ProductionToolGatewayStatePaths;
}

/** 顶层 controller 字段可直接 spread 给 InteractiveSessionController。 */
export interface ProductionInteractiveRuntime {
	readonly sessionId: string;
	readonly cwd: string;
	readonly tools: AgentTool[];
	readonly beforeToolCall?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
	readonly afterToolCall?: NonNullable<AgentLoopConfig["afterToolCall"]>;
	readonly prepareModelRequest: NonNullable<AgentLoopConfig["prepareModelRequest"]>;
	readonly toolExecutionGateway: ToolExecutionGatewayPort;
	readonly sessionEvents: AgentLoopSessionEvents;
	readonly toolResultArtifactSink: ToolResultArtifactSink;
	readonly operationBudget: NonNullable<AgentLoopConfig["operationBudget"]>;
	readonly workspace: PersistedWorkspaceBinding;
	readonly runtimeWorkspace: WorkspaceBindingRef;
	readonly toolRegistry: ToolRegistry;
	readonly sessionRuntime: ProductionSessionRuntime;
	readonly modelRuntime: ProductionModelRuntime;
	readonly featureEvidence: ValidatedProductionComposition;
	readonly paths: ProductionInteractiveRuntimePaths;
	readonly extensionRuntime?: ProductionExtensionRuntime;
	readonly extensionCatalog?: ProductionExtensionCatalog;
	close(): Promise<void>;
}

class StartupGatedToolExecutionGateway implements ToolExecutionGatewayPort {
	readonly #delegate: ToolExecutionGatewayPort;
	#state: "starting" | "ready" | "closing" | "closed" = "starting";
	#active = 0;
	#drainWaiters: Array<() => void> = [];
	#closePromise?: Promise<void>;

	public constructor(delegate: ToolExecutionGatewayPort) {
		this.#delegate = delegate;
	}

	public activate(): void {
		if (this.#state !== "starting") throw new Error("production Tool Gateway cannot be activated from its current state");
		this.#state = "ready";
	}

	public async authorize(
		request: Parameters<ToolExecutionGatewayPort["authorize"]>[0],
		signal?: AbortSignal,
	): Promise<ToolExecutionAuthorizationResult> {
		if (this.#state !== "ready") {
			return {
				status: "unavailable",
				requestId: createRuntimeId("command", `interactive-gateway-closed-${canonicalDigest(request.toolCallId).slice(0, 40)}`),
				reason: "production interactive Tool Gateway is not accepting new authorizations",
			};
		}
		this.#active += 1;
		try {
			return await this.#delegate.authorize(request, signal);
		} finally {
			this.#settleActive();
		}
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
		onUpdate: AgentToolUpdateCallback,
		signal?: AbortSignal,
	): Promise<ToolExecutionGatewayExecuteResult> {
		if (this.#state !== "ready") {
			return {
				status: "unavailable",
				grantDigest: request.grant.grantDigest,
				reason: "production interactive Tool Gateway is closing",
				outcomeCertain: true,
			};
		}
		this.#active += 1;
		try {
			return await this.#delegate.execute(request, onUpdate, signal);
		} finally {
			this.#settleActive();
		}
	}

	public close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#state === "closed") return;
		this.#state = "closing";
		if (this.#active > 0) {
			await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
		}
		this.#state = "closed";
	}

	#settleActive(): void {
		this.#active -= 1;
		if (this.#active !== 0) return;
		for (const resolve of this.#drainWaiters.splice(0)) resolve();
	}
}

function requestIdFor(
	manager: V3SessionManager,
	request: Exclude<ProductionInteractiveWorkspaceBindingRequest, { kind: "resume" }>,
): CommandId {
	return request.requestId ?? createRuntimeId("command", `interactive-workspace-${canonicalDigest({
		sessionId: manager.sessionId(),
		repositoryId: request.repositoryId,
		kind: request.kind,
		sourceRepo: request.sourceRepo,
		sourceCwd: request.sourceCwd,
		...(request.kind === "source" ? {} : {
			label: request.label,
			baseRef: request.baseRef ?? "HEAD",
			branch: request.branch ?? null,
		}),
	}).slice(0, 48)}`);
}

async function bindWorkspace(
	manager: V3SessionManager,
	composition: Awaited<ReturnType<typeof createProductionWorkspaceComposition>>,
	request: ProductionInteractiveWorkspaceBindingRequest,
	traceId: ReturnType<typeof createRuntimeId<"trace">>,
): Promise<WorktreeCreateResult> {
	const identity = manager.identity();
	const context = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		sessionId: manager.sessionId(),
		agentId: manager.sessionEvents().lineage().agentId,
		traceId,
	};
	const result = request.kind === "resume"
		? await composition.manager.resume(request.workspaceId, context, manager.runtimeId())
		: request.kind === "source"
			? await composition.manager.bindSource({
				...context,
				repositoryId: request.repositoryId,
				sourceRepo: request.sourceRepo,
				sourceCwd: request.sourceCwd,
				bindingKind: "source",
				ownerRuntimeId: manager.runtimeId(),
				requestId: requestIdFor(manager, request),
			})
			: await composition.manager.create({
				...context,
				repositoryId: request.repositoryId,
				sourceRepo: request.sourceRepo,
				sourceCwd: request.sourceCwd,
				label: request.label,
				bindingKind: request.kind,
				ownerRuntimeId: manager.runtimeId(),
				requestId: requestIdFor(manager, request),
				...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
				...(request.branch === undefined ? {} : { branch: request.branch }),
			});
	if (!result.ok) throw new Error(`production workspace ${request.kind} failed: ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function releaseEnvelope(
	manager: V3SessionManager,
	workspace: WorktreeCreateResult,
	traceId: ReturnType<typeof createRuntimeId<"trace">>,
): WorkspaceExecutionEnvelope {
	const identity = manager.identity();
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		sessionId: manager.sessionId(),
		workspaceId: workspace.binding.workspaceId,
		repositoryId: workspace.binding.repositoryId,
		worktreePath: workspace.binding.worktreePath,
		branch: workspace.binding.branch,
		baseCommit: workspace.binding.baseCommit,
		agentId: manager.sessionEvents().lineage().agentId,
		toolCallId: createRuntimeId("toolCall", `interactive-release-${canonicalDigest(workspace.binding.bindingDigest).slice(0, 40)}`),
		traceId,
		cwd: workspace.binding.effectiveCwd,
		ownerRuntimeId: workspace.binding.ownerRuntimeId,
		leaseRevision: workspace.binding.leaseRevision,
		fencingToken: workspace.fencingToken,
	};
}

async function releaseWorkspace(
	manager: V3SessionManager,
	composition: Awaited<ReturnType<typeof createProductionWorkspaceComposition>>,
	workspace: WorktreeCreateResult,
	traceId: ReturnType<typeof createRuntimeId<"trace">>,
): Promise<void> {
	const envelope = releaseEnvelope(manager, workspace, traceId);
	const identity = manager.identity();
	const result = await composition.manager.release({
		schemaVersion: 1,
		kind: "release",
		requestId: createRuntimeId("command", `interactive-release-${canonicalDigest({
			workspaceId: envelope.workspaceId,
			leaseRevision: envelope.leaseRevision,
		}).slice(0, 48)}`),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		sessionId: manager.sessionId(),
		agentId: manager.sessionEvents().lineage().agentId,
		traceId,
		envelope,
		envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
		expectedLeaseRevision: envelope.leaseRevision,
	});
	if (!result.ok) throw new Error(`production workspace release failed: ${result.error.code}: ${result.error.message}`);
}

function assertBaseTools(tools: readonly AgentTool[]): void {
	if (tools.length === 0) throw new Error("production interactive runtime requires at least one tool");
	const names = new Set<string>();
	for (const tool of tools) {
		if (!tool.name.trim() || names.has(tool.name) || tool.governedExecution !== "tool-context") {
			throw new Error("production interactive tools must be unique ToolContext-bound tools");
		}
		names.add(tool.name);
	}
}

function assertVerificationServices(
	manager: V3SessionManager,
	verification: ProductionVerificationServices,
): void {
	const identity = manager.identity();
	if (
		verification.implementation !== "production" ||
		verification.authorityId !== identity.authorityId ||
		verification.tenantId !== identity.tenantId ||
		verification.sessionId !== manager.sessionId() ||
		!(verification.pipeline instanceof VerificationPipeline) ||
		!(verification.sessionRuntime instanceof VerificationSessionRuntime) ||
		!/^[a-f0-9]{64}$/u.test(verification.evidenceDigest) ||
		new Set(verification.evidenceDigest).size < 4
	) throw new Error("production verification services are absent or uncorrelated");
}

function assertPeerBinding(
	manager: V3SessionManager,
	binding: ProductionInteractiveToolGatewayOptions["peerBinding"],
	now: Date,
): void {
	const identity = manager.identity();
	const issuedAt = new Date(binding.issuedAt).getTime();
	const expiresAt = binding.expiresAt === undefined ? undefined : new Date(binding.expiresAt).getTime();
	const nowMs = now.getTime();
	if (
		binding.authorityId !== identity.authorityId ||
		binding.tenantId !== identity.tenantId ||
		binding.principalId !== identity.principalId ||
		!Number.isSafeInteger(binding.keyRevision) ||
		binding.keyRevision < 1 ||
		!/^[a-f0-9]{64}$/u.test(binding.channelBindingDigest) ||
		binding.revokedAt !== undefined ||
		!Number.isFinite(nowMs) ||
		!Number.isFinite(issuedAt) ||
		(expiresAt !== undefined && !Number.isFinite(expiresAt)) ||
		issuedAt > nowMs ||
		(expiresAt !== undefined && expiresAt <= nowMs)
	) throw new Error("production capability peer binding is invalid, expired, or outside the session scope");
}

function registerBaseTools(registry: ToolRegistry, tools: readonly AgentTool[]): void {
	for (const tool of tools) {
		if (!registry.register(tool, { namespace: BASE_TOOL_NAMESPACE, version: "1" })) {
			throw new Error(`production tool registry rejected ${tool.name}`);
		}
	}
}

function exactToolSet(
	tools: readonly AgentTool[],
	manifests: readonly ProductionToolManifest[],
	composition: ProductionToolGatewayComposition,
): void {
	const toolNames = tools.map((tool) => tool.name).sort();
	if (new Set(toolNames).size !== toolNames.length || tools.some((tool) => tool.governedExecution !== "tool-context")) {
		throw new Error("final production tool registry contains ambiguous or ungoverned tools");
	}
	const manifestNames = manifests.map((manifest) => manifest.toolName).sort();
	if (
		new Set(manifestNames).size !== manifestNames.length ||
		toolNames.length !== manifestNames.length ||
		toolNames.some((name, index) => name !== manifestNames[index]) ||
		tools.some((tool) => composition.manifestRegistry.forTool(tool.name) === undefined)
	) throw new Error("every advertised production tool must have exactly one matching manifest");
}

function toolIdentityDigests(tools: readonly AgentTool[]): readonly string[] {
	return tools.map((tool) => canonicalDigest(tool.name.trim())).sort();
}

function toolSnapshotDigest(
	tools: readonly AgentTool[],
	manifests: readonly ProductionToolManifest[],
	extensionCatalog?: ProductionExtensionCatalog,
): string {
	const manifestByName = new Map(manifests.map((manifest) => [manifest.toolName, manifest]));
	return canonicalDigest({
		tools: tools.map((tool) => ({
			name: tool.name,
			identityDigest: canonicalDigest(tool.name.trim()),
			manifestDigest: manifestByName.get(tool.name)?.manifestDigest,
		})).sort((left, right) => left.name.localeCompare(right.name)),
		extension: extensionCatalog ? {
			snapshotId: extensionCatalog.snapshotId,
			generation: extensionCatalog.generation,
			pinnedTools: extensionCatalog.pinnedTools.map((tool) => tool.runtimeName).sort(),
		} : null,
	});
}

function assertInitialBindings(
	bindings: OperationBindings,
	workspace: PersistedWorkspaceBinding,
	expectedToolIdentityDigests: readonly string[],
	expectedToolSnapshotDigest: string,
): void {
	const actualDigests = [...bindings.tools.toolIdentityDigests].sort();
	if (
		actualDigests.length !== expectedToolIdentityDigests.length ||
		actualDigests.some((digest, index) => digest !== expectedToolIdentityDigests[index]) ||
		bindings.tools.snapshotDigest !== expectedToolSnapshotDigest ||
		bindings.workspace?.workspaceId !== workspace.workspaceId ||
		bindings.workspace.bindingRevision !== workspace.leaseRevision ||
		bindings.workspace.bindingDigest !== workspace.bindingDigest
	) throw new Error("production initial bindings are not bound to the exact tool and workspace snapshot");
}

function planContextProvider(runtime: ProductionSessionRuntime): GovernedContextFragmentProvider {
	return {
		load: () => {
			const fragment = planModeContextFragment(runtime.plan.snapshot());
			return { fragments: fragment ? [fragment] : [] };
		},
	};
}

function adapterEvidence(input: {
	kind: Parameters<typeof createProductionAdapterEvidence>[0]["kind"];
	features: Parameters<typeof createProductionAdapterEvidence>[0]["features"];
	generation: number;
	issuedAt: string;
	config: unknown;
	probe: unknown;
	evidenceDigest?: string;
}): ProductionAdapterEvidence {
	const expiresAt = new Date(Date.parse(input.issuedAt) + 10 * 60 * 1_000).toISOString();
	const trustEvidenceDigest = canonicalDigest({
		kind: input.kind,
		generation: input.generation,
		config: input.config,
		probe: input.probe,
	});
	return createProductionAdapterEvidence({
		kind: input.kind,
		adapterId: `runledger.production.interactive.${input.kind}`,
		implementationId: `src/storage/production-interactive-runtime.ts#${input.kind}`,
		implementationDigest: canonicalDigest({
			module: "production-interactive-runtime",
			kind: input.kind,
			contractVersion: COMPOSITION_CONTRACT_VERSION,
		}),
		configDigest: canonicalDigest(input.config),
		generation: input.generation,
		health: "healthy",
		features: input.features,
		probe: {
			status: "passed",
			checkedAt: input.issuedAt,
			expiresAt,
			evidenceDigest: input.evidenceDigest ?? canonicalDigest(input.probe),
		},
		trust: {
			status: "trusted",
			issuerId: "runledger.production.interactive.trust",
			issuedAt: input.issuedAt,
			expiresAt,
			evidenceDigest: trustEvidenceDigest,
		},
	});
}

async function deriveFeatureEvidence(input: {
	manager: V3SessionManager;
	workspace: WorktreeCreateResult;
	workspacePaths: ProductionWorkspaceStatePaths;
	toolGateway: ProductionToolGatewayComposition;
	manifests: readonly ProductionToolManifest[];
	sandbox: SandboxBackendCapability;
	policyDigest: string;
	verification: ProductionVerificationServices;
	models: Models;
	extensionCatalog?: ProductionExtensionCatalog;
	clock: () => Date;
}): Promise<ValidatedProductionComposition> {
	const eventStore = input.manager.eventStore();
	const eventChain = await eventStore.verify(eventStore.streamRef());
	if (!eventChain.ok || eventChain.value.integrity !== "valid") {
		throw new Error("production interactive session reader probe failed");
	}
	const head = input.manager.writer().currentHead();
	if (!head || input.manager.isClosed()) throw new Error("production interactive session writer probe failed");
	let queue: Awaited<ReturnType<AgentLoopSessionEvents["inspectQueue"]>>;
	try {
		queue = await input.manager.sessionEvents().inspectQueue();
	} catch {
		throw new Error("production interactive durable queue probe failed");
	}
	if (!/^[a-f0-9]{64}$/u.test(queue.queueRevision)) {
		throw new Error("production interactive durable queue revision is invalid");
	}
	const artifacts = await input.manager.reconcileArtifacts();
	if (!artifacts.ok || artifacts.value.failed.length > 0) {
		throw new Error("production interactive Artifact probe failed");
	}
	const generation = Math.max(1, input.extensionCatalog?.generation ?? 1);
	const issuedAt = input.clock().toISOString();
	const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60 * 1_000).toISOString();
	const commonScope = {
		sessionId: input.manager.sessionId(),
		authorityId: input.manager.identity().authorityId,
		tenantId: input.manager.identity().tenantId,
	};
	const adapters = [
		adapterEvidence({
			kind: "event_store",
			features: ["session", "turn", "queue", "approval", "artifact"],
			generation,
			issuedAt,
			config: { ...commonScope, filePathDigest: canonicalDigest(input.manager.filePath()) },
			probe: { integrity: eventChain.value.integrity, sequence: head.sequence, eventHash: head.eventHash },
		}),
		adapterEvidence({
			kind: "model_provider",
			features: ["turn"],
			generation,
			issuedAt,
			config: {
				providers: input.models.getProviders().map((provider) => provider.id).sort(),
				modelCount: input.models.getModels().length,
			},
			probe: { providerCount: input.models.getProviders().length },
		}),
		adapterEvidence({
			kind: "session_reader",
			features: ["session"],
			generation,
			issuedAt,
			config: { ...commonScope, filePathDigest: canonicalDigest(input.manager.filePath()) },
			probe: { integrity: eventChain.value.integrity, sequence: head.sequence, eventHash: head.eventHash },
		}),
		adapterEvidence({
			kind: "session_writer",
			features: ["session", "turn", "queue"],
			generation,
			issuedAt,
			config: { ...commonScope, runtimeId: input.manager.runtimeId() },
			probe: {
				sequence: head.sequence,
				eventHash: head.eventHash,
				closed: input.manager.isClosed(),
				queueRevision: queue.queueRevision,
				queueItemCount: queue.items.length,
			},
		}),
		adapterEvidence({
			kind: "workspace",
			features: ["session", "turn"],
			generation,
			issuedAt,
			config: { stateRootDigest: canonicalDigest(input.workspacePaths.stateRoot), ...commonScope },
			probe: { bindingDigest: input.workspace.binding.bindingDigest, leaseRevision: input.workspace.binding.leaseRevision },
		}),
		adapterEvidence({
			kind: "capability_gateway",
			features: ["session", "turn", "approval", "artifact"],
			generation,
			issuedAt,
			config: { stateRootDigest: canonicalDigest(input.toolGateway.paths.stateRoot), policyDigest: input.policyDigest },
			probe: {
				manifestDigests: input.manifests.map((manifest) => manifest.manifestDigest).sort(),
				attemptStoreDigest: canonicalDigest(input.toolGateway.paths.attemptsRoot),
				...(input.extensionCatalog ? {
					extensionCatalogDigest: canonicalDigest({
						snapshotId: input.extensionCatalog.snapshotId,
						generation: input.extensionCatalog.generation,
						pinnedTools: input.extensionCatalog.pinnedTools.map((tool) => tool.runtimeName).sort(),
					}),
				} : {}),
			},
		}),
		adapterEvidence({
			kind: "sandbox",
			features: ["session", "turn"],
			generation,
			issuedAt,
			config: { backendId: input.sandbox.backendId, platform: input.sandbox.platform },
			probe: input.sandbox,
		}),
		adapterEvidence({
			kind: "artifact",
			features: ["session", "turn", "artifact"],
			generation,
			issuedAt,
			config: { ...commonScope, stateDirectoryDigest: canonicalDigest(input.manager.stateDirectory()) },
			probe: artifacts.value,
		}),
		adapterEvidence({
			kind: "artifact_key_provider",
			features: ["turn", "artifact"],
			generation,
			issuedAt,
			config: { mode: "metadata-and-redacted-artifacts", encryptedForensic: "deny" },
			probe: { failClosedWhenEncryptedForensicRequested: true },
		}),
		adapterEvidence({
			kind: "resource_catalog",
			features: ["turn"],
			generation,
			issuedAt,
			config: { manifestDigests: input.manifests.map((manifest) => manifest.manifestDigest).sort() },
			probe: { manifestCount: input.manifests.length },
		}),
		adapterEvidence({
			kind: "resource_invoker",
			features: ["turn"],
			generation,
			issuedAt,
			config: { gatewayRootDigest: canonicalDigest(input.toolGateway.paths.stateRoot) },
			probe: { governedInvocation: "tool-context" },
		}),
		adapterEvidence({
			kind: "verifier_registry",
			features: ["session", "turn"],
			generation,
			issuedAt,
			config: { ...commonScope, implementation: input.verification.implementation },
			probe: { pipeline: input.verification.pipeline.constructor.name },
			evidenceDigest: input.verification.evidenceDigest,
		}),
		adapterEvidence({
			kind: "approval",
			features: ["approval"],
			generation,
			issuedAt,
			config: { approvalRootDigest: canonicalDigest(input.toolGateway.paths.approvalsRoot), ...commonScope },
			probe: { approvalCoordinator: input.toolGateway.approvalCoordinator.constructor.name },
		}),
	];
	const scope = {
		authorityId: input.manager.identity().authorityId,
		tenantId: input.manager.identity().tenantId,
		serverInstanceId: input.manager.runtimeId(),
	};
	const receipt = createProductionCompositionReceipt({
		...scope,
		issuerId: "runledger.production.interactive-runtime",
		runtimeGeneration: generation,
		issuedAt,
		expiresAt,
		adapters,
	});
	if (!receipt.ok) throw new Error(`production interactive feature receipt failed: ${receipt.error.message}`);
	const validated = validateProductionCompositionReceipt(receipt.value, scope, { at: new Date(issuedAt) });
	if (!validated.ok || !validated.value.sessionMutationReady || !validated.value.features.includes("turn")) {
		throw new Error("production interactive feature evidence does not authorize turn execution");
	}
	return validated.value;
}

function restrictiveSandbox(capability: SandboxBackendCapability): boolean {
	return (
		(capability.status === "available" || capability.status === "external") &&
		capability.supportsFilesystemIsolation &&
		capability.supportsNetworkDeny &&
		capability.supportsChildIsolation
	);
}

async function collectCloseError(errors: unknown[], operation: () => Promise<void>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(error);
	}
}

/**
 * 组合成功前不暴露可执行 Gateway；任一步失败都会反向释放 lease 与 session writer。
 */
export async function createProductionInteractiveRuntime(
	options: ProductionInteractiveRuntimeOptions,
): Promise<ProductionInteractiveRuntime> {
	const manager = options.manager;
	const clock = options.clock ?? (() => new Date());
	if (manager.isClosed()) throw new Error("production interactive runtime requires an open V3 session manager");
	const identity = manager.identity();
	const traceId = createRuntimeId("trace", `interactive-${canonicalDigest({
		sessionId: manager.sessionId(),
		runtimeId: manager.runtimeId(),
	}).slice(0, 48)}`);
	let workspaceComposition: Awaited<ReturnType<typeof createProductionWorkspaceComposition>> | undefined;
	let workspaceResult: WorktreeCreateResult | undefined;
	let gateway: StartupGatedToolExecutionGateway | undefined;
	let extensionAdapter: ProductionInteractiveExtensionAdapter | undefined;
	let extensionStarted = false;
	let workspaceReleased = false;

	const closeOwnedResources = async (): Promise<void> => {
		const errors: unknown[] = [];
		if (gateway) await collectCloseError(errors, () => gateway!.close());
		if (extensionAdapter && extensionStarted) {
			await collectCloseError(errors, async () => {
				const ended = await extensionAdapter!.runtime.sessionEnd({ reason: "interactive runtime shutdown" });
				if (ended.status === "blocked") throw new Error(`extension SessionEnd blocked: ${ended.reason}`);
			});
		}
		if (extensionAdapter) await collectCloseError(errors, () => extensionAdapter!.runtime.close());
		if (workspaceComposition && workspaceResult && !workspaceReleased) {
			await collectCloseError(errors, async () => {
				await releaseWorkspace(manager, workspaceComposition!, workspaceResult!, traceId);
				workspaceReleased = true;
			});
		}
		await collectCloseError(errors, () => manager.closeAll());
		if (errors.length > 0) throw new AggregateError(errors, "production interactive runtime close failed");
	};

	try {
		assertBaseTools(options.tools);
		assertVerificationServices(manager, options.session.verification);
		assertPeerBinding(manager, options.toolGateway.peerBinding, clock());
		const { binding: workspaceBindingRequest, ...workspaceOptions } = options.workspace;
		workspaceComposition = await createProductionWorkspaceComposition({
			...workspaceOptions,
			scope: { authorityId: identity.authorityId, tenantId: identity.tenantId },
			validatorPrincipalId: identity.principalId,
			repository: manager.artifactRepository(),
			clock,
		});
		workspaceResult = await bindWorkspace(manager, workspaceComposition, workspaceBindingRequest, traceId);
		const binding = workspaceResult.binding;
		if (
			binding.authorityId !== identity.authorityId ||
			binding.tenantId !== identity.tenantId ||
			binding.principalId !== identity.principalId ||
			binding.sessionId !== manager.sessionId() ||
			binding.ownerRuntimeId !== manager.runtimeId()
		) throw new Error("production workspace binding is outside the active session scope");
		const registered = await workspaceComposition.registry.get(binding.workspaceId);
		if (!registered.ok || registered.value?.state !== "active" || registered.value.leaseRevision !== binding.leaseRevision) {
			throw new Error("production workspace registry probe failed");
		}

		const sandboxCapability = await options.toolGateway.sandboxBackend.probe();
		if (!restrictiveSandbox(sandboxCapability)) throw new Error("production sandbox does not provide restrictive enforcement");
		const policyDigest = await options.toolGateway.snapshots.currentPolicyDigest(binding.workspaceId);
		const securitySnapshot = await options.toolGateway.snapshots.resolve(policyDigest, binding.workspaceId);
		if (
			!securitySnapshot.ok ||
			securitySnapshot.value.policyDigest !== policyDigest ||
			securitySnapshot.value.workspaceRoot !== binding.worktreePath
		) throw new Error("production security snapshot probe failed");

		const resolver = workspaceComposition.createToolExecutionWorkspaceResolver({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			sessionId: manager.sessionId(),
			agentId: manager.sessionEvents().lineage().agentId,
			traceId,
			workspaceId: binding.workspaceId,
			repositoryId: binding.repositoryId,
			ownerRuntimeId: manager.runtimeId(),
		});
		const toolGatewayComposition = await createProductionToolGatewayComposition({
			...options.toolGateway,
			stateRoot: join(workspaceComposition.paths.stateRoot, "tool-gateway"),
			workspace: workspaceComposition.workspaceService,
			workspaceResolver: resolver,
			fallbackPrincipalId: identity.principalId,
			sandboxBackend: options.toolGateway.sandboxBackend,
			clock,
		});
		gateway = new StartupGatedToolExecutionGateway(toolGatewayComposition.toolExecutionGateway);

		const registry = new ToolRegistry();
		registerBaseTools(registry, options.tools);
		let extensionCatalog: ProductionExtensionCatalog | undefined;
		if (options.extension) {
			extensionAdapter = await options.extension.create({
				registry,
				gateway,
				sessionId: manager.sessionId(),
				cwd: binding.effectiveCwd,
			});
			if (!(extensionAdapter.runtime instanceof ProductionExtensionRuntime)) {
				throw new Error("production extension factory did not return a ProductionExtensionRuntime");
			}
			const started = await extensionAdapter.runtime.start();
			if (started.status !== "ready") throw new Error(`production extension startup failed: ${started.reason}`);
			extensionCatalog = extensionAdapter.runtime.catalog();
			if (
				!extensionCatalog ||
				extensionCatalog.snapshotId !== started.snapshotId ||
				extensionCatalog.generation !== started.generation
			) throw new Error("production extension catalog is absent or uncorrelated");
			const sessionStarted = await extensionAdapter.runtime.sessionStart({ sessionId: manager.sessionId() });
			if (sessionStarted.status === "blocked") {
				throw new Error(`production extension SessionStart blocked: ${sessionStarted.reason}`);
			}
			extensionStarted = true;
		}

		const tools = registry.toContext();
		exactToolSet(tools, options.toolGateway.manifests, toolGatewayComposition);
		const expectedToolIdentities = toolIdentityDigests(tools);
		const expectedToolSnapshot = toolSnapshotDigest(tools, options.toolGateway.manifests, extensionCatalog);
		const initialBindings = await options.session.orchestrator.createInitialBindings({
			workspace: structuredClone(binding),
			runtimeWorkspace: structuredClone(workspaceResult.runtimeBinding),
			tools: [...tools],
			toolIdentityDigests: expectedToolIdentities,
			toolSnapshotDigest: expectedToolSnapshot,
			manifests: options.toolGateway.manifests.map((manifest) => structuredClone(manifest)),
			...(extensionCatalog ? { extensionCatalog } : {}),
		});
		assertInitialBindings(initialBindings, binding, expectedToolIdentities, expectedToolSnapshot);

		const sessionRuntime = await createProductionSessionRuntime({
			manager,
			workspace: binding,
			verification: options.session.verification,
			compaction: options.session.compaction,
			orchestrator: {
				budgetLimits: options.session.orchestrator.budgetLimits,
				initialBindings,
				loopBreaker: options.session.orchestrator.loopBreaker,
			},
			...(options.session.memoryRoots === undefined ? {} : { memoryRoots: options.session.memoryRoots }),
			clock,
		});
		const fragmentProviders: GovernedContextFragmentProvider[] = [
			new WorkspaceContextProvider(workspaceResult.runtimeBinding),
			new MemoryContextProvider({ service: sessionRuntime.memory, scopes: sessionRuntime.memoryScopes }),
			planContextProvider(sessionRuntime),
			...(extensionAdapter?.fragmentProviders ?? []),
		];
		const modelRuntime = createProductionModelRuntime({
			models: options.models,
			sessionEvents: manager.sessionEvents(),
			identity: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				sessionId: manager.sessionId(),
			},
			workspace: workspaceResult.runtimeBinding,
			fragmentProviders,
		});
		const featureEvidence = await deriveFeatureEvidence({
			manager,
			workspace: workspaceResult,
			workspacePaths: workspaceComposition.paths,
			toolGateway: toolGatewayComposition,
			manifests: options.toolGateway.manifests,
			sandbox: sandboxCapability,
			policyDigest,
			verification: options.session.verification,
			models: options.models,
			...(extensionCatalog ? { extensionCatalog } : {}),
			clock,
		});
		gateway.activate();

		let closePromise: Promise<void> | undefined;
		const close = (): Promise<void> => {
			closePromise ??= closeOwnedResources();
			return closePromise;
		};
		return {
			sessionId: manager.sessionId(),
			cwd: binding.effectiveCwd,
			tools: [...tools],
			...(extensionAdapter ? {
				beforeToolCall: extensionAdapter.beforeToolCall,
				afterToolCall: extensionAdapter.afterToolCall,
				extensionRuntime: extensionAdapter.runtime,
				extensionCatalog,
			} : {}),
			prepareModelRequest: modelRuntime.prepare,
			toolExecutionGateway: gateway,
			sessionEvents: manager.sessionEvents(),
			toolResultArtifactSink: manager.toolResultArtifactSink(),
			operationBudget: sessionRuntime.operationBudget,
			workspace: structuredClone(binding),
			runtimeWorkspace: structuredClone(workspaceResult.runtimeBinding),
			toolRegistry: registry,
			sessionRuntime,
			modelRuntime,
			featureEvidence,
			paths: {
				workspace: { ...workspaceComposition.paths },
				toolGateway: { ...toolGatewayComposition.paths },
			},
			close,
		};
	} catch (error) {
		try {
			await closeOwnedResources();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "production interactive runtime startup failed and cleanup was incomplete");
		}
		throw error;
	}
}
