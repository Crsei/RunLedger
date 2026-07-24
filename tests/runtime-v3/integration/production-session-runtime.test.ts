import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import type {
	ApprovalReceiptRef,
	ArtifactRef,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../src/runtime/orchestrator/budget-guard.ts";
import { LoopBreaker } from "../../../src/runtime/orchestrator/loop-breaker.ts";
import { CanonicalAgentQueueAdapter } from "../../../src/runtime/orchestrator/canonical-queue.ts";
import type { OperationBindings } from "../../../src/runtime/orchestrator/types.ts";
import {
	createProductionSessionRuntime,
	type ProductionSessionRuntime,
	type ProductionVerificationServices,
} from "../../../src/runtime/integration/production-session-runtime.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { PersistedWorkspaceBinding } from "../../../src/worktree/types.ts";
import {
	ProductionPlanContextMemoryControlPlaneExecutor,
	memoryProposalArtifactDigest,
	type ActivePlanContextMemorySessionResolverPort,
	type MemoryProposalArtifactDocument,
	type PlanContextMemoryArtifactAccessPort,
	type ProductionPlanContextMemorySessionPort,
} from "../../../src/runtime/integration/production-plan-context-memory-control-plane.ts";
import type {
	ArtifactMetadata,
	ArtifactReadRequest,
	ArtifactReadResult,
	ArtifactResult,
} from "../../../src/runtime/artifacts/types.ts";
import type { ControlPlaneRequestContext } from "../../../src/runtime/control-plane/types.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import type {
	MemoryScopeRef,
	MemorySourceRef,
} from "../../../src/runtime/context/memory/types.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function limits(): BudgetLimits {
	return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { soft: 100_000, hard: 1_000_000 }])) as BudgetLimits;
}

function binding(manager: V3SessionManager, root: string): PersistedWorkspaceBinding {
	const identity = manager.identity();
	const body: Omit<PersistedWorkspaceBinding, "bindingDigest"> = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		sessionId: manager.sessionId(),
		bindingKind: "source",
		workspaceId: createRuntimeId("workspace", "production-session"),
		repositoryId: createRuntimeId("repository", "production-session"),
		sourceRepo: root,
		sourceCwd: root,
		effectiveCwd: root,
		worktreePath: root,
		subdirOffset: ".",
		baseCommit: "0123456789abcdef",
		headCommit: "0123456789abcdef",
		branch: "worktree/production-session",
		leaseId: createRuntimeId("lease", "production-session"),
		leaseRevision: 1,
		ownerRuntimeId: manager.runtimeId(),
	};
	return { ...body, bindingDigest: canonicalDigest(body) };
}

function bindings(workspace: PersistedWorkspaceBinding): OperationBindings {
	const digest = canonicalDigest("production-binding");
	return {
		model: {
			modelId: "fixture/model",
			profileId: createRuntimeId("resource", "production-model-profile"),
			manifestDigest: digest,
			profileDigest: canonicalDigest("production-model-profile"),
		},
		tools: {
			snapshotId: createRuntimeId("snapshot", "production-tools"),
			snapshotDigest: canonicalDigest("production-tools"),
			toolIdentityDigests: [canonicalDigest("read")],
		},
		resources: {
			snapshotId: createRuntimeId("snapshot", "production-resources"),
			snapshotDigest: canonicalDigest("production-resources"),
			adapterGeneration: 1,
			adapterGenerationDigest: canonicalDigest("production-generation"),
		},
		config: { revision: 1, configDigest: canonicalDigest("production-config") },
		workspace: {
			workspaceId: workspace.workspaceId,
			bindingRevision: workspace.leaseRevision,
			bindingDigest: workspace.bindingDigest,
		},
		capabilities: [],
	};
}

