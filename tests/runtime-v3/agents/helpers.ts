import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { InMemoryAgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentCapabilityRequestRef,
	AgentBudgetReservationRef,
	AgentDenialEvaluatorPort,
	AgentDenialReceiptRef,
	AgentGraphLimits,
	AgentLaunchRequest,
	AgentLauncherPort,
	AgentLaunchResult,
	AgentMergeReceiptRef,
	AgentResult,
	AgentResumeLaunchRequest,
	AgentSupervisorPorts,
	AgentWorkspacePort,
	AgentWorkspaceReceiptRef,
	CapabilitySubsetEvaluationRequest,
	CapabilitySubsetEvaluatorPort,
	CapabilitySubsetRevalidationRequest,
	DeclarativeMergePort,
	DelegationReceiptRef,
	ParentCapabilityGrantRef,
	RegisterRootAgentRequest,
	RootAgentBudgetPort,
	RootAgentBudgetReserveRequest,
	RootAgentBudgetSettleRequest,
	SpawnAgentRequest,
} from "../../../src/runtime/agents/types.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type {
	DeclassificationReceiptRef,
	InputSourceRef,
	TaintSink,
} from "../../../src/runtime/protocol/v3/taint.ts";

let sequence = 0;

export function nextSeed(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

export function digest(character = "a"): string {
	return character.repeat(64);
}

export function key(prefix: string) {
	return createIdempotencyKey(`${prefix}-${nextSeed("key")}-${"x".repeat(24)}`);
}

export function grant(seed = nextSeed("grant")): ParentCapabilityGrantRef {
	return {
		receiptId: createRuntimeId("receipt", seed),
		receiptDigest: digest("a"),
		decisionRevision: 1,
		expiresAt: "2026-07-23T00:00:00.000Z",
	};
}

export function strategy(kind: "managed_worktree" | "isolated_lease" | "readonly_checkout" = "managed_worktree") {
	return {
		strategyId: createRuntimeId("resource", nextSeed("strategy")),
		kind,
		strategyDigest: digest("b"),
	};
}

export function workspaceReceipt(
	sessionId: AgentWorkspaceReceiptRef["sessionId"],
	seed = nextSeed("workspace"),
	kind: "managed_worktree" | "isolated_lease" | "readonly_checkout" = "managed_worktree",
): AgentWorkspaceReceiptRef {
	const workspaceStrategy = strategy(kind);
	const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		receiptId: createRuntimeId("receipt", `workspace-${seed}`),
		strategy: workspaceStrategy,
		sessionId,
		workspaceId: createRuntimeId("workspace", seed),
		repositoryId: createRuntimeId("repository", "test"),
		bindingRevision: 1,
		bindingDigest: digest("c"),
		...(kind === "isolated_lease"
			? { leaseId: createRuntimeId("lease", seed), leaseRevision: 1 }
			: {}),
		status: kind === "readonly_checkout" ? "readonly" : "active",
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-23T00:00:00.000Z",
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function artifact(
	seed = nextSeed("artifact"),
	workspaceId?: ArtifactRef["workspaceId"],
): ArtifactRef {
	return {
		authorityId: createRuntimeId("authority", "test"),
		tenantId: createRuntimeId("tenant", "test"),
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: digest("e"),
		kind: "diff",
		originalSize: 20,
		storedSize: 20,
		mediaType: "text/x-diff",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", `transform-${seed}`),
		...(workspaceId ? { workspaceId } : {}),
	};
}

export function inputSource(seed = nextSeed("source")): InputSourceRef {
	return {
		schemaVersion: 1,
		authorityId: createRuntimeId("authority", "test"),
		tenantId: createRuntimeId("tenant", "test"),
		sourceId: createRuntimeId("inputSource", seed),
		kind: "repository",
		sourceDigest: digest("7"),
		trust: "tainted",
		taintLabels: ["repository_controlled", "executable_instruction"],
		observedAt: "2026-07-22T00:00:00.000Z",
	};
}

export function declassificationReceipt(
	source: InputSourceRef,
	allowedSink: TaintSink = "filesystem",
): DeclassificationReceiptRef {
	const body: Omit<DeclassificationReceiptRef, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: source.authorityId,
		tenantId: source.tenantId,
		receiptId: createRuntimeId("declassification", nextSeed("declassification")),
		sourceId: source.sourceId,
		sourceDigest: source.sourceDigest,
		allowedSink,
		policyDigest: digest("8"),
		approverPrincipalId: createRuntimeId("principal", "reviewer"),
		decisionRevision: 1,
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-23T00:00:00.000Z",
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function delegationBody(
	request: CapabilitySubsetEvaluationRequest | CapabilitySubsetRevalidationRequest,
	childSpawnAllowed: boolean,
	decision: "allowed" | "denied",
) {
	return {
		receiptId: createRuntimeId("receipt", nextSeed("delegation")),
		parentAgentId: request.parentAgentId,
		childAgentId: "childAgentId" in request ? request.childAgentId : request.agentId,
		parentGrantReceiptId: request.parentGrant.receiptId,
		parentGrantDigest: request.parentGrant.receiptDigest,
		requestDigest: request.requestDigest,
		decision,
		childSpawnAllowed,
		decisionRevision: request.parentGrant.decisionRevision + 1,
		evaluatorId: createRuntimeId("principal", "capability-evaluator"),
		evaluatedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-23T00:00:00.000Z",
	};
}

export class FakeCapabilitySubsetEvaluator implements CapabilitySubsetEvaluatorPort {
	public readonly evaluations: CapabilitySubsetEvaluationRequest[] = [];
	public readonly revalidations: CapabilitySubsetRevalidationRequest[] = [];
	public decision: "allowed" | "denied" = "allowed";
	public childSpawnAllowed = false;

	public evaluate(request: CapabilitySubsetEvaluationRequest): Promise<AgentResult<DelegationReceiptRef>> {
		this.evaluations.push(request);
		const body = delegationBody(request, this.childSpawnAllowed, this.decision);
		return Promise.resolve({ ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } });
	}

	public revalidate(request: CapabilitySubsetRevalidationRequest): Promise<AgentResult<DelegationReceiptRef>> {
		this.revalidations.push(request);
		const body = delegationBody(request, this.childSpawnAllowed, this.decision);
		return Promise.resolve({ ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } });
	}
}

export class FakeWorkspacePort implements AgentWorkspacePort {
	public readonly allocations: Parameters<AgentWorkspacePort["allocate"]>[0][] = [];
	public readonly validations: Parameters<AgentWorkspacePort["validate"]>[0][] = [];
	public readonly releases: Parameters<AgentWorkspacePort["release"]>[0][] = [];
	public sharedWorkspaceId: AgentWorkspaceReceiptRef["workspaceId"] | undefined;
	public validationStatus: AgentWorkspaceReceiptRef["status"] = "active";

	public allocate(request: Parameters<AgentWorkspacePort["allocate"]>[0]): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		this.allocations.push(request);
		const receipt = workspaceReceipt(request.childSessionId, nextSeed("child-workspace"), request.strategy.kind);
		const { receiptDigest: _receiptDigest, ...receiptBody } = receipt;
		const body = {
			...receiptBody,
			strategy: request.strategy,
			...(this.sharedWorkspaceId ? { workspaceId: this.sharedWorkspaceId } : {}),
		};
		return Promise.resolve({
			ok: true,
			value: { ...body, receiptDigest: canonicalDigest(body) },
		});
	}

	public validate(request: Parameters<AgentWorkspacePort["validate"]>[0]): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		this.validations.push(request);
		const { receiptDigest: _previousDigest, ...previousBody } = request.previousReceipt;
		const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
			...previousBody,
			receiptId: createRuntimeId("receipt", nextSeed("workspace-revalidation")),
			status: this.validationStatus,
		};
		return Promise.resolve({
			ok: true,
			value: { ...body, receiptDigest: canonicalDigest(body) },
		});
	}

	public release(request: Parameters<AgentWorkspacePort["release"]>[0]): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		this.releases.push(request);
		return Promise.resolve({ ok: true, value: { ...request.previousReceipt, status: "released" } });
	}
}

