import { join } from "node:path";
import { Agent } from "../../../src/runtime/agent.ts";
import { ArtifactToolResultSink } from "../../../src/runtime/artifacts/tool-result-sink.ts";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	ProductionAgentDenialEvaluator,
	ProductionAgentWorkspaceAdapter,
	createProductionCapabilityGrantPolicy,
} from "../../../src/runtime/agents/integration/index.ts";
import { ChildOperationBudget } from "../../../src/runtime/agents/integration/child-operation-budget.ts";
import {
	HeadlessChildRuntimeHost,
	type HeadlessChildRuntimeFactoryPort,
	type HeadlessChildRuntimePrepareInput,
} from "../../../src/runtime/agents/integration/headless-child-runtime.ts";
import {
	createProductionAgentSupervisorComposition,
	type ProductionAgentSupervisorComposition,
} from "../../../src/runtime/agents/integration/production-composition.ts";
import { SessionAgentGraphStore } from "../../../src/runtime/agents/session-graph-store.ts";
import { RootBudgetGuardAdapter } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentBudgetRequest,
	AgentBudgetSettlementReceiptRef,
	AgentCapabilityRequestRef,
	AgentGraphProjection,
	AgentResult,
	AgentRuntimeCompletion,
	AgentWorkspaceReleaseReceiptRef,
	AgentWorkspaceReleaseRequest,
	DeclarativeMergePort,
	ParentCapabilityGrantRef,
	RootAgentBudgetPort,
	RootAgentBudgetReserveRequest,
	RootAgentBudgetSettleRequest,
	SpawnAgentRequest,
} from "../../../src/runtime/agents/types.ts";
import type {
	ChildRuntimeAuthorityRecord,
} from "../../../src/runtime/agents/child-runtime-authority.ts";
import {
	BUDGET_DIMENSIONS,
	BudgetGuard,
	type BudgetJournalRecord,
	type BudgetLimits,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import {
	zeroAgentOperationBudgetUsage,
	type AgentOperationBudgetUsage,
} from "../../../src/runtime/operation-budget.ts";
import { SessionDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/session-journal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import {
	createRuntimeId,
	type AgentId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import type {
	SessionMutationAdmissionGatePort,
	SessionMutationAdmissionReceipt,
} from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import type {
	AgentTool,
	LlmContext,
	StreamFn,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
	ToolResultArtifactProjection,
	ToolResultArtifactRequest,
	ToolResultArtifactSink,
} from "../../../src/runtime/types.ts";
import { FileChildRuntimeAuthorityStore } from "../../../src/storage/child-runtime-authority-state.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { Api, AssistantMessage, Model, ToolCall } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import {
	createWorktreeHarness,
	type WorktreeTestHarness,
} from "../../worktree/fixtures.ts";

export const GOVERNED_CHILD_NOW = "2026-07-23T00:00:00.000Z";
export const GOVERNED_CHILD_FEATURES: RuntimeFeatureFlags = {
	...DEFAULT_RUNTIME_FEATURES,
	sessionV3: true,
};
export const GOVERNED_CHILD_EXACT_USAGE = {
	inputTokens: 24,
	outputTokens: 12,
	usdMicros: 0,
	wallTimeMs: 0,
	toolCalls: 1,
	networkBytes: 0,
	storageBytes: 0,
	artifactCount: 1,
	verifications: 1,
} as const;

const POLICY_DIGEST = canonicalDigest(
	"governed child deterministic echo Gateway policy",
);
const EXPECTED_ARTIFACT = {
	kind: "tool_output" as const,
	mediaType: "application/json",
	logicalName: "echo-output",
};
const CHILD_BUDGET: AgentBudgetRequest = {
	maxTurns: 2,
	maxInputTokens: 100_000,
	maxOutputTokens: 100_000,
	maxUsdMicros: 1_000_000,
	maxWallTimeMs: 1_000_000,
	maxToolCalls: 1,
	maxNetworkBytes: 0,
	maxStorageBytes: 8_000_000,
};

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

function operationUsage(
	values: Partial<AgentOperationBudgetUsage> = {},
): AgentOperationBudgetUsage {
	return { ...zeroAgentOperationBudgetUsage(), ...values };
}

function limits(): BudgetLimits {
	return Object.fromEntries(
		BUDGET_DIMENSIONS.map((dimension) => [
			dimension,
			{ soft: 10_000_000, hard: 20_000_000 },
		]),
	) as BudgetLimits;
}

function key(seed: string) {
	return createIdempotencyKey(
		`governed-child-${seed}-${"x".repeat(24)}`,
	);
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	input: number,
	output: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: mockModel.api,
		provider: mockModel.provider,
		model: mockModel.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: Date.parse(GOVERNED_CHILD_NOW),
	};
}

/** 默认 provider 替身严格产生两轮、一次 echo tool call、最终 completed。 */
function deterministicTwoRoundStream(): StreamFn {
	let calls = 0;
	return () => {
		calls += 1;
		if (calls > 2) {
			throw new Error(
				"deterministic governed child exceeded its two-round bound",
			);
		}
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: createRuntimeId(
					"toolCall",
					"governed-child-deterministic-echo",
				),
				name: "echo",
				arguments: { text: "governed child artifact" },
			};
			const message =
				calls === 1
					? assistant([toolCall], "toolUse", 11, 7)
					: assistant(
							[{ type: "text", text: "completed" }],
							"stop",
							13,
							5,
						);
			stream.push({
				type: "start",
				partial: { ...message, content: [] },
			});
			if (calls === 1) {
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall,
					partial: message,
				});
			}
			stream.push({
				type: "done",
				reason: message.stopReason,
				message,
			});
			stream.end(message);
		});
		return stream;
	};
}