function verification(manager: V3SessionManager): ProductionVerificationServices {
	const unavailable = {
		ok: false as const,
		error: { code: "evidence_unavailable" as const, message: "fixture is not invoked", retryable: false },
	};
	const policy: TrustedVerificationPolicyPort = { resolve: async () => unavailable };
	const workspace: WorkspaceServicePort = {
		request: async (request) => ({
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "rejected",
			code: "unavailable",
			messageDigest: canonicalDigest("fixture is not invoked"),
			retryable: false,
		}),
	};
	const baseline = new TrustedBaselineCoordinator({ policy, workspace });
	const gateSource: TrustedGateSourcePort = { read: async () => unavailable };
	const runner: VerificationRunnerPort = { run: async () => unavailable };
	const issuer: VerifierIssuerPort = { issue: async () => unavailable };
	const registry = new TrustedVerifierIssuerRegistry({ environment: "production" });
	const sessionRuntime = manager.createVerificationSessionRuntime();
	const pipeline = new VerificationPipeline({ baseline, gateSource, runner, issuer, issuerRegistry: registry, journal: sessionRuntime });
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

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "runledger-production-session-"));
	roots.push(root);
	const features: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
	const manager = await V3SessionManager.create({ cwd: root, sessionDir: join(root, "sessions"), features });
	managers.push(manager);
	const workspace = binding(manager, root);
	const options = {
		manager,
		workspace,
		verification: verification(manager),
		compaction: {
			sampler: { sample: async () => "bounded production summary" },
			summarizerProfileId: createRuntimeId("resource", "production-summarizer"),
			summarizerProfileDigest: canonicalDigest("production-summarizer"),
			retainedTurns: 1,
			maxInputChars: 128 * 1024,
			maxSummaryTokens: 2_048,
			targetInputBudget: 8_192,
			timeoutMs: 30_000,
		},
		orchestrator: {
			budgetLimits: limits(),
			initialBindings: bindings(workspace),
			loopBreaker: new LoopBreaker({
				maxRepeatedToolSignature: 3,
				maxRepeatedFailure: 3,
				maxNoProgress: 3,
				maxRemediationAttempts: 3,
			}),
		},
		memoryRoots: { userRoot: join(root, "user"), projectRoot: join(root, "project") },
	} as const;
	return { manager, workspace, options };
}

class MemoryArtifactAccess implements PlanContextMemoryArtifactAccessPort {
	readonly #entries = new Map<string, ArtifactReadResult>();
	public readCount = 0;

	public add(
		manager: V3SessionManager,
		workspace: PersistedWorkspaceBinding,
		kind: "change_proposal" | "diff",
		body: string,
		seed: string,
	): ArtifactRef {
		const identity = manager.identity();
		const content = new TextEncoder().encode(body);
		const storedDigest = canonicalDigest(body);
		const artifactId = createRuntimeId("artifact", seed);
		const receiptId = createRuntimeId("receipt", `${seed}-transform`);
		const policy = { policyId: "production-memory-test", version: 1 };
		const sourceReceipt = {
			status: "legacy_unverified" as const,
			reason: "legacy_tmp_import" as const,
		};
		const metadataBody: Omit<ArtifactMetadata, "metadataDigest"> = {
			schemaVersion: 1,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId,
			intentId: createRuntimeId("command", `${seed}-intent`),
			state: "committed",
			kind,
			mediaType: kind === "change_proposal"
				? "application/json"
				: "text/plain",
			originalSize: content.byteLength,
			storedSize: content.byteLength,
			compression: "none",
			storedDigest,
			source: {
				sessionId: manager.sessionId(),
				workspaceId: workspace.workspaceId,
				producerId: identity.principalId,
			},
			sourceReceipt,
			redaction: "metadata_only",
			redactionPolicy: policy,
			transformReceipt: {
				receiptId,
				receiptDigest: canonicalDigest(`${seed}-transform`),
				policy,
				redaction: "metadata_only",
				replacementCount: 0,
				sourceReceipt,
				keyState: "available",
			},
			lineage: {
				origin: "user",
				status: "verified",
				inputSources: [],
				taintUpperBound: [],
				declassificationReceipts: [],
				lineageDigest: canonicalDigest(`${seed}-lineage`),
			},
			references: [],
			pins: [],
			referenceCount: 1,
			legalHold: { status: "none" },
			evidenceStatus: "verified_transform",
			createdAt: "2026-07-24T00:00:00.000Z",
			committedAt: "2026-07-24T00:00:00.000Z",
		};
		const metadata: ArtifactMetadata = {
			...metadataBody,
			metadataDigest: canonicalDigest(metadataBody),
		};
		this.#entries.set(artifactId, { metadata, content });
		return {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId,
			storedDigest,
			kind,
			originalSize: content.byteLength,
			storedSize: content.byteLength,
			mediaType: metadata.mediaType,
			redaction: metadata.redaction,
			transformReceipt: receiptId,
			workspaceId: workspace.workspaceId,
		};
	}

	public async read(
		request: ArtifactReadRequest,
	): Promise<ArtifactResult<ArtifactReadResult>> {
		this.readCount += 1;
		const entry = this.#entries.get(request.artifactId);
		if (
			!entry ||
			entry.metadata.authorityId !== request.authorityId ||
			entry.metadata.tenantId !== request.tenantId ||
			entry.metadata.source.sessionId !== request.sessionId ||
			entry.metadata.source.workspaceId !== request.workspaceId
		) {
			return {
				ok: false,
				error: {
					code: "authorization_denied",
					message: "strict fixture scope mismatch",
					retryable: false,
				},
			};
		}
		return { ok: true, value: structuredClone(entry) };
	}
}

