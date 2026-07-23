import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { InMemoryAgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentCapabilityRequestRef,
	AgentBudgetUsage,
	AgentBudgetReservationRef,
	AgentBudgetSettlementReceiptRef,
	AgentDenialEvaluatorPort,
	AgentDenialReceiptRef,
	AgentError,
	AgentGraphLimits,
	AgentLaunchRequest,
	AgentLauncherPort,
	AgentLaunchResult,
	AgentMergeReceiptRef,
	AgentResult,
	AgentResumeLaunchRequest,
	AgentRuntimeReleaseReceiptRef,
	AgentRuntimeReleaseRequest,
	AgentSupervisorPorts,
	AgentWorkspacePort,
	AgentWorkspaceReceiptRef,
	AgentWorkspaceReleaseReceiptRef,
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

export function zeroUsage(): AgentBudgetUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		usdMicros: 0,
		wallTimeMs: 0,
		toolCalls: 0,
		networkBytes: 0,
		storageBytes: 0,
		artifactCount: 0,
		verifications: 0,
	};
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
		leaseId: createRuntimeId("lease", seed),
		leaseRevision: 1,
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
	public releaseError: AgentError | undefined;
	public throwRelease = false;
	public releaseExecutions = 0;
	private readonly released = new Map<string, {
		requestDigest: string;
		receipt: AgentWorkspaceReleaseReceiptRef;
	}>();

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

	public release(
		request: Parameters<AgentWorkspacePort["release"]>[0],
	): Promise<AgentResult<AgentWorkspaceReleaseReceiptRef>> {
		this.releases.push(request);
		if (this.throwRelease) throw new Error("injected test Workspace release throw");
		const replay = this.released.get(request.requestId);
		if (replay) {
			return Promise.resolve(
				replay.requestDigest === request.requestDigest
					? { ok: true, value: structuredClone(replay.receipt) }
					: {
							ok: false,
							error: { code: "idempotency_conflict", message: "test Workspace release identity drifted", retryable: false },
						},
			);
		}
		if (this.releaseError) return Promise.resolve({ ok: false, error: this.releaseError });
		if (!request.previousReceipt.leaseId || request.previousReceipt.leaseRevision === undefined) {
			return Promise.resolve({
				ok: false,
				error: {
					code: "workspace_invalid",
					message: "test Workspace release lacks lease correlation",
					retryable: false,
				},
			});
		}
		this.releaseExecutions += 1;
		const releasedAt = "2026-07-22T00:00:03.000Z";
		const receiptId = createRuntimeId(
			"receipt",
			`workspace-release-${canonicalDigest(request.requestId).slice(0, 40)}`,
		);
		const { receiptDigest: _receiptDigest, ...previous } = request.previousReceipt;
		const releasedBody: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
			...previous,
			receiptId,
			status: "released",
			issuedAt: releasedAt,
		};
		const releasedWorkspaceReceipt = {
			...releasedBody,
			receiptDigest: canonicalDigest(releasedBody),
		};
		const authorityBody: Omit<
			AgentWorkspaceReleaseReceiptRef["authorityReceipt"],
			"receiptDigest"
		> = {
			schemaVersion: 1,
			kind: "workspace_release_receipt",
			receiptId,
			requestId: request.requestId,
			requestDigest: canonicalDigest({
				requestId: request.requestId,
				callerRequestDigest: request.requestDigest,
				workspaceId: request.previousReceipt.workspaceId,
				leaseId: request.previousReceipt.leaseId,
				leaseRevision: request.previousReceipt.leaseRevision,
			}),
			callerRequestDigest: request.requestDigest,
			authorityId: createRuntimeId("authority", "test-workspace-release"),
			tenantId: createRuntimeId("tenant", "test-workspace-release"),
			principalId: createRuntimeId("principal", "test-workspace-release"),
			sessionId: request.sessionId,
			agentId: request.agentId,
			workspaceId: request.previousReceipt.workspaceId,
			repositoryId: request.previousReceipt.repositoryId,
			envelopeDigest: digest("6"),
			leaseId: request.previousReceipt.leaseId,
			leaseRevision: request.previousReceipt.leaseRevision,
			releasedLeaseDigest: canonicalDigest({
				leaseId: request.previousReceipt.leaseId,
				leaseRevision: request.previousReceipt.leaseRevision,
				state: "released",
			}),
			retainedRecordDigest: canonicalDigest({
				workspaceId: request.previousReceipt.workspaceId,
				state: "retained",
			}),
			releasedAt,
		};
		const authorityReceipt = {
			...authorityBody,
			receiptDigest: canonicalDigest(authorityBody),
		};
		const releaseBody: Omit<AgentWorkspaceReleaseReceiptRef, "receiptDigest"> = {
			schemaVersion: 1,
			kind: "agent_workspace_release_receipt",
			receiptId,
			requestId: request.requestId,
			requestDigest: request.requestDigest,
			agentId: request.agentId,
			sessionId: request.sessionId,
			workspaceId: request.previousReceipt.workspaceId,
			repositoryId: request.previousReceipt.repositoryId,
			previousReceiptId: request.previousReceipt.receiptId,
			previousReceiptDigest: request.previousReceipt.receiptDigest,
			bindingDigest: request.previousReceipt.bindingDigest,
			leaseId: request.previousReceipt.leaseId,
			leaseRevision: request.previousReceipt.leaseRevision,
			releasedWorkspaceReceipt,
			authorityReceipt,
			releasedAt,
		};
		const receipt = { ...releaseBody, receiptDigest: canonicalDigest(releaseBody) };
		this.released.set(request.requestId, { requestDigest: request.requestDigest, receipt });
		return Promise.resolve({ ok: true, value: structuredClone(receipt) });
	}
}

