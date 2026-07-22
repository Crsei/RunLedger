import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSupervisor, RootBudgetGuardAdapter } from "../../src/runtime/agents/supervisor.ts";
import { SessionAgentGraphStore } from "../../src/runtime/agents/session-graph-store.ts";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	ProductionAgentDenialEvaluator,
	ProductionAgentWorkspaceAdapter,
	ProductionArtifactMergeAdapter,
	ProductionChildSessionLauncher,
	createProductionCapabilityGrantPolicy,
} from "../../src/runtime/agents/integration/index.ts";
import type {
	AgentBudgetRequest,
	AgentCapabilityRequestRef,
	AgentWorkspaceReceiptRef,
	ParentCapabilityGrantRef,
	SpawnAgentRequest,
} from "../../src/runtime/agents/types.ts";
import { ArtifactAccessService } from "../../src/runtime/artifacts/access.ts";
import { ArtifactCasStore, ArtifactRepository } from "../../src/runtime/artifacts/cas-store.ts";
import { UnavailableArtifactKeyProvider } from "../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../src/runtime/artifacts/session-journal.ts";
import type {
	ArtifactAccessLogEntry,
	ArtifactAccessLogPort,
	ArtifactCapabilityGatewayPort,
	ArtifactResult,
} from "../../src/runtime/artifacts/types.ts";
import {
	BUDGET_DIMENSIONS,
	BudgetGuard,
	type BudgetJournalRecord,
	type BudgetLimits,
} from "../../src/runtime/orchestrator/budget-guard.ts";
import { SessionDurableOrchestratorJournal } from "../../src/runtime/orchestrator/session-journal.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import type {
	SessionMutationAdmissionGatePort,
	SessionMutationAdmissionReceipt,
} from "../../src/runtime/lifecycle/mutation-gate.ts";
import { readAllRuntimeEvents } from "../../src/runtime/session/snapshot.ts";
import { createProductionWorkspaceComposition } from "../../src/storage/worktree-production.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";
import { GitOperations } from "../../src/worktree/git-operations.ts";
import type {
	WorktreeForensicAuthorizationPort,
	WorktreeLivenessPort,
} from "../../src/worktree/ports.ts";
import { NodeGitCommandPort } from "../../src/storage/worktree-node-adapter.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const FEATURES = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const temporaryRoots: string[] = [];
const openManagers: V3SessionManager[] = [];
const openLaunchers: ProductionChildSessionLauncher[] = [];