/**
 * 第二次 provider invocation 的 test-only barrier。它只控制测试时序，不充当
 * production Verification authority。
 */
export class SecondRoundBarrierStream {
	readonly #delegate: StreamFn;
	readonly #waiting = deferred<LlmContext>();
	readonly #released = deferred<void>();
	#releaseCalled = false;
	#calls = 0;
	#secondContext: LlmContext | undefined;

	public constructor(delegate: StreamFn) {
		this.#delegate = delegate;
	}

	public readonly stream: StreamFn = async (...args) => {
		this.#calls += 1;
		if (this.#calls > 2) {
			throw new Error(
				"governed child fixture exceeded its two-provider-call bound",
			);
		}
		if (this.#calls === 2) {
			this.#secondContext = args[1];
			this.#waiting.resolve(args[1]);
			await this.#released.promise;
		}
		return this.#delegate(...args);
	};

	public calls(): number {
		return this.#calls;
	}

	public waitUntilSecondRound(): Promise<LlmContext> {
		return this.#waiting.promise;
	}

	public secondContext(): LlmContext | undefined {
		return this.#secondContext;
	}

	public releaseSecondRound(): void {
		if (this.#releaseCalled) return;
		this.#releaseCalled = true;
		this.#released.resolve(undefined);
	}
}

class CapturingArtifactToolResultSink implements ToolResultArtifactSink {
	readonly #sink: ArtifactToolResultSink;
	readonly #stored = deferred<ToolResultArtifactProjection>();
	#projection: ToolResultArtifactProjection | undefined;
	#calls = 0;

	public constructor(sink: ArtifactToolResultSink) {
		this.#sink = sink;
	}

	public async storeToolResult(
		request: ToolResultArtifactRequest,
	): Promise<ToolResultArtifactProjection> {
		this.#calls += 1;
		if (this.#calls !== 1) {
			throw new Error(
				"governed child fixture accepts exactly one tool-result Artifact",
			);
		}
		const projection = await this.#sink.storeToolResult(request);
		this.#projection = projection;
		this.#stored.resolve(projection);
		return projection;
	}

	public waitUntilStored(): Promise<ToolResultArtifactProjection> {
		return this.#stored.promise;
	}

	public projection(): ToolResultArtifactProjection | undefined {
		return this.#projection;
	}

