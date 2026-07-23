/** Phase 10 headless composition root；所有 policy/security/artifact 行为通过端口注入。 */

import { sameRuntimeEventStream, type EventCursor } from "../runtime/protocol/v3/events.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type {
	AuthorityId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TurnId,
} from "../runtime/protocol/v3/ids.ts";
import { ControlPlaneCommandBus } from "../runtime/control-plane/command-bus.ts";
import type { ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import { ControlPlaneError, controlPlaneFailure } from "../runtime/control-plane/errors.ts";
import {
	InMemoryCommandIdempotencyRepository,
	type CommandIdempotencyRepository,
} from "../runtime/control-plane/idempotency.ts";
import type { LocalPeerIdentityResolverPort } from "../runtime/control-plane/local-peer.ts";
import {
	ControlPlaneQueryService,
	type SessionHandleValidationPort,
} from "../runtime/control-plane/query-service.ts";
import {
	SessionRuntimeRegistry,
	type RuntimeGenerationTransitionPort,
	type SessionRuntimeFactoryPort,
} from "../runtime/control-plane/session-registry.ts";
import { ShutdownCoordinator } from "../runtime/control-plane/shutdown.ts";
import {
	EventSubscriptionService,
	type EventSubscriptionSourcePort,
} from "../runtime/control-plane/subscriptions.ts";
import type { SessionSubscriptionLifecyclePort } from "../runtime/control-plane/session-lifecycle.ts";
import type {
	ApprovalResolutionCoordinatorPort,
	ChangeProposalControlPlanePort,
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneFeature,
	ControlPlaneQuery,
	ControlPlaneQueryValue,
	ControlPlaneRequestContext,
	HumanGateControlPlanePort,
	MutationExecutorPort,
	MutationStateGuardPort,
	PromptEnqueuePort,
	QueueControlPlanePort,
	QueryExecutorPort,
} from "../runtime/control-plane/types.ts";
import type { CommittedCommandReceipt } from "../runtime/control-plane/idempotency.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	CONTROL_PLANE_FEATURES,
	CONTROL_PLANE_QUERY_TYPES,
} from "../runtime/control-plane/types.ts";
import {
	controlPlaneFeatureForCommand,
	controlPlaneFeatureForQuery,
	validateProductionCompositionReceipt,
	type ProductionCompositionReceipt,
} from "./production-composition.ts";
import { HeadlessDaemonServer, type HeadlessDaemonServerAccess } from "./server.ts";
import type { MultiAgentControlPlanePort } from "../runtime/control-plane/multi-agent-contracts.ts";
import type { SupervisorMultiAgentControlPlaneAdapter } from "../runtime/control-plane/supervisor-control-plane.ts";

export interface SessionControlState {
	sessionId: SessionId;
	revision: EventCursor | null;
	activeTurnId: TurnId | null;
}

export interface SessionControlStatePort {
	inspect(sessionId: SessionId): Promise<ControlPlaneResult<SessionControlState>>;
}

export interface DaemonShutdownProtocolPort {
	request(
		command: Extract<ControlPlaneCommand, { type: "shutdown" }>,
		context: ControlPlaneRequestContext,
		runtimeGeneration: number,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "shutdown" }>>>;
	committed(
		command: Extract<ControlPlaneCommand, { type: "shutdown" }>,
		effect: Extract<ControlPlaneCommandEffect, { type: "shutdown" }>,
		receipt: CommittedCommandReceipt,
	): void;
}

function commandSessionId(command: ControlPlaneCommand): SessionId | undefined {
	switch (command.type) {
		case "session:start":
		case "shutdown":
			return undefined;
		case "session:fork":
			return command.payload.parentSessionId;
		default:
			return command.payload.sessionId;
	}
}

class DaemonMutationStateGuard implements MutationStateGuardPort {
	readonly #sessions: SessionRuntimeRegistry;
	readonly #states: SessionControlStatePort;

	public constructor(sessions: SessionRuntimeRegistry, states: SessionControlStatePort) {
		this.#sessions = sessions;
		this.#states = states;
	}