export class FakeBudgetPort implements RootAgentBudgetPort {
	public readonly reservations: RootAgentBudgetReserveRequest[] = [];
	public readonly settlements: RootAgentBudgetSettleRequest[] = [];
	public deny = false;

	public reserve(request: RootAgentBudgetReserveRequest): Promise<AgentResult<AgentBudgetReservationRef>> {
		this.reservations.push(request);
		if (this.deny) {
			return Promise.resolve({
				ok: false,
				error: { code: "budget_denied", message: "denied by test budget", retryable: false },
			});
		}
		return Promise.resolve({
			ok: true,
			value: {
				reservationId: createRuntimeId("budgetReservation", nextSeed("budget")),
				operationId: request.requestId,
				requestDigest: request.requestDigest,
			},
		});
	}

	public settle(request: RootAgentBudgetSettleRequest): Promise<AgentResult<void>> {
		this.settlements.push(request);
		return Promise.resolve({ ok: true, value: undefined });
	}
}

export class FakeLauncher implements AgentLauncherPort {
	public readonly launches: AgentLaunchRequest[] = [];
	public readonly resumes: AgentResumeLaunchRequest[] = [];
	public reject = false;
	private readonly revisions = new Map<string, number>();

	private result(agentId: AgentLaunchRequest["agentId"], sessionId: AgentLaunchRequest["sessionId"]): AgentResult<AgentLaunchResult> {
		if (this.reject) {
			return { ok: true, value: { status: "rejected", reasonDigest: digest("9"), retryable: false } };
		}
		const revision = (this.revisions.get(agentId) ?? -1) + 2;
		this.revisions.set(agentId, revision);
		const residency = createAgentResidencyReceipt({
			agentId,
			sessionId,
			runtimeInstanceId: createRuntimeId("runtime", "test"),
			state: "resident",
			revision,
			observedAt: "2026-07-22T00:00:00.000Z",
		});
		if (!residency.ok) return residency;
		return {
			ok: true,
			value: {
				status: "started",
				launchReceipt: {
					receiptId: createRuntimeId("receipt", nextSeed("launch")),
					agentId,
					sessionId,
					launchRevision: revision,
					launchedAt: "2026-07-22T00:00:00.000Z",
					receiptDigest: digest("8"),
				},
				residencyReceipt: residency.value,
			},
		};
	}