	public calls(): number {
		return this.#calls;
	}
}

/**
 * 本 Gateway 是确定性测试替身：它验证 durable start/execute 链路，但不代表
 * production Capability Gateway、Sandbox 或 capability resource mapping 已闭合。
 */
export class DeterministicEchoGateway
	implements ToolExecutionGatewayPort
{
	readonly #manager: V3SessionManager;
	readonly #workspace: HeadlessChildRuntimePrepareInput["workspace"];
	#authorizeCalls = 0;
	#startCalls = 0;
	#executeCalls = 0;

	public constructor(
		manager: V3SessionManager,
		workspace: HeadlessChildRuntimePrepareInput["workspace"],
	) {
		this.#manager = manager;
		this.#workspace = workspace;
	}

	public async authorize(
		request: ToolExecutionGatewayRequest,
	): Promise<ToolExecutionAuthorizationResult> {
		this.#authorizeCalls += 1;
		const identity = this.#manager.identity();
		const workspaceEnvelopeDigest = canonicalDigest({
			sessionId: this.#manager.sessionId(),
			workspaceId: this.#workspace.workspaceReceipt.workspaceId,
			runtimeBinding: this.#workspace.runtimeBinding,
			toolCallId: request.toolCallId,
			cwd: request.cwd,
		});
		const authorizationBody = {
			receiptId: createRuntimeId(
				"receipt",
				`governed-child-auth-${request.toolCallId}`,
			),
			requestId: createRuntimeId(
				"command",
				`governed-child-auth-${request.toolCallId}`,
			),
			approvalId: createRuntimeId(
				"approval",
				`governed-child-auth-${request.toolCallId}`,
			),
			sessionId: this.#manager.sessionId(),
			runtimeId: this.#manager.runtimeId(),
			runtimeGeneration: 1,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			requestDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				arguments: request.arguments,
			}),
			decisionDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				decision: "allow",
			}),
		};
		const authorization = {
			...authorizationBody,
			receiptDigest: canonicalDigest(authorizationBody),
		};
		const sandboxBody = {
			receiptId: createRuntimeId(
				"receipt",
				`governed-child-sandbox-${request.toolCallId}`,
			),
			profileId: createRuntimeId(
				"resource",
				"governed-child-deterministic-sandbox",
			),
			requested: "read-only" as const,
			resolved: "read-only" as const,
			policyDigest: POLICY_DIGEST,
			backendId: "governed-child-test-double",
			effectiveEnforcement: "enforced" as const,
		};
		const sandbox = {
			...sandboxBody,
			resolutionDigest: canonicalDigest(sandboxBody),
		};
		const grantBody = {
			schemaVersion: 1 as const,
			toolCallId: request.toolCallId,
			providerToolCallDigest: canonicalDigest(
				request.providerToolCallId,
			),
			toolIdentityDigest: canonicalDigest(
				request.tool.name.trim(),
			),
			argumentsDigest: canonicalDigest(
				JSON.stringify(request.arguments),
			),
			invocationDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				providerToolCallId: request.providerToolCallId,
				arguments: request.arguments,
				workspaceEnvelopeDigest,
			}),
			workspaceEnvelopeDigest,
			workspaceValidation: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				receiptId: createRuntimeId(
					"receipt",
					`governed-child-workspace-${request.toolCallId}`,
				),
				workspaceId:
					this.#workspace.workspaceReceipt.workspaceId,
				envelopeDigest: workspaceEnvelopeDigest,
				validatorId: identity.principalId,
				validatedAt: GOVERNED_CHILD_NOW,
				outcome: "valid" as const,
			},
			authorization,
			capability: "repository_read" as const,
			policyDigest: POLICY_DIGEST,
			sandbox,
		};
		return {
			status: "authorized",
			grant: {
				...grantBody,
				grantDigest: canonicalDigest(grantBody),
			},
		};
	}

	public async start(
		request: ToolExecutionGatewayExecuteRequest,
		durableStart: () => Promise<void>,
	): Promise<{ status: "ready"; grantDigest: string }> {
		this.#startCalls += 1;
		await durableStart();
		return {
			status: "ready",
			grantDigest: request.grant.grantDigest,
		};
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
	): Promise<ToolExecutionGatewayExecuteResult> {
		this.#executeCalls += 1;
		const result = await request.invocation.tool.execute(
			request.invocation.providerToolCallId,
			request.invocation.arguments as never,
		);
		return {
			status: "completed",
			grantDigest: request.grant.grantDigest,
			result,
		};
	}

	public counts(): {
		authorize: number;
		start: number;
		execute: number;
	} {
		return {
			authorize: this.#authorizeCalls,
			start: this.#startCalls,
			execute: this.#executeCalls,
		};
	}
}