	public async validate(command: ControlPlaneCommand, _context: ControlPlaneRequestContext): Promise<ControlPlaneResult<void>> {
		if (command.type === "session:start" || command.type === "session:resume" || command.type === "shutdown") {
			return { ok: true, value: undefined };
		}
		if (command.sessionHandle) {
			const handle = this.#sessions.validate(command.sessionHandle);
			if (!handle.ok) return handle;
		}
		const sessionId = commandSessionId(command);
		if (!sessionId) return controlPlaneFailure("invalid_request", "mutation has no session correlation");
		const actual = await this.#states.inspect(sessionId);
		if (!actual.ok) return actual;
		if (
			!actual.value.revision ||
			!command.expectedSessionRevision ||
			!sameRuntimeEventStream(actual.value.revision.stream, command.expectedSessionRevision.stream) ||
			actual.value.revision.sequence !== command.expectedSessionRevision.sequence ||
			actual.value.revision.eventHash !== command.expectedSessionRevision.eventHash
		) {
			return controlPlaneFailure("expected_revision_conflict", "expected session revision is stale", true, {
				actualSequence: actual.value.revision?.sequence ?? -1,
			});
		}
		if (actual.value.activeTurnId !== command.expectedTurnId) {
			return controlPlaneFailure("expected_turn_conflict", "expected active turn is stale", true, {
				actualTurnId: actual.value.activeTurnId ?? "none",
			});
		}
		return { ok: true, value: undefined };
	}
}

class DaemonMutationExecutor implements MutationExecutorPort {
	readonly #sessions: SessionRuntimeRegistry;
	readonly #delegate: MutationExecutorPort;
	readonly #shutdown: ShutdownCoordinator;
	readonly #clock: () => Date;
	readonly #shutdownProtocol: DaemonShutdownProtocolPort | undefined;
	readonly #runtimeGeneration: (command: ControlPlaneCommand) => number;

	public constructor(
		sessions: SessionRuntimeRegistry,
		delegate: MutationExecutorPort,
		shutdown: ShutdownCoordinator,
		clock: () => Date,
		shutdownProtocol: DaemonShutdownProtocolPort | undefined,
		runtimeGeneration: (command: ControlPlaneCommand) => number,
	) {
		this.#sessions = sessions;
		this.#delegate = delegate;
		this.#shutdown = shutdown;
		this.#clock = clock;
		this.#shutdownProtocol = shutdownProtocol;
		this.#runtimeGeneration = runtimeGeneration;
	}

	public async execute(
		command: ControlPlaneCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandEffect>> {
		switch (command.type) {
			case "session:start": {
				const result = await this.#sessions.start();
				return result.ok ? { ok: true, value: { type: "session:start", bootstrap: result.value } } : result;
			}
			case "session:resume": {
				const result = await this.#sessions.resume(command.payload.sessionId);
				return result.ok ? { ok: true, value: { type: "session:resume", bootstrap: result.value } } : result;
			}
			case "session:fork": {
				const result = await this.#sessions.fork(
					command.payload.parentSessionId,
					command.payload.parentCursor,
					command.payload.goalMode,
				);
				return result.ok ? { ok: true, value: { type: "session:fork", bootstrap: result.value } } : result;
			}
			case "shutdown": {
				if (this.#shutdownProtocol) {
					return this.#shutdownProtocol.request(command, context, this.#runtimeGeneration(command));
				}
				const acceptedAt = this.#clock();
				void this.#shutdown.begin(command.payload.drainTimeoutMs);
				return {
					ok: true,
					value: {
						type: "shutdown",
						acceptedAt: acceptedAt.toISOString(),
						drainDeadline: new Date(acceptedAt.getTime() + command.payload.drainTimeoutMs).toISOString(),
					},
				};
			}
			default:
				return this.#delegate.execute(command, context);
		}
	}
}

class DaemonQueryExecutor implements QueryExecutorPort {
	readonly #delegate: QueryExecutorPort;
	readonly #sessions: SessionRuntimeRegistry;
	readonly #queues: QueueControlPlanePort | undefined;
	readonly #changeProposals: ChangeProposalControlPlanePort | undefined;

	public constructor(
		delegate: QueryExecutorPort,
		sessions: SessionRuntimeRegistry,
		queues?: QueueControlPlanePort,
		changeProposals?: ChangeProposalControlPlanePort,
	) {
		this.#delegate = delegate;
		this.#sessions = sessions;
		this.#queues = queues;
		this.#changeProposals = changeProposals;
	}

