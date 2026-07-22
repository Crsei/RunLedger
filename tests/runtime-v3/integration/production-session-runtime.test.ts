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
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../src/runtime/orchestrator/budget-guard.ts";
import { LoopBreaker } from "../../../src/runtime/orchestrator/loop-breaker.ts";
import { CanonicalAgentQueueAdapter } from "../../../src/runtime/orchestrator/canonical-queue.ts";
import type { OperationBindings } from "../../../src/runtime/orchestrator/types.ts";
import {
	createProductionSessionRuntime,
	type ProductionVerificationServices,
} from "../../../src/runtime/integration/production-session-runtime.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { PersistedWorkspaceBinding } from "../../../src/worktree/types.ts";

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
		compaction: { sampler: { sample: async () => "bounded production summary" } },
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

describe("production session runtime composition", () => {
	it("uses v3 journals and file stores, then reopens the same goal without duplicate genesis", async () => {
		const { manager, workspace, options } = await setup();
		const first = await createProductionSessionRuntime(options);
		expect(first.workspace.bindingDigest).toBe(workspace.bindingDigest);
		expect(first.queue).toBeInstanceOf(CanonicalAgentQueueAdapter);
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