interface PreparedChildRuntime {
	manager: V3SessionManager;
	host: HeadlessChildRuntimeHost;
	operationBudget: ChildOperationBudget;
	barrier: SecondRoundBarrierStream;
	gateway: DeterministicEchoGateway;
	artifactSink: CapturingArtifactToolResultSink;
}

export interface GovernedChildRuntimeFactoryOptions {
	model?: Model<Api>;
	streamFn?: StreamFn;
	systemPrompt?: string;
	clock?: () => Date;
}

/** production launcher 可注入的 headless child factory；默认行为完全确定性。 */
export class GovernedChildRuntimeFactory
	implements HeadlessChildRuntimeFactoryPort
{
	readonly #options: GovernedChildRuntimeFactoryOptions;
	#runtime: PreparedChildRuntime | undefined;

	public constructor(options: GovernedChildRuntimeFactoryOptions = {}) {
		this.#options = options;
	}

	public async prepare(
		input: HeadlessChildRuntimePrepareInput,
	): Promise<AgentResult<HeadlessChildRuntimeHost>> {
		if (this.#runtime) {
			return {
				ok: false,
				error: {
					code: "launch_failed",
					message:
						"governed child fixture supports exactly one prepared runtime",
					retryable: false,
				},
			};
		}
		const operationBudget = new ChildOperationBudget({
			budget: input.request.budget,
			clock:
				this.#options.clock ??
				(() => new Date(GOVERNED_CHILD_NOW)),
		});
		const barrier = new SecondRoundBarrierStream(
			this.#options.streamFn ?? deterministicTwoRoundStream(),
		);
		const gateway = new DeterministicEchoGateway(
			input.manager,
			input.workspace,
		);
		const identity = input.manager.identity();
		const artifactSink = new CapturingArtifactToolResultSink(
			new ArtifactToolResultSink({
				repository: input.manager.artifactRepository(),
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				sessionId: input.manager.sessionId(),
				producerId: input.request.agentId,
				workspaceId:
					input.workspace.workspaceReceipt.workspaceId,
				lineage: {
					origin: "internal",
					inputSources: input.request.inputSources,
					declassificationReceipts:
						input.request.declassificationReceipts,
				},
			}),
		);
		const tool: AgentTool = {
			...echoTool,
			governedExecution: "tool-context",
		};
		const host = new HeadlessChildRuntimeHost({
			manager: input.manager,
			operationBudget,
			prompt: input.request.objective,
			agentFactory: ({
				sessionEvents,
				operationBudget: activeBudget,
			}) =>
				new Agent({
					initialState: {
						systemPrompt:
							this.#options.systemPrompt ??
							"Execute exactly one echo tool call, then stop.",
						model: this.#options.model ?? mockModel,
						tools: [tool],
					},
					streamFn: barrier.stream,
					loopConfig: {
						cwd: input.workspace.envelope.cwd,
						sessionEvents,
						operationBudget: activeBudget,
						toolExecutionGateway: gateway,
						toolResultArtifactSink: artifactSink,
						shouldStopAfterTurn: ({ turn }) =>
							turn >= 2,
					},
				}),
		});
		this.#runtime = {
			manager: input.manager,
			host,
			operationBudget,
			barrier,
			gateway,
			artifactSink,
		};
		return { ok: true, value: host };
	}

	#prepared(): PreparedChildRuntime {
		if (!this.#runtime) {
			throw new Error("governed child runtime has not been prepared");
		}
		return this.#runtime;
	}

	public waitUntilAttestationBarrier(): Promise<LlmContext> {
		return this.#prepared().barrier.waitUntilSecondRound();
	}

	public releaseSecondRound(): void {
		this.#runtime?.barrier.releaseSecondRound();
	}

	public waitUntilArtifactStored(): Promise<ToolResultArtifactProjection> {
		return this.#prepared().artifactSink.waitUntilStored();
	}

	public completion(): Promise<AgentResult<AgentRuntimeCompletion>> {
		return this.#prepared().host.completion();
	}

	public manager(): V3SessionManager {
		return this.#prepared().manager;
	}

	public operationBudget(): ChildOperationBudget {
		return this.#prepared().operationBudget;
	}

	public gateway(): DeterministicEchoGateway {
		return this.#prepared().gateway;
	}

	public providerCalls(): number {
		return this.#prepared().barrier.calls();
	}

	public artifactCalls(): number {
		return this.#prepared().artifactSink.calls();
	}

	public secondContext(): LlmContext | undefined {
		return this.#prepared().barrier.secondContext();
	}

	/** test attestor 的 verification receipt usage；不是 production Verification。 */
	public async recordTestVerificationUsage(
		artifact: ToolResultArtifactProjection["artifactRef"],
	): Promise<void> {
		const actual = operationUsage({ verifications: 1 });
		const reservation = await this.#prepared().operationBudget.reserve({
			kind: "tool",
			operationKey: `test-attestor-${artifact.artifactId}`,
			estimatedUpperBound: actual,
		});
		await this.#prepared().operationBudget.commit({
			reservation,
			outcome: "succeeded",
			actual,
			resultDigest: canonicalDigest({
				kind: "test-only-artifact-attestation",
				artifactId: artifact.artifactId,
				storedDigest: artifact.storedDigest,
			}),
		});
	}
}