	public execute(
		query: ControlPlaneQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneQueryValue>> {
		if (query.type === "session:inspect") {
			const failed = this.#sessions.replacementFailure();
			const candidateView = failed?.candidateSessionId === query.payload.sessionId;
			const previousView = failed?.previousSessionId === query.payload.sessionId;
			if (failed && (candidateView || previousView)) {
				const lifecycle = candidateView || failed.phase === "create_failed" ? "paused" : "stopped";
				const revision = candidateView ? failed.candidateHead : failed.previousHead;
				const view = {
					...failed,
					sessionId: query.payload.sessionId,
					lifecycle,
					revision,
				};
				return Promise.resolve({
					ok: true,
					value: {
						type: "session:inspect",
						sessionId: query.payload.sessionId,
						lifecycle,
						revision,
						activeTurnId: null,
						projectionDigest: canonicalDigest(view),
						replacementFailure: {
							phase: failed.phase,
							attemptedRecovery: failed.attemptedRecovery,
							errorCode: failed.errorCode,
							errorDigest: failed.errorDigest,
							recordedAt: failed.recordedAt,
						},
					},
				});
			}
		}
		if (query.type === "queue:list") {
			return this.#queues
				? this.#queues.list(query, context)
				: Promise.resolve(controlPlaneFailure("unsupported_feature", "durable queue control is not wired"));
		}
		if (query.type === "changeProposal:inspect") {
			return this.#changeProposals
				? this.#changeProposals.inspect(query, context)
				: Promise.resolve(controlPlaneFailure("unsupported_feature", "ChangeProposal repository is not wired"));
		}
		return this.#delegate.execute(query, context);
	}
}

interface HeadlessDaemonCompositionPorts {
	authorityId: AuthorityId;
	tenantId: TenantId;
	serverInstanceId: RuntimeInstanceId;
	peerIdentity: LocalPeerIdentityResolverPort;
	sessionFactory: SessionRuntimeFactoryPort;
	sessionState: SessionControlStatePort;
	mutationExecutor: MutationExecutorPort;
	prompts: PromptEnqueuePort;
	approvals: ApprovalResolutionCoordinatorPort;
	queues?: QueueControlPlanePort;
	changeProposals?: ChangeProposalControlPlanePort;
	humanGates?: HumanGateControlPlanePort;
	queryExecutor: QueryExecutorPort;
	eventSource: EventSubscriptionSourcePort;
	subscriptionLifecycle?: SessionSubscriptionLifecyclePort;
	multiAgent?: MultiAgentControlPlanePort;
	idempotency?: CommandIdempotencyRepository;
	/** production authority projection 提供；fixture 缺省时沿用 command bus 的兼容推导。 */
	runtimeGeneration?: (command: ControlPlaneCommand) => number;
	shutdown?: ShutdownCoordinator;
	shutdownProtocol?: DaemonShutdownProtocolPort;
	clock?: () => Date;
}

export interface HeadlessDaemonCompositionOptions extends HeadlessDaemonCompositionPorts {
	multiAgent?: SupervisorMultiAgentControlPlaneAdapter;
	phase11Effects?: Phase11ProductionEffectBinding;
	compositionReceipt: ProductionCompositionReceipt;
	/** Production replacement 必须先提交 canonical generation/fencing transition。 */
	runtimeGenerationTransition: RuntimeGenerationTransitionPort;
}

export interface Phase11ProductionEffectBinding {
	matchesProductionBinding(options: {
		idempotency: CommandIdempotencyRepository;
		mutationGate: ShutdownCoordinator;
		runtimeGeneration: (command: ControlPlaneCommand) => number;
		expectedRuntimeGeneration: number;
		changeProposals: ChangeProposalControlPlanePort;
		humanGates?: HumanGateControlPlanePort;
	}): boolean;
}

export function validatePhase11ProductionEffectBinding(options: {
	features: readonly ControlPlaneFeature[];
	idempotency?: CommandIdempotencyRepository;
	mutationGate?: ShutdownCoordinator;
	runtimeGeneration?: (command: ControlPlaneCommand) => number;
	expectedRuntimeGeneration: number;
	changeProposals?: ChangeProposalControlPlanePort;
	humanGates?: HumanGateControlPlanePort;
	binding?: Phase11ProductionEffectBinding;
}): ControlPlaneResult<void> {
	const proposalAdvertised = options.features.includes("change_proposal");
	const humanGateAdvertised = options.features.includes("human_gate");
	if (!proposalAdvertised && !humanGateAdvertised) return { ok: true, value: undefined };
	if (!options.changeProposals || (humanGateAdvertised && !options.humanGates)) {
		return controlPlaneFailure(
			"adapter_contract_violation",
			"production ChangeProposal/HumanGate advertisement requires the matching Runtime service",
		);
	}
	if (!options.idempotency || !options.mutationGate || !options.runtimeGeneration || !options.binding) {
		return controlPlaneFailure(
			"adapter_contract_violation",
			"production Phase 11 effects require the daemon command journal, generation, and shutdown gate",
		);
	}
	return options.binding.matchesProductionBinding({
		idempotency: options.idempotency,
		mutationGate: options.mutationGate,
		runtimeGeneration: options.runtimeGeneration,
		expectedRuntimeGeneration: options.expectedRuntimeGeneration,
		changeProposals: options.changeProposals,
		...(options.humanGates ? { humanGates: options.humanGates } : {}),
	})
		? { ok: true, value: undefined }
		: controlPlaneFailure(
			"adapter_contract_violation",
			"production Phase 11 effects do not share the daemon authority binding",
		);
}

/** 仅供 isolated unit/transport fixture；production 入口不接受 caller-supplied features。 */
export interface TestHeadlessDaemonCompositionOptions extends HeadlessDaemonCompositionPorts {
	testOnly: true;
	features: readonly ControlPlaneFeature[];
}

export interface HeadlessDaemonComposition {
	server: HeadlessDaemonServer;
	sessions: SessionRuntimeRegistry;
	commands: ControlPlaneCommandBus;
	queries: ControlPlaneQueryService;
	subscriptions: EventSubscriptionService;
	shutdown: ShutdownCoordinator;
	idempotency: CommandIdempotencyRepository;
	environment: "production" | "test";
	features: readonly ControlPlaneFeature[];
	compositionReceipt?: ProductionCompositionReceipt;
}

function createComposition(
	options: HeadlessDaemonCompositionPorts,
	access: HeadlessDaemonServerAccess,
	compositionReceipt?: ProductionCompositionReceipt,
	runtimeGenerationTransition?: RuntimeGenerationTransitionPort,
): HeadlessDaemonComposition {
	const clock = options.clock ?? (() => new Date());
	const sessions = new SessionRuntimeRegistry(options.sessionFactory, {
		clock,
		...(runtimeGenerationTransition ? { transition: runtimeGenerationTransition } : {}),
		requireDurableTransition: access.environment === "production",
	});
	const shutdown = options.shutdown ?? new ShutdownCoordinator(clock);
	const runtimeGeneration = options.runtimeGeneration ?? ((command: ControlPlaneCommand) => command.sessionHandle?.generation ?? 1);
	const idempotency = options.idempotency ?? new InMemoryCommandIdempotencyRepository(clock);
	const handles: SessionHandleValidationPort = {
		validate: (handle) => {
			const result = sessions.validate(handle);
			return result.ok ? { ok: true, value: undefined } : result;
		},
	};
	const registered = shutdown.register({
		id: "active-session-runtime",
		kind: "handler",
		drain: async () => {
			const result = await sessions.shutdown();
			if (!result.ok) throw new Error(result.error.code);
		},
	});
	if (!registered.ok) throw new Error("shutdown coordinator was already closed during composition");
	const commands = new ControlPlaneCommandBus({
		idempotency,
		stateGuard: new DaemonMutationStateGuard(sessions, options.sessionState),
		executor: new DaemonMutationExecutor(
			sessions,
			options.mutationExecutor,
			shutdown,
			clock,
			options.shutdownProtocol,
			runtimeGeneration,
		),
		prompts: options.prompts,
		approvals: options.approvals,
		...(options.queues ? { queues: options.queues } : {}),
		...(options.changeProposals ? { changeProposals: options.changeProposals } : {}),
		...(options.humanGates ? { humanGates: options.humanGates } : {}),
		shutdown,
		runtimeGeneration,
		...(options.shutdownProtocol ? {
			afterCommit: (command: ControlPlaneCommand, effect: ControlPlaneCommandEffect, receipt: CommittedCommandReceipt) => {
				if (command.type === "shutdown" && effect.type === "shutdown") {
					options.shutdownProtocol?.committed(command, effect, receipt);
				}
			},
		} : {}),
	});
	const queries = new ControlPlaneQueryService({
		executor: new DaemonQueryExecutor(options.queryExecutor, sessions, options.queues, options.changeProposals),
		handles,
	});
	const subscriptions = new EventSubscriptionService({ source: options.eventSource, handles });
	const server = new HeadlessDaemonServer({
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		serverInstanceId: options.serverInstanceId,
		peerIdentity: options.peerIdentity,
		commands,
		queries,
		subscriptions,
		...(options.multiAgent ? { multiAgent: options.multiAgent } : {}),
		...(options.subscriptionLifecycle ? { subscriptionLifecycle: options.subscriptionLifecycle } : {}),
		access,
	});
	return {
		server,
		sessions,
		commands,
		queries,
		subscriptions,
		shutdown,
		idempotency,
		environment: access.environment,
		features: Object.freeze([...access.features]),
		...(compositionReceipt ? { compositionReceipt } : {}),
	};
}

export function createHeadlessDaemonComposition(options: HeadlessDaemonCompositionOptions): HeadlessDaemonComposition {
	const validated = validateProductionCompositionReceipt(options.compositionReceipt, {
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		serverInstanceId: options.serverInstanceId,
	});
	if (!validated.ok) throw new ControlPlaneError(validated.error);
	if (validated.value.features.includes("multi_agent") && !options.multiAgent) {
		throw new ControlPlaneError({
			code: "adapter_contract_violation",
			message: "production multi_agent advertisement requires the Supervisor Control Plane adapter",
			retryable: false,
		});
	}
	if (
		validated.value.features.includes("multi_agent") &&
		(
			!options.idempotency ||
			!options.shutdown ||
			!options.runtimeGeneration ||
			!options.multiAgent?.matchesProductionBinding({
				idempotency: options.idempotency,
				mutationGate: options.shutdown,
				runtimeGeneration: validated.value.receipt.runtimeGeneration,
			})
		)
	) {
		throw new ControlPlaneError({
			code: "adapter_contract_violation",
			message: "production multi_agent must share the daemon command journal, generation, and shutdown gate",
			retryable: false,
		});
	}
	const phase11 = validatePhase11ProductionEffectBinding({
		features: validated.value.features,
		idempotency: options.idempotency,
		mutationGate: options.shutdown,
		runtimeGeneration: options.runtimeGeneration,
		expectedRuntimeGeneration: validated.value.receipt.runtimeGeneration,
		changeProposals: options.changeProposals,
		humanGates: options.humanGates,
		binding: options.phase11Effects,
	});
	if (!phase11.ok) throw new ControlPlaneError(phase11.error);
	return createComposition(options, {
		environment: "production",
		features: validated.value.features,
		commandTypes: validated.value.commandTypes,
		queryTypes: validated.value.queryTypes,
		eventSubscription: validated.value.eventSubscription,
		receiptId: validated.value.receipt.receiptId,
	}, validated.value.receipt, options.runtimeGenerationTransition);
}

export function createTestHeadlessDaemonComposition(
	options: TestHeadlessDaemonCompositionOptions,
): HeadlessDaemonComposition {
	if (options.testOnly !== true) throw new TypeError("test daemon composition requires an explicit testOnly boundary");
	const requested = new Set(options.features);
	const features = CONTROL_PLANE_FEATURES.filter((feature) => requested.has(feature));
	return createComposition(options, {
		environment: "test",
		features,
		commandTypes: CONTROL_PLANE_COMMAND_TYPES.filter((type) => features.includes(controlPlaneFeatureForCommand(type))),
		queryTypes: CONTROL_PLANE_QUERY_TYPES.filter((type) => features.includes(controlPlaneFeatureForQuery(type))),
		eventSubscription: features.includes("event_subscription"),
	});
}
