import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "../../../src/models.ts";
import { ArtifactAccessService } from "../../../src/runtime/artifacts/access.ts";
import type {
	ArtifactAccessLogPort,
	ArtifactCapabilityGatewayPort,
	ArtifactResult,
} from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { InputSourceRef } from "../../../src/runtime/protocol/v3/taint.ts";
import type { SecuritySnapshot } from "../../../src/security/types.ts";
import type {
	EnterprisePortResult,
	CredentialAudienceBindingRef,
	CredentialAudienceBindingRequest,
} from "../../../src/runtime/identity/enterprise-types.ts";
import type { CredentialAudienceBindingResolverPort } from "../../../src/security/integration/credential-broker-adapter.ts";
import { MemoryCapabilityRateLimiter } from "../../../src/security/integration/capability-rate-limiter.ts";
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
import type { AgentTool, ToolExecutionGatewayRequest } from "../../../src/runtime/types.ts";
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
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	for (const harness of worktrees.splice(0)) await harness.cleanup();
	for (const harness of artifacts.splice(0)) await harness.cleanup();
});

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
	readonly #workspaceRoot: string;
	readonly #stateRoot: string;

	public constructor(workspaceRoot: string, stateRoot: string) {
		this.#workspaceRoot = workspaceRoot;
		this.#stateRoot = stateRoot;
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

function unavailableCredential() {
	return {
		ok: false as const,
		error: { code: "credential_unavailable" as const, message: "credential is not configured", retryable: false },
	};
}

function invocation(tool: AgentTool, cwd: string, seed: string): ToolExecutionGatewayRequest {
	return {
		toolCallId: createRuntimeId("toolCall", seed),
		providerToolCallId: `provider-${seed}`,
		tool,
		arguments: { path: join(cwd, "index.ts") },
		cwd,
		envVars: {},
	};
}

describe("production interactive runtime composition", () => {
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
		expect(await runtime.toolExecutionGateway.authorize(invocation(setup.tool, runtime.cwd, "after-close"))).toMatchObject({
			status: "unavailable",
		});
		const registry = await readFile(runtime.paths.workspace.registryFile, "utf8");
		expect(registry).toContain('"state":"retained"');
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

	it("reopens the durable session and resumes the released workspace without duplicate goal genesis", async () => {
		const setup = await fixture();
		const first = await createProductionInteractiveRuntime(setup.options());
		const firstGoal = first.sessionRuntime.goal.snapshot();
		const workspaceId = first.workspace.workspaceId;
		const sessionId = first.sessionId;
		const filePath = setup.manager.filePath();
		const sequence = setup.manager.writer().currentHead()?.sequence;
		await first.close();

		const reopenedManager = await V3SessionManager.open(filePath, setup.features);
		managers.push(reopenedManager);
		const reopenedOptions = setup.options({ kind: "resume", workspaceId }, reopenedManager);
		const second = await createProductionInteractiveRuntime(reopenedOptions);
		expect(second.sessionId).toBe(sessionId);
		expect(second.workspace).toMatchObject({ workspaceId, leaseRevision: 2, ownerRuntimeId: reopenedManager.runtimeId() });
		expect(second.sessionRuntime.goal.snapshot()).toEqual(firstGoal);
		expect(reopenedManager.writer().currentHead()?.sequence).toBe(sequence);
		await second.close();
	});
});