afterEach(async () => {
	await Promise.all(openLaunchers.splice(0).map((launcher) => launcher.close().catch(() => undefined)));
	await Promise.all(openManagers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ClosedWorldLiveness implements WorktreeLivenessPort {
	public async activeOwners(): Promise<readonly ReturnType<typeof createRuntimeId<"runtime">>[]> {
		return [];
	}
}

class DenyForensicCapture implements WorktreeForensicAuthorizationPort {
	public async authorizeCapture() {
		return {
			ok: false as const,
			error: { code: "approval_required" as const, message: "forensic capture is not authorized", retryable: false },
		};
	}
}

class ExactArtifactReadGateway implements ArtifactCapabilityGatewayPort {
	public async recheckArtifactAccess(
		request: Parameters<ArtifactCapabilityGatewayPort["recheckArtifactAccess"]>[0],
	) {
		const allowed =
			request.capability === "repository_read" &&
			request.operation === "read" &&
			request.authorityId === request.artifact.authorityId &&
			request.tenantId === request.artifact.tenantId &&
			request.workspaceId === request.artifact.workspaceId;
		return allowed
			? {
				ok: true as const,
				value: {
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					decision: "allow" as const,
					receiptId: createRuntimeId("receipt", canonicalDigest(request).slice(0, 48)),
					receiptDigest: canonicalDigest({ requestDigest: request.requestDigest, decision: "allow" }),
				},
			}
			: {
				ok: true as const,
				value: {
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					decision: "deny" as const,
				},
			};
	}
}

class JsonlArtifactAccessLog implements ArtifactAccessLogPort {
	readonly #filePath: string;

	public constructor(filePath: string) {
		this.#filePath = filePath;
	}

	public async append(entry: ArtifactAccessLogEntry): Promise<ArtifactResult<void>> {
		try {
			await appendFile(this.#filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
			return { ok: true, value: undefined };
		} catch (cause) {
			return {
				ok: false,
				error: {
					code: "durable_write_failed",
					message: cause instanceof Error ? cause.message : "artifact access log append failed",
					retryable: true,
				},
			};
		}
	}
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await new NodeGitCommandPort().run({ cwd, arguments: args, timeoutMs: 30_000 });
	if (result.exitCode !== 0 || result.signaled) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trimEnd();
}

function limits(): BudgetLimits {
	return Object.fromEntries(
		BUDGET_DIMENSIONS.map((dimension) => [dimension, { soft: 1_000_000, hard: 2_000_000 }]),
	) as BudgetLimits;
}

function budget(): AgentBudgetRequest {
	return {
		maxTurns: 4,
		maxInputTokens: 10_000,
		maxOutputTokens: 10_000,
		maxUsdMicros: 100_000,
		maxWallTimeMs: 60_000,
		maxToolCalls: 20,
		maxNetworkBytes: 0,
		maxStorageBytes: 2_000_000,
	};
}

function key(seed: string) {
	return createIdempotencyKey(`multi-agent-${seed.padEnd(20, "x")}`);
}

describe("multi-agent production isolation E2E", () => {
	it("uses durable sessions, production worktrees and exact receipts from spawn through replay and ArtifactRef merge", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "runledger-multi-agent-production-"));
		temporaryRoots.push(rootDir);
		const sourceRepo = join(rootDir, "source");
		await mkdir(sourceRepo, { recursive: true, mode: 0o700 });
		await git(sourceRepo, "init", "-b", "main");
		await git(sourceRepo, "config", "user.name", "RunLedger E2E");
		await git(sourceRepo, "config", "user.email", "runledger@example.invalid");
		await writeFile(join(sourceRepo, "README.md"), "root baseline\n", { mode: 0o600 });
		await git(sourceRepo, "add", "README.md");
		await git(sourceRepo, "commit", "-m", "initial baseline");
		const baseCommit = await git(sourceRepo, "rev-parse", "HEAD");

		const rootManager = await V3SessionManager.create({
			cwd: sourceRepo,
			sessionDir: join(rootDir, "root-sessions"),
			features: FEATURES,
		});
		openManagers.push(rootManager);
		const identity = rootManager.identity();
		const principalId = identity.principalId;
		const parentMutationRequests: Parameters<SessionMutationAdmissionGatePort["revalidate"]>[0][] = [];
		const parentMutationGate: SessionMutationAdmissionGatePort = {
			revalidate: async (request) => {
				parentMutationRequests.push(structuredClone(request));
				const eventHead = rootManager.writer().currentHead();
				if (!eventHead) {
					return {
						ok: false,
						error: {
							code: "external_unavailable",
							message: "root session event head is unavailable",
							retryable: false,
						},
					};
				}
				const body: Omit<SessionMutationAdmissionReceipt, "receiptDigest"> = {
					schemaVersion: 1,
					authorityId: identity.authorityId,
					tenantId: identity.tenantId,
					sessionId: rootManager.sessionId(),
					kind: request.kind,
					correlationId: request.correlationId,
					eventHead,
					checkedAt: NOW,
					auditReceipts: [],
				};
				return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
			},
		};
		const repositoryId = createRuntimeId("repository", "multi-agent-e2e");
		const rootAgentId = createRuntimeId("agent", "multi-agent-root");
		const goalId = createRuntimeId("goal", "multi-agent-goal");

		const artifactRoot = join(rootDir, "artifact-state");
		const artifactCas = new ArtifactCasStore({ rootDir: artifactRoot });
		const artifactMetadata = new ArtifactMetadataStore({ rootDir: artifactRoot });
		const artifactJournal = new SessionArtifactJournal({
			writer: rootManager.writer(),
			store: rootManager.eventStore(),
			principalId,
		});
		const artifactRepository = new ArtifactRepository({
			cas: artifactCas,
			metadata: artifactMetadata,
			journal: artifactJournal,
			keyProvider: new UnavailableArtifactKeyProvider(),
			clock: () => new Date(NOW),
		});
		const artifactAccess = new ArtifactAccessService({
			cas: artifactCas,
			metadata: artifactMetadata,
			gateway: new ExactArtifactReadGateway(),
			accessLog: new JsonlArtifactAccessLog(join(rootDir, "artifact-access.jsonl")),
			keyProvider: new UnavailableArtifactKeyProvider(),
			clock: () => new Date(NOW),
		});

		const workspaceComposition = await createProductionWorkspaceComposition({
			scope: { authorityId: identity.authorityId, tenantId: identity.tenantId },
			managedRoot: join(rootDir, "managed-worktrees"),
			stateRoot: join(rootDir, "workspace-state"),
			validatorPrincipalId: principalId,
			liveness: new ClosedWorldLiveness(),
			repository: artifactRepository,
			artifactAccess,
			forensicAuthorization: new DenyForensicCapture(),
			clock: () => new Date(NOW),
		});
		const rootStrategy = {
			strategyId: createRuntimeId("resource", "root-source-workspace"),
			kind: "managed_worktree" as const,
			strategyDigest: canonicalDigest("root source Workspace strategy"),
		};
		const childStrategy = {
			strategyId: createRuntimeId("resource", "child-managed-worktree"),
			kind: "managed_worktree" as const,
			strategyDigest: canonicalDigest("child managed Worktree strategy"),
		};
		const workspace = new ProductionAgentWorkspaceAdapter({
			manager: workspaceComposition.manager,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId,
			repositoryId,
			sourceRepo,
			sourceCwd: sourceRepo,
			rootAgentId,
			rootOwnerRuntimeId: rootManager.runtimeId(),
			clock: () => new Date(NOW),
		});
		const rootWorkspace = await workspace.bindRoot({
			requestId: createRuntimeId("command", "bind-root-agent-workspace"),
			agentId: rootAgentId,
			sessionId: rootManager.sessionId(),
			strategy: rootStrategy,
		});
		if (!rootWorkspace.ok) throw new Error(rootWorkspace.error.message);

		const parentGrant: ParentCapabilityGrantRef = {
			receiptId: createRuntimeId("receipt", "root-capability-grant"),
			receiptDigest: canonicalDigest("root capability grant"),
			decisionRevision: 3,
		};
		const allowedCapability: AgentCapabilityRequestRef = {
			kind: "capability",
			requestId: createRuntimeId("command", "child-workspace-write-capability"),
			capability: "workspace_write",
			requestDigest: canonicalDigest("child workspace write request"),
		};
		const subset = new GatewayBoundCapabilitySubsetEvaluator([
			createProductionCapabilityGrantPolicy({
				policyReceiptId: createRuntimeId("receipt", "root-delegation-policy"),
				parentGrant,
				allowedRequests: [allowedCapability],
				delegableToolKinds: [],
				childSpawnAllowed: false,
				decisionRevision: 4,
				evaluatorId: principalId,
				issuedAt: NOW,
			}),
		], () => new Date(NOW));
		const launcher = new ProductionChildSessionLauncher({
			workspace,
			capabilitySubset: subset,
			parentMutationGate,
			sessionDir: join(rootDir, "child-sessions"),
			features: FEATURES,
			identity,
			maxActiveChildren: 3,
			clock: () => new Date(NOW),
		});
		openLaunchers.push(launcher);
		const graphStore = new SessionAgentGraphStore({
			writer: rootManager.writer(),
			store: rootManager.eventStore(),
			principalId,
		});
		const budgetGuard = new BudgetGuard({
			goalId,
			limits: limits(),
			journal: new SessionDurableOrchestratorJournal<BudgetJournalRecord>({
				journalKind: "budget",
				writer: rootManager.writer(),
				store: rootManager.eventStore(),
				principalId,
			}),
			clock: () => new Date(NOW),
		});
		const gitOperations = new GitOperations(new NodeGitCommandPort());
		const merge = new ProductionArtifactMergeAdapter({
			workspace,
			artifactAccess,
			git: gitOperations,
			principalId,
			clock: () => new Date(NOW),
		});
		const ports = {
			graphStore,
			capabilitySubset: subset,
			workspace,
			deniedAgents: new ProductionAgentDenialEvaluator({
				policyDigest: canonicalDigest("multi-agent denial policy"),
				decisionRevision: 1,
				deniedAgentIds: new Set(),
			}, () => new Date(NOW)),
			budget: new RootBudgetGuardAdapter(budgetGuard),
			launcher,
			merge,
		};
		const supervisor = new AgentSupervisor({ rootAgentId, ports, clock: () => new Date(NOW) });
		expect((await supervisor.registerRoot({
			requestId: createRuntimeId("command", "register-production-root"),
			idempotencyKey: key("register-root"),
			agentId: rootAgentId,
			sessionId: rootManager.sessionId(),
			goalId,
			role: "build",
			workspaceReceipt: rootWorkspace.value,
			capabilityGrant: parentGrant,
			inputSources: [],
			declassificationReceipts: [],
			registeredAt: NOW,
		})).ok).toBe(true);

		const spawn = (seed: string, capabilities: readonly AgentCapabilityRequestRef[]): SpawnAgentRequest => ({
			requestId: createRuntimeId("command", `spawn-${seed}`),
			idempotencyKey: key(`spawn-${seed}`),
			parentAgentId: rootAgentId,
			childAgentId: createRuntimeId("agent", `child-${seed}`),
			childSessionId: createRuntimeId("session", `child-${seed}`),
			role: "build",
			objective: "Produce one verified patch without accessing parent-only state.",
			expectedArtifacts: [{ kind: "diff", mediaType: "text/x-diff", logicalName: "patch" }],
			allowPartial: false,
			depth: 1,
			budget: budget(),
			parentGrant,
			requestedCapabilities: capabilities,
			workspaceStrategy: childStrategy,
			inputSources: [],
			declassificationReceipts: [],
		});

		const expanded = await supervisor.spawn(spawn("capability-expansion", [
			allowedCapability,
			{
				kind: "tool",
				requestId: createRuntimeId("command", "ungranted-mcp-tool"),
				toolKind: "mcp",
				resourceId: createRuntimeId("resource", "ungranted-mcp-tool"),
				manifestDigest: canonicalDigest("ungranted MCP manifest"),
				requiredClaimsDigest: canonicalDigest("ungranted MCP claims"),
			},
		]));
		expect(expanded).toMatchObject({ ok: false, error: { code: "delegation_denied" } });

		const parentSecret = "parent-env-secret-must-not-cross";
		const parentCredential = "parent-credential-material-must-not-cross";
		await writeFile(join(sourceRepo, ".parent-temp"), parentSecret, { mode: 0o600 });
		await writeFile(join(sourceRepo, ".parent-credential"), parentCredential, { mode: 0o600 });
		const productionSpawn = spawn("production", [allowedCapability]);
		const spawned = await supervisor.spawn(productionSpawn);
		if (!spawned.ok) throw new Error(spawned.error.message);
		expect(parentMutationRequests).toEqual([{
			kind: "child_spawn",
			correlationId: productionSpawn.requestId,
		}]);
		const child = spawned.value.node;
		expect(child.workspaceReceipt.workspaceId).not.toBe(rootWorkspace.value.workspaceId);
		expect(child.sessionId).not.toBe(rootManager.sessionId());
		expect(launcher.snapshots()).toEqual([
			expect.objectContaining({
				agentId: child.agentId,
				sessionId: child.sessionId,
				workspaceId: child.workspaceReceipt.workspaceId,
				eventSequence: 0,
			}),
		]);
		expect(JSON.stringify({ node: child, launcher: launcher.snapshots() })).not.toMatch(/cwd|fencingToken|envVars|credential/i);

		const childRecord = await workspaceComposition.registry.get(child.workspaceReceipt.workspaceId);
		if (!childRecord.ok || !childRecord.value) throw new Error("production child worktree record is missing");
		await expect(readFile(join(childRecord.value.worktreePath, ".parent-temp"), "utf8")).rejects.toThrow();
		await expect(readFile(join(childRecord.value.worktreePath, ".parent-credential"), "utf8")).rejects.toThrow();
		expect(await readFile(join(childRecord.value.worktreePath, "README.md"), "utf8")).toBe("root baseline\n");
		await writeFile(join(childRecord.value.worktreePath, "README.md"), "root baseline\nchild isolated change\n", { mode: 0o600 });
		expect(await readFile(join(sourceRepo, "README.md"), "utf8")).toBe("root baseline\n");

		const staleReceipt: AgentWorkspaceReceiptRef = {
			...child.workspaceReceipt,
			leaseRevision: (child.workspaceReceipt.leaseRevision ?? 0) + 1,
		};
		const staleBody = {
			requestId: createRuntimeId("command", "validate-stale-child-lease"),
			agentId: child.agentId,
			sessionId: child.sessionId,
			previousReceipt: staleReceipt,
		};
		expect(await workspace.validate({ ...staleBody, requestDigest: canonicalDigest(staleBody) })).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid" },
		});
		const aliasReceipt: AgentWorkspaceReceiptRef = {
			...child.workspaceReceipt,
			workspaceId: rootWorkspace.value.workspaceId,
		};
		const aliasBody = {
			requestId: createRuntimeId("command", "validate-forged-workspace-alias"),
			agentId: child.agentId,
			sessionId: child.sessionId,
			previousReceipt: aliasReceipt,
		};
		expect(await workspace.validate({ ...aliasBody, requestDigest: canonicalDigest(aliasBody) })).toMatchObject({
			ok: false,
			error: { code: "workspace_invalid" },
		});

		const patch = await gitOperations.diff(childRecord.value.worktreePath, baseCommit, 1024 * 1024);
		if (!patch.ok) throw new Error(patch.error.message);
		const artifactWrite = await artifactRepository.write({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId: createRuntimeId("artifact", "child-production-patch"),
			intentId: createRuntimeId("command", "write-child-production-patch"),
			principalId,
			source: {
				sessionId: child.sessionId,
				workspaceId: child.workspaceReceipt.workspaceId,
				producerId: child.agentId,
			},
			kind: "diff",
			mediaType: "text/x-diff",
			content: patch.value,
			lineage: { origin: "internal", inputSources: [], declassificationReceipts: [] },
			createdAt: NOW,
		});
		if (!artifactWrite.ok || artifactWrite.value.state !== "committed" || !artifactWrite.value.reference) {
			throw new Error("production patch Artifact was not committed");
		}
		const patchRef = artifactWrite.value.reference;
		expect((await supervisor.reportArtifact({
			requestId: createRuntimeId("command", "report-child-production-patch"),
			idempotencyKey: key("report-patch"),
			report: {
				agentId: child.agentId,
				logicalName: "patch",
				artifact: patchRef,
				integrity: "valid",
				verification: "verified",
				inputSources: [],
				declassificationReceipts: [],
				reportedAt: NOW,
			},
		})).ok).toBe(true);
		expect((await supervisor.finish({
			requestId: createRuntimeId("command", "finish-child-production"),
			idempotencyKey: key("finish-child"),
			agentId: child.agentId,
			outcome: "completed",
		})).ok).toBe(true);
		const handoffId = createRuntimeId("command", "handoff-child-production");
		expect((await supervisor.handoff({
			requestId: handoffId,
			idempotencyKey: key("handoff-child"),
			agentId: child.agentId,
			status: "complete",
		})).ok).toBe(true);
		expect((await supervisor.merge({
			requestId: createRuntimeId("command", "merge-child-production"),
			idempotencyKey: key("merge-child"),
			parentAgentId: rootAgentId,
			childAgentId: child.agentId,
			handoffId,
			logicalNames: ["patch"],
		})).ok).toBe(true);
		expect(await readFile(join(sourceRepo, "README.md"), "utf8")).toBe("root baseline\nchild isolated change\n");
		expect(await readFile(join(sourceRepo, ".parent-temp"), "utf8")).toBe(parentSecret);
		expect(await readFile(join(sourceRepo, ".parent-credential"), "utf8")).toBe(parentCredential);

		const rootFile = rootManager.filePath();
		await rootManager.closeAll();
		openManagers.splice(openManagers.indexOf(rootManager), 1);
		const reopened = await V3SessionManager.open(rootFile, FEATURES, identity);
		openManagers.push(reopened);
		const replayed = await new AgentSupervisor({
			rootAgentId,
			ports: {
				...ports,
				graphStore: new SessionAgentGraphStore({
					writer: reopened.writer(),
					store: reopened.eventStore(),
					principalId,
				}),
			},
			clock: () => new Date(NOW),
		}).graph();
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.nodes.get(child.agentId)).toMatchObject({
			state: "completed",
			sessionId: child.sessionId,
			workspaceReceipt: { workspaceId: child.workspaceReceipt.workspaceId },
			artifacts: [{ artifact: { artifactId: patchRef.artifactId } }],
		});
		expect(replayed.value.mergeReceipts).toEqual([
			expect.objectContaining({
				childAgentId: child.agentId,
				targetWorkspaceId: rootWorkspace.value.workspaceId,
				artifactIds: [patchRef.artifactId],
				outcome: "applied",
			}),
		]);
		const events = await readAllRuntimeEvents(reopened.eventStore());
		expect(events.ok).toBe(true);
		if (events.ok) {
			const types = events.value.map((event) => event.type);
			expect(types).toContain("agent.spawned");
			expect(types).toContain("agent.finished");
			expect(types).toContain("artifact.committed");
		}
		const persistedState = [
			await readFile(workspaceComposition.paths.registryFile, "utf8"),
			await readFile(workspaceComposition.paths.leaseFile, "utf8"),
			JSON.stringify(replayed.value),
		].join("\n");
		expect(persistedState).not.toContain(parentSecret);
		expect(persistedState).not.toContain(parentCredential);
	});
});