	public launch(request: AgentLaunchRequest): Promise<AgentResult<AgentLaunchResult>> {
		this.launches.push(request);
		return Promise.resolve(this.result(request.agentId, request.sessionId));
	}

	public resume(request: AgentResumeLaunchRequest): Promise<AgentResult<AgentLaunchResult>> {
		this.resumes.push(request);
		return Promise.resolve(this.result(request.agentId, request.sessionId));
	}

	public cancel(): Promise<AgentResult<ReturnType<typeof createRuntimeId<"receipt">>>> {
		return Promise.resolve({ ok: true, value: createRuntimeId("receipt", nextSeed("cancel")) });
	}
}

export class FakeDeniedAgents implements AgentDenialEvaluatorPort {
	public status: AgentDenialReceiptRef["status"] = "allowed";
	public readonly checks: Array<{ agentId: string; sessionId: string }> = [];

	public check(
		agentId: Parameters<AgentDenialEvaluatorPort["check"]>[0],
		sessionId: Parameters<AgentDenialEvaluatorPort["check"]>[1],
	): Promise<AgentResult<AgentDenialReceiptRef>> {
		this.checks.push({ agentId, sessionId });
		return Promise.resolve({
			ok: true,
			value: {
				receiptId: createRuntimeId("receipt", nextSeed("denial")),
				agentId,
				sessionId,
				status: this.status,
				decisionRevision: 1,
				checkedAt: "2026-07-22T00:00:00.000Z",
				receiptDigest: digest("7"),
			},
		});
	}
}

export class FakeMergePort implements DeclarativeMergePort {
	public outcome: AgentMergeReceiptRef["outcome"] = "applied";
	public readonly requests: Parameters<DeclarativeMergePort["apply"]>[0][] = [];

	public apply(request: Parameters<DeclarativeMergePort["apply"]>[0]): Promise<AgentResult<AgentMergeReceiptRef>> {
		this.requests.push(request);
		const resultArtifactRefs = this.outcome === "conflict"
			? [artifact(nextSeed("conflict"), request.targetWorkspace.workspaceId)]
			: [];
		const body = {
			receiptId: createRuntimeId("receipt", nextSeed("merge")),
			requestId: request.requestId,
			parentAgentId: request.parentAgentId,
			childAgentId: request.childAgentId,
			targetWorkspaceId: request.targetWorkspace.workspaceId,
			artifactIds: request.artifacts.map((report) => report.artifact.artifactId),
			outcome: this.outcome,
			resultArtifactRefs,
			preservedArtifactRefs:
				this.outcome === "conflict"
					? [...request.artifacts.map((report) => report.artifact), ...resultArtifactRefs]
					: [],
			appliedAt: "2026-07-22T00:00:00.000Z",
		};
		return Promise.resolve({ ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } });
	}
}