export class FakeBudgetPort implements RootAgentBudgetPort {
	public readonly reservations: RootAgentBudgetReserveRequest[] = [];
	public readonly settlements: RootAgentBudgetSettleRequest[] = [];
	public deny = false;
	public settlementError: AgentError | undefined;
	public throwSettlement = false;
	public settlementExecutions = 0;
	private readonly settled = new Map<string, { requestDigest: string; receipt: AgentBudgetSettlementReceiptRef }>();

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

	public settle(request: RootAgentBudgetSettleRequest): Promise<AgentResult<AgentBudgetSettlementReceiptRef>> {
		this.settlements.push(request);
		if (this.throwSettlement) throw new Error("injected test budget settlement throw");
		const replay = this.settled.get(request.idempotencyKey);
		if (replay) {
			return Promise.resolve(
				replay.requestDigest === request.requestDigest
					? { ok: true, value: structuredClone(replay.receipt) }
					: {
							ok: false,
							error: { code: "idempotency_conflict", message: "test budget settlement identity drifted", retryable: false },
						},
			);
		}
		if (this.settlementError) return Promise.resolve({ ok: false, error: this.settlementError });
		this.settlementExecutions += 1;
		const body: Omit<AgentBudgetSettlementReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId(
				"receipt",
				`budget-settlement-${canonicalDigest({ reservationId: request.reservation.reservationId, requestDigest: request.requestDigest }).slice(0, 40)}`,
			),
			reservationId: request.reservation.reservationId,
			outcome: request.outcome,
			usageDigest: canonicalDigest(request.usage ?? null),
			partialResultsDigest: canonicalDigest(request.partialResults),
			requestDigest: request.requestDigest,
			settledAt: request.settledAt,
		};
		const receipt = { ...body, receiptDigest: canonicalDigest(body) };
		this.settled.set(request.idempotencyKey, { requestDigest: request.requestDigest, receipt });
		return Promise.resolve({ ok: true, value: structuredClone(receipt) });
	}
}