function requestContext(manager: V3SessionManager): ControlPlaneRequestContext {
	const identity = manager.identity();
	return {
		peer: {
			kind: "local",
			transport: "jsonl",
			pid: process.pid,
			uid: null,
			principalId: identity.principalId,
			authenticatedVia: "stdio_parent",
		},
		handshake: {
			kind: "handshake_result",
			requestId: "production-specialty",
			protocol: { major: 1, minor: 1 },
			controlPlaneSchemaVersion: 2,
			runtimeSchemaVersion: 3,
			features: ["plan_context_memory"],
			serverInstanceId: manager.runtimeId(),
			remoteAccess: "disabled",
			deliveryGuarantee: "at_least_once",
		},
	};
}

function approvalReceipt(
	manager: V3SessionManager,
	approvalId: ApprovalReceiptRef["approvalId"],
	seed: string,
	decision: ApprovalReceiptRef["decision"] = "allowed",
): ApprovalReceiptRef {
	const identity = manager.identity();
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		receiptId: createRuntimeId("receipt", seed),
		approvalId,
		requestId: createRuntimeId("command", `${seed}-request`),
		requestDigest: canonicalDigest(`${seed}-request`),
		ticketDigest: canonicalDigest(`${seed}-ticket`),
		decision,
		decisionRevision: 1,
		decidedBy: identity.principalId,
		decidedAt: "2026-07-24T00:00:00.000Z",
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: canonicalDigest(`${seed}-input`),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function expectedRevision(manager: V3SessionManager) {
	const head = manager.writer().currentHead();
	if (!head) throw new Error("fixture has no durable head");
	return {
		stream: head.stream,
		sequence: head.sequence,
		eventHash: head.eventHash,
	};
}

function trustedMemorySource(manager: V3SessionManager): MemorySourceRef {
	const identity = manager.identity();
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sourceDigest: canonicalDigest("production-memory-source"),
		trust: "user_approved",
		taint: [],
		observedAt: "2026-07-24T00:00:00.000Z",
		sourceType: "user",
		principalId: identity.principalId,
	};
}

function specialtySession(
	manager: V3SessionManager,
	workspace: PersistedWorkspaceBinding,
	runtime: ProductionSessionRuntime,
	artifacts: PlanContextMemoryArtifactAccessPort = {
		read: async () => ({
			ok: false,
			error: {
				code: "authorization_unavailable",
				message: "fixture artifact access is not configured",
				retryable: false,
			},
		}),
	},
): ProductionPlanContextMemorySessionPort {
	return {
		manager,
		workspace,
		runtimeWorkspace: {
			authorityId: workspace.authorityId,
			tenantId: workspace.tenantId,
			workspaceId: workspace.workspaceId,
			repositoryId: workspace.repositoryId,
			bindingKind: workspace.bindingKind,
			canonicalCwd: workspace.worktreePath,
			effectiveCwd: workspace.effectiveCwd,
			branch: workspace.branch,
			baseCommit: workspace.baseCommit,
			headCommit: workspace.headCommit,
		},
		plan: runtime.plan,
		memoryStore: runtime.memoryStore,
		memory: runtime.memory,
		memoryScopes: runtime.memoryScopes,
		compactionProjection: runtime.compactionProjection,
		compaction: runtime.compaction,
		compactionPolicy: runtime.compactionPolicy,
		goal: runtime.goal,
		tasks: runtime.tasks,
		verification: runtime.verification,
		artifacts,
		waitForIdle: async () => undefined,
	};
}