class TracingProductionAgentWorkspaceAdapter
	extends ProductionAgentWorkspaceAdapter
{
	readonly #order: string[];
	#recorded = false;

	public constructor(
		options: ConstructorParameters<
			typeof ProductionAgentWorkspaceAdapter
		>[0],
		order: string[],
	) {
		super(options);
		this.#order = order;
	}

	public override async release(
		request: AgentWorkspaceReleaseRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReleaseReceiptRef>> {
		const result = await super.release(request, signal);
		if (result.ok && !this.#recorded) {
			this.#recorded = true;
			this.#order.push("Workspace");
		}
		return result;
	}
}

class TracingFileChildRuntimeAuthorityStore
	extends FileChildRuntimeAuthorityStore
{
	readonly #order: string[];
	#recorded = false;

	public constructor(root: string, order: string[]) {
		super(root);
		this.#order = order;
	}

	public override async compareAndSwap(
		...args: Parameters<
			FileChildRuntimeAuthorityStore["compareAndSwap"]
		>
	): Promise<
		Awaited<
			ReturnType<
				FileChildRuntimeAuthorityStore["compareAndSwap"]
			>
		>
	> {
		const result = await super.compareAndSwap(...args);
		const next: ChildRuntimeAuthorityRecord = args[3];
		if (
			next.state === "released" &&
			(result === "applied" || result === "replay") &&
			!this.#recorded
		) {
			this.#recorded = true;
			this.#order.push("runtime");
		}
		return result;
	}
}

class TracingRootBudgetPort implements RootAgentBudgetPort {
	readonly #delegate: RootAgentBudgetPort;
	readonly #order: string[];
	#recorded = false;

	public constructor(
		delegate: RootAgentBudgetPort,
		order: string[],
	) {
		this.#delegate = delegate;
		this.#order = order;
	}

	public reserve(
		request: RootAgentBudgetReserveRequest,
	): Promise<
		AgentResult<
			Awaited<
				ReturnType<RootAgentBudgetPort["reserve"]>
			> extends AgentResult<infer T>
				? T
				: never
		>
	> {
		return this.#delegate.reserve(request);
	}

	public async settle(
		request: RootAgentBudgetSettleRequest,
	): Promise<AgentResult<AgentBudgetSettlementReceiptRef>> {
		const result = await this.#delegate.settle(request);
		if (result.ok && !this.#recorded) {
			this.#recorded = true;
			this.#order.push("Budget");
		}
		return result;
	}
}

function unusedMergePort(): DeclarativeMergePort {
	return {
		apply: async () => ({
			ok: false,
			error: {
				code: "merge_invalid",
				message:
					"governed child runtime fixture does not exercise handoff or merge",
				retryable: false,
			},
		}),
	};
}

function parentMutationGate(
	manager: V3SessionManager,
): SessionMutationAdmissionGatePort {
	return {
		revalidate: async (request) => {
			const eventHead = manager.writer().currentHead();
			if (!eventHead) {
				return {
					ok: false,
					error: {
						code: "external_unavailable",
						message:
							"parent session event head is unavailable",
						retryable: false,
					},
				};
			}
			const identity = manager.identity();
			const body: Omit<
				SessionMutationAdmissionReceipt,
				"receiptDigest"
			> = {
				schemaVersion: 1,
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				sessionId: manager.sessionId(),
				kind: request.kind,
				correlationId: request.correlationId,
				eventHead,
				checkedAt: GOVERNED_CHILD_NOW,
				auditReceipts: [],
			};
			return {
				ok: true,
				value: {
					...body,
					receiptDigest: canonicalDigest(body),
				},
			};
		},
	};
}

export interface GovernedChildRuntimeFixtureOptions
	extends GovernedChildRuntimeFactoryOptions {
	objective?: string;
	childBudget?: AgentBudgetRequest;
}

export interface GovernedChildRuntimeFixture {
	worktree: WorktreeTestHarness;
	parentManager: V3SessionManager;
	composition: ProductionAgentSupervisorComposition;
	runtimeFactory: GovernedChildRuntimeFactory;
	authorityStore: FileChildRuntimeAuthorityStore;
	rootAgentId: AgentId;
	spawnRequest: SpawnAgentRequest;
	cleanupOrder: string[];
	attestBeforeSecondRound(): Promise<ToolResultArtifactProjection>;
	replayChildEvents(): Promise<
		Awaited<ReturnType<typeof readAllRuntimeEvents>>
	>;
	replayParentGraph(): Promise<
		AgentResult<{
			projection: AgentGraphProjection;
			revision: number;
		}>
	>;
	cleanup(): Promise<void>;
}

/**
 * 完整 fixture 使用真实 V3 parent/child、ProductionAgentWorkspaceAdapter、
 * FileChildRuntimeAuthorityStore 与 production supervisor composition。唯一测试替身是
 * bounded echo Gateway、attestor/Verification 和未使用的 merge port。
 */
export async function createGovernedChildRuntimeFixture(
	options: GovernedChildRuntimeFixtureOptions = {},
): Promise<GovernedChildRuntimeFixture> {
	const {
		objective,
		childBudget = CHILD_BUDGET,
		...runtimeFactoryOptions
	} = options;
	const worktree = await createWorktreeHarness();
	const cleanupOrder: string[] = [];
	const identity = createLocalIdentityContext(
		new Date(GOVERNED_CHILD_NOW),
	);
	const rootAgentId = createRuntimeId(
		"agent",
		"governed-child-parent",
	);
	const goalId = createRuntimeId("goal", "governed-child-parent");
	const parentManager = await V3SessionManager.create({
		cwd: worktree.sourceCwd,
		sessionDir: join(worktree.root, "parent-sessions"),
		features: GOVERNED_CHILD_FEATURES,
		identity,
		sessionId: createRuntimeId(
			"session",
			"governed-child-parent",
		),
		runtimeId: createRuntimeId(
			"runtime",
			"governed-child-parent",
		),
		lineage: { agentId: rootAgentId, goalId },
	});
	let composition: ProductionAgentSupervisorComposition | undefined;
	const reopenedManagers: V3SessionManager[] = [];
	let compositionClosed = false;
	let parentClosed = false;
	try {
		const repositoryId = createRuntimeId(
			"repository",
			"governed-child",
		);
		const workspace =
			new TracingProductionAgentWorkspaceAdapter(
				{
					manager: worktree.manager,
					authorityId: identity.authorityId,
					tenantId: identity.tenantId,
					principalId: identity.principalId,
					repositoryId,
					sourceRepo: worktree.sourceRepo,
					sourceCwd: worktree.sourceCwd,
					rootAgentId,
					rootOwnerRuntimeId: parentManager.runtimeId(),
					clock: () => new Date(GOVERNED_CHILD_NOW),
				},
				cleanupOrder,
			);
		const rootStrategy = {
			strategyId: createRuntimeId(
				"resource",
				"governed-child-root-source",
			),
			kind: "isolated_lease" as const,
			strategyDigest: canonicalDigest(
				"governed child root source strategy",
			),
		};
		const childStrategy = {
			strategyId: createRuntimeId(
				"resource",
				"governed-child-managed-worktree",
			),
			kind: "managed_worktree" as const,
			strategyDigest: canonicalDigest(
				"governed child managed worktree strategy",
			),
		};
		const rootWorkspace = await workspace.bindRoot({
			requestId: createRuntimeId(
				"command",
				"governed-child-bind-root",
			),
			agentId: rootAgentId,
			sessionId: parentManager.sessionId(),
			strategy: rootStrategy,
		});
		if (!rootWorkspace.ok) {
			throw new Error(rootWorkspace.error.message);
		}
		const parentGrant: ParentCapabilityGrantRef = {
			receiptId: createRuntimeId(
				"receipt",
				"governed-child-parent-grant",
			),
			receiptDigest: canonicalDigest(
				"governed child parent grant",
			),
			decisionRevision: 1,
		};
		const requestedCapability: AgentCapabilityRequestRef = {
			kind: "capability",
			requestId: createRuntimeId(
				"command",
				"governed-child-repository-read",
			),
			capability: "repository_read",
			requestDigest: canonicalDigest(
				"governed child repository read",
			),
		};
		const capabilitySubset =
			new GatewayBoundCapabilitySubsetEvaluator(
				[
					createProductionCapabilityGrantPolicy({
						policyReceiptId: createRuntimeId(
							"receipt",
							"governed-child-delegation-policy",
						),
						parentGrant,
						allowedRequests: [requestedCapability],
						delegableToolKinds: [],
						childSpawnAllowed: false,
						decisionRevision: 1,
						evaluatorId: identity.principalId,
						issuedAt: GOVERNED_CHILD_NOW,
					}),
				],
				() => new Date(GOVERNED_CHILD_NOW),
			);
		const budgetGuard = new BudgetGuard({
			goalId,
			limits: limits(),
			journal:
				new SessionDurableOrchestratorJournal<BudgetJournalRecord>(
					{
						journalKind: "budget",
						writer: parentManager.writer(),
						store: parentManager.eventStore(),
						principalId: identity.principalId,
					},
				),
			clock: () => new Date(GOVERNED_CHILD_NOW),
		});
		const runtimeFactory = new GovernedChildRuntimeFactory({
			...runtimeFactoryOptions,
			clock: () => new Date(GOVERNED_CHILD_NOW),
		});
		const authorityStore =
			new TracingFileChildRuntimeAuthorityStore(
				join(
					worktree.root,
					"child-runtime-authority",
				),
				cleanupOrder,
			);
		composition =
			await createProductionAgentSupervisorComposition({
				manager: parentManager,
				parentMutationGate:
					parentMutationGate(parentManager),
				root: {
					requestId: createRuntimeId(
						"command",
						"governed-child-register-root",
					),
					idempotencyKey: key("register-root"),
					agentId: rootAgentId,
					goalId,
					role: "build",
					workspaceReceipt: rootWorkspace.value,
					capabilityGrant: parentGrant,
					inputSources: [],
					declassificationReceipts: [],
					registeredAt: GOVERNED_CHILD_NOW,
				},
				adapters: {
					capabilitySubset,
					workspace,
					deniedAgents:
						new ProductionAgentDenialEvaluator(
							{
								policyDigest: canonicalDigest(
									"governed child denial policy",
								),
								decisionRevision: 1,
								deniedAgentIds: new Set(),
							},
							() =>
								new Date(
									GOVERNED_CHILD_NOW,
								),
						),
					budget: new TracingRootBudgetPort(
						new RootBudgetGuardAdapter(
							budgetGuard,
						),
						cleanupOrder,
					),
					merge: unusedMergePort(),
				},
				child: {
					sessionDir: join(
						worktree.root,
						"child-sessions",
					),
					features: GOVERNED_CHILD_FEATURES,
					maxActiveChildren: 1,
					runtimeFactory,
					clock: () =>
						new Date(GOVERNED_CHILD_NOW),
				},
				authorityStore,
				clock: () => new Date(GOVERNED_CHILD_NOW),
			});
		const childAgentId = createRuntimeId(
			"agent",
			"governed-child-runtime",
		);
		const spawnRequest: SpawnAgentRequest = {
			requestId: createRuntimeId(
				"command",
				"governed-child-spawn",
			),
			idempotencyKey: key("spawn"),
			parentAgentId: rootAgentId,
			childAgentId,
			childSessionId: createRuntimeId(
				"session",
				"governed-child-runtime",
			),
			role: "build",
			objective:
				objective ??
				"Call echo exactly once and complete after its ArtifactRef is available.",
			expectedArtifacts: [EXPECTED_ARTIFACT],
			allowPartial: false,
			depth: 1,
			budget: { ...childBudget },
			parentGrant,
			requestedCapabilities: [requestedCapability],
			workspaceStrategy: childStrategy,
			inputSources: [],
			declassificationReceipts: [],
		};
		const activeComposition = composition;

		const fixture: GovernedChildRuntimeFixture = {
			worktree,
			parentManager,
			composition: activeComposition,
			runtimeFactory,
			authorityStore,
			rootAgentId,
			spawnRequest,
			cleanupOrder,
			attestBeforeSecondRound: async () => {
				const projection =
					await runtimeFactory.waitUntilArtifactStored();
				const reported =
					await activeComposition.supervisor.reportArtifact(
						{
							requestId: createRuntimeId(
								"command",
								"governed-child-test-attest",
							),
							idempotencyKey: key(
								"test-attest",
							),
							report: {
								agentId: childAgentId,
								logicalName:
									EXPECTED_ARTIFACT.logicalName,
								artifact:
									projection.artifactRef,
								integrity: "valid",
								verification: "verified",
								inputSources: [],
								declassificationReceipts:
									[],
								reportedAt:
									GOVERNED_CHILD_NOW,
							},
						},
					);
				if (!reported.ok) {
					throw new Error(reported.error.message);
				}
				await runtimeFactory.recordTestVerificationUsage(
					projection.artifactRef,
				);
				return projection;
			},
			replayChildEvents: async () => {
				const child = runtimeFactory.manager();
				if (!child.isClosed()) {
					throw new Error(
						"child runtime must complete governed release before replay",
					);
				}
				const reopened = await V3SessionManager.open(
					child.filePath(),
					GOVERNED_CHILD_FEATURES,
					child.identity(),
					{ reconcileArtifacts: false },
				);
				reopenedManagers.push(reopened);
				return readAllRuntimeEvents(
					reopened.eventStore(),
				);
			},
			replayParentGraph: async () => {
				if (!compositionClosed) {
					await activeComposition.close();
					compositionClosed = true;
				}
				if (!parentClosed) {
					await parentManager.closeAll();
					parentClosed = true;
				}
				const reopened = await V3SessionManager.open(
					parentManager.filePath(),
					GOVERNED_CHILD_FEATURES,
					parentManager.identity(),
				);
				reopenedManagers.push(reopened);
				return new SessionAgentGraphStore({
					writer: reopened.writer(),
					store: reopened.eventStore(),
					principalId: identity.principalId,
				}).load(rootAgentId);
			},
			cleanup: async () => {
				runtimeFactory.releaseSecondRound();
				await activeComposition.supervisor
					.waitForRuntimeCompletion(
						childAgentId,
						5_000,
					)
					.catch(() => undefined);
				if (!compositionClosed) {
					await activeComposition
						.close()
						.catch(() => undefined);
					compositionClosed = true;
				}
				const preparedManager = (() => {
					try {
						return runtimeFactory.manager();
					} catch {
						return undefined;
					}
				})();
				if (
					preparedManager &&
					!preparedManager.isClosed()
				) {
					await preparedManager
						.closeAll()
						.catch(() => undefined);
				}
				await Promise.all(
					reopenedManagers
						.splice(0)
						.map((manager) =>
							manager
								.closeAll()
								.catch(
									() =>
										undefined,
								),
						),
				);
				if (!parentClosed) {
					await parentManager
						.closeAll()
						.catch(() => undefined);
					parentClosed = true;
				}
				await worktree.cleanup();
			},
		};
		return fixture;
	} catch (error) {
		await composition?.close().catch(() => undefined);
		await parentManager.closeAll().catch(() => undefined);
		await worktree.cleanup();
		throw error;
	}
}