export interface RuntimeFakes {
	store: InMemoryAgentGraphStore;
	capability: FakeCapabilitySubsetEvaluator;
	workspace: FakeWorkspacePort;
	budget: FakeBudgetPort;
	launcher: FakeLauncher;
	denied: FakeDeniedAgents;
	merge: FakeMergePort;
	ports: AgentSupervisorPorts;
	supervisor: AgentSupervisor;
}

export function runtimeFakes(limits?: Partial<AgentGraphLimits>): RuntimeFakes {
	const store = new InMemoryAgentGraphStore();
	const capability = new FakeCapabilitySubsetEvaluator();
	const workspace = new FakeWorkspacePort();
	const budget = new FakeBudgetPort();
	const launcher = new FakeLauncher();
	const denied = new FakeDeniedAgents();
	const merge = new FakeMergePort();
	const ports: AgentSupervisorPorts = {
		graphStore: store,
		capabilitySubset: capability,
		workspace,
		budget,
		launcher,
		deniedAgents: denied,
		merge,
	};
	return {
		store,
		capability,
		workspace,
		budget,
		launcher,
		denied,
		merge,
		ports,
		supervisor: new AgentSupervisor({
			rootAgentId: createRuntimeId("agent", "root"),
			ports,
			limits,
			clock: () => new Date("2026-07-22T00:00:00.000Z"),
		}),
	};
}

export function rootRegistration(rootGrant = grant("root-grant")): RegisterRootAgentRequest {
	const sessionId = createRuntimeId("session", "root");
	return {
		requestId: createRuntimeId("command", nextSeed("register-root")),
		idempotencyKey: key("register-root"),
		agentId: createRuntimeId("agent", "root"),
		sessionId,
		goalId: createRuntimeId("goal", "test"),
		role: "build",
		workspaceReceipt: workspaceReceipt(sessionId, "root"),
		capabilityGrant: rootGrant,
		inputSources: [],
		declassificationReceipts: [],
		registeredAt: "2026-07-22T00:00:00.000Z",
	};
}

export function requestedCapabilities(): readonly AgentCapabilityRequestRef[] {
	return [
		{
			kind: "capability",
			requestId: createRuntimeId("command", nextSeed("capability")),
			capability: "workspace_write",
			requestDigest: digest("1"),
		},
		{
			kind: "tool",
			requestId: createRuntimeId("command", nextSeed("unknown-tool")),
			toolKind: "unknown",
			resourceId: createRuntimeId("resource", nextSeed("tool")),
			manifestDigest: digest("2"),
			requiredClaimsDigest: digest("3"),
		},
	];
}

export function spawnRequest(
	parentGrant: ParentCapabilityGrantRef,
	overrides: Partial<SpawnAgentRequest> = {},
): SpawnAgentRequest {
	const childSeed = nextSeed("child");
	return {
		requestId: createRuntimeId("command", `spawn-${childSeed}`),
		idempotencyKey: key(`spawn-${childSeed}`),
		parentAgentId: createRuntimeId("agent", "root"),
		childAgentId: createRuntimeId("agent", childSeed),
		childSessionId: createRuntimeId("session", childSeed),
		role: "build",
		objective: "Implement a bounded child task",
		expectedArtifacts: [{ kind: "diff", mediaType: "text/x-diff", logicalName: "patch" }],
		allowPartial: true,
		depth: 1,
		budget: {
			maxTurns: 8,
			maxInputTokens: 1_000,
			maxOutputTokens: 1_000,
			maxUsdMicros: 100_000,
			maxWallTimeMs: 60_000,
			maxToolCalls: 40,
			maxNetworkBytes: 1_000,
			maxStorageBytes: 10_000,
		},
		parentGrant,
		requestedCapabilities: requestedCapabilities(),
		workspaceStrategy: strategy("managed_worktree"),
		inputSources: [],
		declassificationReceipts: [],
		...overrides,
	};
}