describe("production session runtime composition", () => {
	it("uses v3 journals and file stores, then reopens the same goal without duplicate genesis", async () => {
		const { manager, workspace, options } = await setup();
		const first = await createProductionSessionRuntime(options);
		expect(first.workspace.bindingDigest).toBe(workspace.bindingDigest);
		expect(first.queue).toBeInstanceOf(CanonicalAgentQueueAdapter);
		expect(first.readiness.entries.every((entry) => entry.status === "external_gap")).toBe(true);
		expect(first.control).toBeDefined();
		expect(first.turns.observeLoop({
			observationId: "model-only-observation",
			phase: "implementation",
			madeProgress: true,
			observedAt: "2026-07-24T00:00:00.000Z",
		}).ok).toBe(false);
		expect(first.lifecycle.snapshot().goal.phase).toBe("planning");
		const lifecycle = await first.lifecycle.run();
		expect(lifecycle.ok && lifecycle.value.reason).toBe("plan_missing");
		expect(first.goal.snapshot()).toMatchObject({ goalId: manager.sessionEvents().lineage().goalId, phase: "planning", revision: 0 });
		expect(first.memoryScopes).toEqual([
			{ scope: "session", sessionId: manager.sessionId() },
			{ scope: "workspace", workspaceId: workspace.workspaceId },
			{ scope: "user", ownerPrincipalId: manager.identity().principalId },
		]);
		const before = manager.writer().currentHead()?.sequence;
		const page = await manager.eventStore().readPage({ limit: 100 });
		expect(page.ok && page.value.events.some(
			(event) => event.type === "orchestrator.journal_committed" && event.payload.journalKind === "queue",
		)).toBe(false);
		const reopened = await createProductionSessionRuntime(options);
		expect(reopened.goal.snapshot()).toEqual(first.goal.snapshot());
		expect(manager.writer().currentHead()?.sequence).toBe(before);
	});

	it("persists Plan Mode projection only after the canonical transition and recovers it", async () => {
		const { manager, options } = await setup();
		const first = await createProductionSessionRuntime(options);
		const head = manager.writer().currentHead();
		if (!head) throw new Error("fixture has no v3 head");
		await first.plan.requestActivation(
			"user",
			{ stream: head.stream, sequence: head.sequence, eventHash: head.eventHash },
			createRuntimeId("trace", "production-plan"),
			createRuntimeId("command", "production-plan"),
		);
		const reopened = await createProductionSessionRuntime(options);
		expect(reopened.plan.snapshot()).toMatchObject({ kind: "pending_activation", modeRevision: 1 });
	});

	it("executes schema-v2 Plan mutations and queries against the exact active production runtime", async () => {
		const { manager, workspace, options } = await setup();
		const runtime = await createProductionSessionRuntime(options);
		const sessions: ActivePlanContextMemorySessionResolverPort = {
			withSession: async (sessionId, operation) => {
				if (sessionId !== manager.sessionId()) {
					return {
						ok: false,
						error: {
							code: "stale_session_handle",
							message: "fixture session is absent",
							retryable: false,
						},
						effect: "none",
					};
				}
				return operation(specialtySession(manager, workspace, runtime));
			},
		};
		const executor = new ProductionPlanContextMemoryControlPlaneExecutor(sessions);
		const identity = manager.identity();
		const head = manager.writer().currentHead();
		if (!head) throw new Error("fixture has no v3 head");
		const context: ControlPlaneRequestContext = {
			peer: {
				kind: "local",
				transport: "jsonl",
				pid: process.pid,
				uid: null,
				principalId: identity.principalId,
				authenticatedVia: "stdio_parent",
			},
			handshake: {
				kind: "handshake_result",
				requestId: "production-specialty",
				protocol: { major: 1, minor: 1 },
				controlPlaneSchemaVersion: 2,
				runtimeSchemaVersion: 3,
				features: ["plan_context_memory"],
				serverInstanceId: manager.runtimeId(),
				remoteAccess: "disabled",
				deliveryGuarantee: "at_least_once",
			},
		};
		const handle = {
			handleId: "handle_production_specialty",
			sessionId: manager.sessionId(),
			generation: 1,
		};
		const entered = await executor.execute({
			kind: "command",
			type: "plan:enter",
			commandId: createRuntimeId("command", "production-specialty-enter"),
			idempotencyKey: createIdempotencyKey("production-specialty-enter"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: {
				stream: head.stream,
				sequence: head.sequence,
				eventHash: head.eventHash,
			},
			expectedDomainRevision: 0,
			sessionHandle: handle,
			payload: { sessionId: manager.sessionId(), requestedBy: "user" },
		}, context);
		expect(entered).toMatchObject({
			ok: true,
			value: {
				type: "plan:enter",
				domainRevision: 1,
				stateKind: "pending_activation",
				modeRevision: 1,
			},
		});
		const inspected = await executor.query({
			kind: "query",
			type: "plan:inspect",
			queryId: "production-specialty-inspect",
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			payload: { sessionId: manager.sessionId(), sessionHandle: handle },
		}, context);
		expect(inspected).toMatchObject({
			ok: true,
			value: {
				type: "plan:inspect",
				result: {
					type: "plan:inspect",
					state: { kind: "pending_activation", modeRevision: 1 },
				},
			},
		});
		const stale = await executor.execute({
			kind: "command",
			type: "plan:enter",
			commandId: createRuntimeId("command", "production-specialty-stale"),
			idempotencyKey: createIdempotencyKey("production-specialty-stale"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: {
				stream: head.stream,
				sequence: head.sequence,
				eventHash: head.eventHash,
			},
			expectedDomainRevision: 1,
			sessionHandle: handle,
			payload: { sessionId: manager.sessionId(), requestedBy: "user" },
		}, context);
		expect(stale).toMatchObject({
			ok: false,
			error: { code: "expected_revision_conflict" },
		});
	});

	it("resolves an exact pending Plan approval through the production specialty executor", async () => {
		const { manager, workspace, options } = await setup();
		const runtime = await createProductionSessionRuntime(options);
		await runtime.plan.requestActivation(
			"user",
			expectedRevision(manager),
			createRuntimeId("trace", "production-plan-resolve-enter"),
			createRuntimeId("command", "production-plan-resolve-enter"),
		);
		await runtime.plan.activateAtSafePoint(
			expectedRevision(manager),
			createRuntimeId("trace", "production-plan-resolve-activate"),
			"# Approved implementation plan",
			createRuntimeId("command", "production-plan-resolve-activate"),
		);
		await runtime.plan.requestApproval(
			expectedRevision(manager),
			createRuntimeId("trace", "production-plan-resolve-request"),
			createRuntimeId("command", "production-plan-resolve-request"),
		);
		const awaiting = runtime.plan.snapshot();
		if (awaiting.kind !== "awaiting_approval") {
			throw new Error("fixture plan is not awaiting approval");
		}
		const executor = new ProductionPlanContextMemoryControlPlaneExecutor({
			withSession: async (_sessionId, operation) =>
				operation(specialtySession(manager, workspace, runtime)),
		});
		const receipt = approvalReceipt(
			manager,
			awaiting.approval.approvalId,
			"production-plan-resolve",
		);
		const result = await executor.execute({
			kind: "command",
			type: "plan:resolve",
			commandId: createRuntimeId("command", "production-plan-resolve"),
			idempotencyKey: createIdempotencyKey("production-plan-resolve"),
			authorityId: manager.identity().authorityId,
			tenantId: manager.identity().tenantId,
			principalId: manager.identity().principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: awaiting.modeRevision,
			sessionHandle: {
				handleId: "handle_production_plan_resolve",
				sessionId: manager.sessionId(),
				generation: 1,
			},
			payload: {
				sessionId: manager.sessionId(),
				approvalId: awaiting.approval.approvalId,
				planId: awaiting.plan.planId,
				action: "approve_same_session",
				expectedModeRevision: awaiting.modeRevision,
				expectedPlanRevision: awaiting.plan.revision,
				contentDigest: awaiting.plan.contentDigest,
				resolutionReceipt: receipt,
			},
		}, requestContext(manager));
		expect(result).toMatchObject({
			ok: true,
			value: {
				type: "plan:resolve",
				stateKind: "exit_pending",
				modeRevision: awaiting.modeRevision + 1,
			},
		});
		expect(runtime.plan.snapshot()).toMatchObject({
			kind: "exit_pending",
			reason: "approved",
			approvedPlan: {
				planId: awaiting.plan.planId,
				revision: awaiting.plan.revision,
				contentDigest: awaiting.plan.contentDigest,
				approvalReceipt: { receiptId: receipt.receiptId },
			},
		});
	});

	it("publishes and revokes artifact-backed Memory through exact production revisions", async () => {
		const { manager, workspace, options } = await setup();
		const runtime = await createProductionSessionRuntime(options);
		const artifacts = new MemoryArtifactAccess();
		const executor = new ProductionPlanContextMemoryControlPlaneExecutor({
			withSession: async (_sessionId, operation) =>
				operation(specialtySession(manager, workspace, runtime, artifacts)),
		});
		const identity = manager.identity();
		const scope: MemoryScopeRef = {
			scope: "workspace",
			workspaceId: workspace.workspaceId,
		};
		const handle = {
			handleId: "handle_production_memory",
			sessionId: manager.sessionId(),
			generation: 1,
		};
		const createDraft: MemoryProposalArtifactDocument = {
			schemaVersion: 1,
			operation: "create",
			title: "Production memory",
			content: "Only approved artifact-backed memory is canonical.",
			scope,
			sourceRefs: [trustedMemorySource(manager)],
		};
		const createDiff = "create production memory";
		const createDraftRef = artifacts.add(
			manager,
			workspace,
			"change_proposal",
			JSON.stringify(createDraft),
			"production-memory-create-draft",
		);
		const createDiffRef = artifacts.add(
			manager,
			workspace,
			"diff",
			createDiff,
			"production-memory-create-diff",
		);
		const proposed = await executor.execute({
			kind: "command",
			type: "memory:propose",
			commandId: createRuntimeId("command", "production-memory-create"),
			idempotencyKey: createIdempotencyKey("production-memory-create"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: 0,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				operation: "create",
				expectedMemoryRevision: null,
				expectedContentDigest: null,
				draftArtifact: createDraftRef,
				diffArtifact: createDiffRef,
				proposalDigest: memoryProposalArtifactDigest(createDraft, createDiff),
			},
		}, requestContext(manager));
		if (!proposed.ok) throw new Error(proposed.error.message);
		const storedCreate = await runtime.memoryStore.loadProposal(
			scope,
			proposed.value.proposalId,
		);
		const approved = await executor.execute({
			kind: "command",
			type: "memory:resolve",
			commandId: createRuntimeId("command", "production-memory-approve"),
			idempotencyKey: createIdempotencyKey("production-memory-approve"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: storedCreate.proposal.memory.revision,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				proposalId: storedCreate.proposal.proposalId,
				action: "approve",
				expectedProposalRevision: storedCreate.proposal.memory.revision,
				resolutionReceipt: approvalReceipt(
					manager,
					storedCreate.proposal.approvalId,
					"production-memory-approve",
				),
			},
		}, requestContext(manager));
		expect(approved).toMatchObject({
			ok: true,
			value: {
				type: "memory:resolve",
				domainRevision: 1,
				proposalStatus: "approved",
			},
		});
		let record = await runtime.memoryStore.readRecord(
			scope,
			storedCreate.proposal.memory.memoryId,
		);
		expect(record).toMatchObject({
			status: "approved",
			revision: 1,
			content: createDraft.content,
		});

		const updateDraft: MemoryProposalArtifactDocument = {
			schemaVersion: 1,
			operation: "update",
			memoryId: record.memoryId,
			scope,
			title: "Updated production memory",
			content: "The reviewed update replaces the approved content.",
			sourceRefs: [trustedMemorySource(manager)],
		};
		const updateDiff = "update production memory";
		const updateProposed = await executor.execute({
			kind: "command",
			type: "memory:propose",
			commandId: createRuntimeId("command", "production-memory-update"),
			idempotencyKey: createIdempotencyKey("production-memory-update"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: record.revision,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				operation: "update",
				expectedMemoryRevision: record.revision,
				expectedContentDigest: record.contentDigest,
				draftArtifact: artifacts.add(
					manager,
					workspace,
					"change_proposal",
					JSON.stringify(updateDraft),
					"production-memory-update-draft",
				),
				diffArtifact: artifacts.add(
					manager,
					workspace,
					"diff",
					updateDiff,
					"production-memory-update-diff",
				),
				proposalDigest: memoryProposalArtifactDigest(updateDraft, updateDiff),
			},
		}, requestContext(manager));
		if (!updateProposed.ok) throw new Error(updateProposed.error.message);
		const storedUpdate = await runtime.memoryStore.loadProposal(
			scope,
			updateProposed.value.proposalId,
		);
		const updateApproved = await executor.execute({
			kind: "command",
			type: "memory:resolve",
			commandId: createRuntimeId("command", "production-memory-update-resolve"),
			idempotencyKey: createIdempotencyKey("production-memory-update-resolve"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: storedUpdate.proposal.memory.revision,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				proposalId: storedUpdate.proposal.proposalId,
				action: "approve",
				expectedProposalRevision: storedUpdate.proposal.memory.revision,
				resolutionReceipt: approvalReceipt(
					manager,
					storedUpdate.proposal.approvalId,
					"production-memory-update-resolve",
				),
			},
		}, requestContext(manager));
		expect(updateApproved).toMatchObject({
			ok: true,
			value: { domainRevision: 2, proposalStatus: "approved" },
		});
		record = await runtime.memoryStore.readRecord(scope, record.memoryId);
		expect(record).toMatchObject({
			status: "approved",
			revision: 2,
			title: updateDraft.title,
			content: updateDraft.content,
		});

		const revokeDraft: MemoryProposalArtifactDocument = {
			schemaVersion: 1,
			operation: "revoke",
			memoryId: record.memoryId,
			scope,
		};
		const revokeDiff = "revoke production memory";
		const revokeDraftRef = artifacts.add(
			manager,
			workspace,
			"change_proposal",
			JSON.stringify(revokeDraft),
			"production-memory-revoke-draft",
		);
		const revokeDiffRef = artifacts.add(
			manager,
			workspace,
			"diff",
			revokeDiff,
			"production-memory-revoke-diff",
		);
		const revokeProposed = await executor.execute({
			kind: "command",
			type: "memory:propose",
			commandId: createRuntimeId("command", "production-memory-revoke"),
			idempotencyKey: createIdempotencyKey("production-memory-revoke"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: record.revision,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				operation: "revoke",
				expectedMemoryRevision: record.revision,
				expectedContentDigest: record.contentDigest,
				draftArtifact: revokeDraftRef,
				diffArtifact: revokeDiffRef,
				proposalDigest: memoryProposalArtifactDigest(revokeDraft, revokeDiff),
			},
		}, requestContext(manager));
		if (!revokeProposed.ok) throw new Error(revokeProposed.error.message);
		const storedRevoke = await runtime.memoryStore.loadProposal(
			scope,
			revokeProposed.value.proposalId,
		);
		const revoked = await executor.execute({
			kind: "command",
			type: "memory:resolve",
			commandId: createRuntimeId("command", "production-memory-revoke-resolve"),
			idempotencyKey: createIdempotencyKey("production-memory-revoke-resolve"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: storedRevoke.proposal.memory.revision,
			sessionHandle: handle,
			payload: {
				sessionId: manager.sessionId(),
				proposalId: storedRevoke.proposal.proposalId,
				action: "revoke",
				expectedProposalRevision: storedRevoke.proposal.memory.revision,
				resolutionReceipt: approvalReceipt(
					manager,
					storedRevoke.proposal.approvalId,
					"production-memory-revoke-resolve",
				),
			},
		}, requestContext(manager));
		expect(revoked).toMatchObject({
			ok: true,
			value: {
				type: "memory:resolve",
				domainRevision: 3,
				proposalStatus: "approved",
			},
		});
		expect(await runtime.memoryStore.readRecord(scope, record.memoryId)).toMatchObject({
			status: "revoked",
			revision: 3,
			revocationRevision: 1,
		});
	});

	it("rejects tampered, foreign-scope, and stale Memory mutations before persistence", async () => {
		const { manager, workspace, options } = await setup();
		const runtime = await createProductionSessionRuntime(options);
		const artifacts = new MemoryArtifactAccess();
		const executor = new ProductionPlanContextMemoryControlPlaneExecutor({
			withSession: async (_sessionId, operation) =>
				operation(specialtySession(manager, workspace, runtime, artifacts)),
		});
		const identity = manager.identity();
		const scope: MemoryScopeRef = {
			scope: "workspace",
			workspaceId: workspace.workspaceId,
		};
		const handle = {
			handleId: "handle_production_memory_denial",
			sessionId: manager.sessionId(),
			generation: 1,
		};
		const draft: MemoryProposalArtifactDocument = {
			schemaVersion: 1,
			operation: "create",
			title: "Denied memory",
			content: "must never become canonical",
			scope,
			sourceRefs: [trustedMemorySource(manager)],
		};
		const diff = "denied memory diff";
		const draftRef = artifacts.add(
			manager,
			workspace,
			"change_proposal",
			JSON.stringify(draft),
			"production-memory-denied-draft",
		);
		const diffRef = artifacts.add(
			manager,
			workspace,
			"diff",
			diff,
			"production-memory-denied-diff",
		);
		const commandBase = {
			kind: "command" as const,
			type: "memory:propose" as const,
			idempotencyKey: createIdempotencyKey("production-memory-denied"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: expectedRevision(manager),
			expectedDomainRevision: 0,
			sessionHandle: handle,
		};
		const tampered = await executor.execute({
			...commandBase,
			commandId: createRuntimeId("command", "production-memory-tampered"),
			payload: {
				sessionId: manager.sessionId(),
				operation: "create",
				expectedMemoryRevision: null,
				expectedContentDigest: null,
				draftArtifact: {
					...draftRef,
					storedDigest: canonicalDigest("tampered-reference"),
				},
				diffArtifact: diffRef,
				proposalDigest: memoryProposalArtifactDigest(draft, diff),
			},
		}, requestContext(manager));
		expect(tampered).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});

		const foreignDraft: MemoryProposalArtifactDocument = {
			...draft,
			scope: {
				scope: "user",
				ownerPrincipalId: createRuntimeId("principal", "foreign-memory-owner"),
			},
		};
		const foreignDraftRef = artifacts.add(
			manager,
			workspace,
			"change_proposal",
			JSON.stringify(foreignDraft),
			"production-memory-foreign-draft",
		);
		const foreign = await executor.execute({
			...commandBase,
			commandId: createRuntimeId("command", "production-memory-foreign"),
			payload: {
				sessionId: manager.sessionId(),
				operation: "create",
				expectedMemoryRevision: null,
				expectedContentDigest: null,
				draftArtifact: foreignDraftRef,
				diffArtifact: diffRef,
				proposalDigest: memoryProposalArtifactDigest(foreignDraft, diff),
			},
		}, requestContext(manager));
		expect(foreign).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});

		const staleRevision = commandBase.expectedSessionRevision;
		await manager.sessionEvents().recordMessage({
			role: "user",
			content: [{ type: "text", text: "advance the canonical head" }],
		});
		const readsBeforeStale = artifacts.readCount;
		const stale = await executor.execute({
			...commandBase,
			commandId: createRuntimeId("command", "production-memory-stale"),
			expectedSessionRevision: staleRevision,
			payload: {
				sessionId: manager.sessionId(),
				operation: "create",
				expectedMemoryRevision: null,
				expectedContentDigest: null,
				draftArtifact: draftRef,
				diffArtifact: diffRef,
				proposalDigest: memoryProposalArtifactDigest(draft, diff),
			},
		}, requestContext(manager));
		expect(stale).toMatchObject({
			ok: false,
			error: { code: "expected_revision_conflict" },
		});
		expect(artifacts.readCount).toBe(readsBeforeStale);
		expect(await runtime.memoryStore.listRecords(runtime.memoryScopes)).toEqual([]);
		const flushed = await manager.flushCurrentHead();
		if (!flushed.ok) throw new Error(flushed.error.message);
		const events = await readAllRuntimeEvents(manager.eventStore());
		if (!events.ok) throw new Error(events.error.message);
		expect(events.value.some((event) => event.type === "memory.proposed")).toBe(false);
	});

	it("runs a manual no-tool compaction from canonical completed turns and installs one projection", async () => {
		const { manager, workspace, options } = await setup();
		const runtime = await createProductionSessionRuntime(options);
		for (const [request, answer] of [
			["first request ".repeat(40), "first answer ".repeat(40)],
			["second request ".repeat(40), "second answer ".repeat(40)],
		] as const) {
			const turn = await manager.sessionEvents().beginTurn();
			await manager.sessionEvents().recordMessage({
				role: "user",
				content: [{ type: "text", text: request }],
			});
			await manager.sessionEvents().recordMessage({
				role: "assistant",
				content: [{ type: "text", text: answer }],
				stopReason: "stop",
			});
			await manager.sessionEvents().finishTurn(turn, { ok: true }, "stop");
		}
		const fixtureFlush = await manager.flushCurrentHead();
		if (!fixtureFlush.ok) throw new Error(fixtureFlush.error.message);
		const before = await readAllRuntimeEvents(manager.eventStore());
		if (!before.ok) throw new Error(before.error.message);
		const head = manager.writer().currentHead();
		if (!head) throw new Error("fixture has no durable head");
		const identity = manager.identity();
		const sessions: ActivePlanContextMemorySessionResolverPort = {
			withSession: async (_sessionId, operation) =>
				operation(specialtySession(manager, workspace, runtime)),
		};
		const executor = new ProductionPlanContextMemoryControlPlaneExecutor(sessions);
		const context: ControlPlaneRequestContext = {
			peer: {
				kind: "local",
				transport: "jsonl",
				pid: process.pid,
				uid: null,
				principalId: identity.principalId,
				authenticatedVia: "stdio_parent",
			},
			handshake: {
				kind: "handshake_result",
				requestId: "production-compact",
				protocol: { major: 1, minor: 1 },
				controlPlaneSchemaVersion: 2,
				runtimeSchemaVersion: 3,
				features: ["plan_context_memory"],
				serverInstanceId: manager.runtimeId(),
				remoteAccess: "disabled",
				deliveryGuarantee: "at_least_once",
			},
		};
		const result = await executor.execute({
			kind: "command",
			type: "context:compact",
			commandId: createRuntimeId("command", "production-manual-compact"),
			idempotencyKey: createIdempotencyKey("production-manual-compact"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: {
				stream: head.stream,
				sequence: head.sequence,
				eventHash: head.eventHash,
			},
			expectedDomainRevision: 0,
			sessionHandle: {
				handleId: "handle_production_compact",
				sessionId: manager.sessionId(),
				generation: 1,
			},
			payload: { sessionId: manager.sessionId(), reason: "manual" },
		}, context);
		expect(result).toMatchObject({
			ok: true,
			value: {
				type: "context:compact",
				domainRevision: 1,
				attemptStatus: "completed",
			},
		});
		expect(await runtime.compactionProjection.loadState()).toMatchObject({
			revision: 1,
			projection: {
				checkpoint: { sessionId: manager.sessionId() },
				summary: "bounded production summary",
			},
		});
		const after = await readAllRuntimeEvents(manager.eventStore());
		if (!after.ok) throw new Error(after.error.message);
		expect(after.value.filter((event) => event.type === "conversation.message_recorded"))
			.toEqual(before.value.filter((event) => event.type === "conversation.message_recorded"));
		expect(after.value.some((event) => event.type === "compaction.completed")).toBe(true);
	});

	it("rejects a workspace binding or verification receipt from another runtime scope", async () => {
		const { options, workspace } = await setup();
		await expect(createProductionSessionRuntime({
			...options,
			workspace: { ...workspace, leaseRevision: 2 },
		})).rejects.toThrow("exact active durable workspace binding");
		await expect(createProductionSessionRuntime({
			...options,
			verification: { ...options.verification, evidenceDigest: "f".repeat(64) },
		})).rejects.toThrow("verification services");
	});
});