export class FakeLauncher implements AgentLauncherPort {
	public readonly launches: AgentLaunchRequest[] = [];
	public readonly resumes: AgentResumeLaunchRequest[] = [];
	public readonly releases: AgentRuntimeReleaseRequest[] = [];
	public cancelCalls = 0;
	public reject = false;
	public releaseError: AgentError | undefined;
	public throwRelease = false;
	public releaseExecutions = 0;
	private readonly revisions = new Map<string, number>();
	private readonly started = new Map<string, Extract<AgentLaunchResult, { status: "started" }>>();
	private readonly released = new Map<string, { requestDigest: string; receipt: AgentRuntimeReleaseReceiptRef }>();

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
		const launchBody = {
			receiptId: createRuntimeId("receipt", nextSeed("launch")),
			agentId,
			sessionId,
			launchRevision: revision,
			launchedAt: "2026-07-22T00:00:00.000Z",
		};
		const value: Extract<AgentLaunchResult, { status: "started" }> = {
			status: "started",
			launchReceipt: {
				...launchBody,
				receiptDigest: canonicalDigest(launchBody),
			},
			residencyReceipt: residency.value,
		};
		this.started.set(agentId, value);
		return {
			ok: true,
			value,
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

	public release(request: AgentRuntimeReleaseRequest): Promise<AgentResult<AgentRuntimeReleaseReceiptRef>> {
		this.releases.push(request);
		if (this.throwRelease) throw new Error("injected test child runtime release throw");
		const replay = this.released.get(request.agentId);
		if (replay) {
			return Promise.resolve(
				replay.requestDigest === request.requestDigest
					? { ok: true, value: structuredClone(replay.receipt) }
					: {
							ok: false,
							error: { code: "idempotency_conflict", message: "test runtime release identity drifted", retryable: false },
						},
			);
		}
		const started = this.started.get(request.agentId);
		if (!started) {
			return Promise.resolve({
				ok: false,
				error: { code: "agent_not_found", message: "test child runtime is missing", retryable: false },
			});
		}
		if (this.releaseError) return Promise.resolve({ ok: false, error: this.releaseError });
		this.releaseExecutions += 1;
		const releasedAt = "2026-07-22T00:00:02.000Z";
		const residency = createAgentResidencyReceipt({
			agentId: request.agentId,
			sessionId: request.sessionId,
			runtimeInstanceId: started.residencyReceipt.runtimeInstanceId,
			state: "nonresident",
			revision: request.previousResidencyReceipt.revision + 1,
			observedAt: releasedAt,
			reasonDigest: canonicalDigest(request.reason),
		});
		if (!residency.ok) return Promise.resolve(residency);
		const body: Omit<AgentRuntimeReleaseReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId("receipt", `runtime-release-${canonicalDigest(request.requestDigest).slice(0, 40)}`),
			requestId: request.requestId,
			requestDigest: request.requestDigest,
			agentId: request.agentId,
			sessionId: request.sessionId,
			runtimeInstanceId: started.residencyReceipt.runtimeInstanceId,
			launchReceiptId: request.launchReceipt.receiptId,
			launchRevision: request.launchReceipt.launchRevision,
			writerFenceReceiptId: createRuntimeId("receipt", `writer-fence-${request.agentId}`),
			writerFenceReceiptDigest: canonicalDigest({ agentId: request.agentId, sessionId: request.sessionId }),
			finalCursor: {
				stream: {
					scope: "session",
					streamId: createRuntimeId("eventStream", `runtime-release-${request.sessionId}`),
					sessionId: request.sessionId,
				},
				sequence: 1,
				eventId: createRuntimeId("event", `runtime-release-${request.agentId}`),
				eventHash: canonicalDigest({ agentId: request.agentId, requestDigest: request.requestDigest }),
			},
			residencyReceipt: residency.value,
			releasedAt,
		};
		const receipt = { ...body, receiptDigest: canonicalDigest(body) };
		this.released.set(request.agentId, { requestDigest: request.requestDigest, receipt });
		return Promise.resolve({ ok: true, value: structuredClone(receipt) });
	}

	public cancel(): Promise<AgentResult<ReturnType<typeof createRuntimeId<"receipt">>>> {
		this.cancelCalls += 1;
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
