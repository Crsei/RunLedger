/** Headless daemon 的 transport-neutral request server。 */

import { isRuntimeId, type AuthorityId, type CompositionReceiptId, type RuntimeInstanceId, type TenantId } from "../runtime/protocol/v3/ids.ts";
import type { ControlPlaneCommandBus } from "../runtime/control-plane/command-bus.ts";
import type { ControlPlaneFrameDispatcher } from "../runtime/control-plane/jsonl-transport.ts";
import type {
	LocalPeerIdentityResolverPort,
	PeerConnectionEvidence,
} from "../runtime/control-plane/local-peer.ts";
import type { ControlPlaneQueryService } from "../runtime/control-plane/query-service.ts";
import type {
	BoundedEventSubscription,
	EventSubscriptionService,
} from "../runtime/control-plane/subscriptions.ts";
import type {
	SessionSubscriptionLease,
	SessionSubscriptionLifecyclePort,
} from "../runtime/control-plane/session-lifecycle.ts";
import {
	errorResponse,
	requestIdOf,
	type ControlPlaneCommandType,
	type ControlPlaneFeature,
	type ControlPlaneQueryType,
	type ControlPlaneRequest,
	type ControlPlaneRequestContext,
	type ControlPlaneResponse,
	type ControlPlaneServerHello,
	validateControlPlaneRequest,
} from "../runtime/control-plane/types.ts";
import {
	negotiateControlPlaneHandshake,
	type HandshakeServerCapabilities,
} from "../runtime/control-plane/handshake.ts";
import {
	controlPlaneFeatureForCommand,
	controlPlaneFeatureForQuery,
} from "./production-composition.ts";
import {
	isAgentInspectQueryTypeV2,
	isControlPlaneV2AgentCommandType,
	validateAgentInspectQueryV2,
	validateControlPlaneV2AgentCommand,
	type MultiAgentControlPlanePort,
} from "../runtime/control-plane/multi-agent-contracts.ts";

export interface HeadlessDaemonServerAccess {
	environment: "production" | "test";
	features: readonly ControlPlaneFeature[];
	commandTypes: readonly ControlPlaneCommandType[];
	queryTypes: readonly ControlPlaneQueryType[];
	eventSubscription: boolean;
	receiptId?: CompositionReceiptId;
}

export interface HeadlessDaemonServerOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	serverInstanceId: RuntimeInstanceId;
	peerIdentity: LocalPeerIdentityResolverPort;
	commands: ControlPlaneCommandBus;
	queries: ControlPlaneQueryService;
	subscriptions: EventSubscriptionService;
	subscriptionLifecycle?: SessionSubscriptionLifecyclePort;
	maxSubscriptionsPerConnection?: number;
	access: HeadlessDaemonServerAccess;
	multiAgent?: MultiAgentControlPlanePort;
}

interface DaemonSubscription {
	stream: BoundedEventSubscription;
	lease?: SessionSubscriptionLease;
}

interface DaemonConnection {
	evidence: PeerConnectionEvidence;
	context?: ControlPlaneRequestContext;
	subscriptions: Map<string, DaemonSubscription>;
}

export const DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;

function requiredFeature(request: Exclude<ControlPlaneRequest, { kind: "handshake" }>): ControlPlaneFeature {
	if (request.kind === "subscription") return "event_subscription";
	return request.kind === "query"
		? controlPlaneFeatureForQuery(request.type)
		: controlPlaneFeatureForCommand(request.type);
}

export class HeadlessDaemonServer {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #peerIdentity: LocalPeerIdentityResolverPort;
	readonly #commands: ControlPlaneCommandBus;
	readonly #queries: ControlPlaneQueryService;
	readonly #subscriptions: EventSubscriptionService;
	readonly #subscriptionLifecycle: SessionSubscriptionLifecyclePort | undefined;
	readonly #maxSubscriptionsPerConnection: number;
	readonly #handshakeCapabilities: HandshakeServerCapabilities;
	readonly #commandTypes: ReadonlySet<ControlPlaneCommandType>;
	readonly #queryTypes: ReadonlySet<ControlPlaneQueryType>;
	readonly #eventSubscription: boolean;
	readonly #multiAgent: MultiAgentControlPlanePort | undefined;
	readonly #connections = new Map<string, DaemonConnection>();

	public constructor(options: HeadlessDaemonServerOptions) {
		if (options.access.environment === "production" && !isRuntimeId(options.access.receiptId, "compositionReceipt")) {
			throw new TypeError("production daemon server requires a validated composition receipt");
		}
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#peerIdentity = options.peerIdentity;
		this.#commands = options.commands;
		this.#queries = options.queries;
		this.#subscriptions = options.subscriptions;
		this.#subscriptionLifecycle = options.subscriptionLifecycle;
		this.#maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION;
		if (!Number.isInteger(this.#maxSubscriptionsPerConnection) || this.#maxSubscriptionsPerConnection < 1 ||
			this.#maxSubscriptionsPerConnection > 4_096) {
			throw new TypeError("maxSubscriptionsPerConnection must be between 1 and 4096");
		}
		this.#commandTypes = new Set(options.access.commandTypes);
		this.#queryTypes = new Set(options.access.queryTypes);
		this.#eventSubscription = options.access.eventSubscription;
		this.#multiAgent = options.multiAgent;
		this.#handshakeCapabilities = {
			serverInstanceId: options.serverInstanceId,
			features: [...options.access.features],
		};
	}

	public createDispatcher(connectionId: string, evidence: PeerConnectionEvidence): ControlPlaneFrameDispatcher {
		if (!this.#connections.has(connectionId)) {
			this.#connections.set(connectionId, { evidence, subscriptions: new Map() });
		}
		return { dispatch: (frame) => this.dispatch(connectionId, frame) };
	}

	public async dispatch(connectionId: string, frame: unknown): Promise<ControlPlaneResponse> {
		const connection = this.#connections.get(connectionId);
		if (!connection) {
			return errorResponse(requestIdOf(frame), {
				code: "unauthorized_peer",
				message: "Control Plane connection is not registered",
				retryable: false,
			});
		}
		if (
			typeof frame === "object" &&
			frame !== null &&
			"type" in frame &&
			(isControlPlaneV2AgentCommandType(frame.type) ||
				isAgentInspectQueryTypeV2(frame.type))
		) {
			if (!connection.context) {
				return errorResponse(requestIdOf(frame), {
					code: "handshake_required",
					message: "Control Plane handshake must complete before requests",
					retryable: false,
				});
			}
			if (connection.context.handshake.controlPlaneSchemaVersion < 2) {
				return errorResponse(requestIdOf(frame), {
					code: "unsupported_schema",
					message: "multi-agent requests require Control Plane schema v2",
					retryable: false,
				});
			}
			if (!connection.context.handshake.features.includes("multi_agent")) {
				return errorResponse(requestIdOf(frame), {
					code: "unsupported_feature",
					message: "feature multi_agent was not negotiated",
					retryable: false,
				});
			}
			if (!this.#multiAgent) {
				return errorResponse(requestIdOf(frame), {
					code: "unsupported_feature",
					message: "multi-agent Control Plane adapter is unavailable",
					retryable: false,
				});
			}
			if (isControlPlaneV2AgentCommandType(frame.type)) {
				const validatedAgent = validateControlPlaneV2AgentCommand(frame);
				if (!validatedAgent.ok) {
					return errorResponse(requestIdOf(frame), validatedAgent.error);
				}
				if (
					validatedAgent.value.authorityId !== this.#authorityId ||
					validatedAgent.value.tenantId !== this.#tenantId ||
					validatedAgent.value.principalId !== connection.context.peer.principalId
				) {
					return errorResponse(validatedAgent.value.commandId, {
						code: "unauthorized_peer",
						message: "Agent command scope does not match authenticated peer",
						retryable: false,
					});
				}
				const result = await this.#multiAgent.execute(
					validatedAgent.value,
					connection.context,
				);
				return result.ok
					? result.value
					: errorResponse(validatedAgent.value.commandId, result.error);
			}
			const validatedQuery = validateAgentInspectQueryV2(frame);
			if (!validatedQuery.ok) {
				return errorResponse(requestIdOf(frame), validatedQuery.error);
			}
			if (
				validatedQuery.value.authorityId !== this.#authorityId ||
				validatedQuery.value.tenantId !== this.#tenantId ||
				validatedQuery.value.principalId !== connection.context.peer.principalId
			) {
				return errorResponse(validatedQuery.value.queryId, {
					code: "unauthorized_peer",
					message: "Agent query scope does not match authenticated peer",
					retryable: false,
				});
			}
			const result = await this.#multiAgent.inspect(
				validatedQuery.value,
				connection.context,
			);
			return result.ok
				? result.value
				: errorResponse(validatedQuery.value.queryId, result.error);
		}
		const validated = validateControlPlaneRequest(frame);
		if (!validated.ok) return errorResponse(requestIdOf(frame), validated.error);
		const request = validated.value;
		if (request.kind === "handshake") return this.#handshake(connection, request);
		if (!connection.context) {
			return errorResponse(requestIdOf(request), {
				code: "handshake_required",
				message: "Control Plane handshake must complete before requests",
				retryable: false,
			});
		}
		if (
			request.authorityId !== this.#authorityId ||
			request.tenantId !== this.#tenantId ||
			request.principalId !== connection.context.peer.principalId
		) {
			return errorResponse(requestIdOf(request), {
				code: "unauthorized_peer",
				message: "request scope does not match the authenticated local peer",
				retryable: false,
			});
		}
		const feature = requiredFeature(request);
		if (!connection.context.handshake.features.includes(feature)) {
			return errorResponse(requestIdOf(request), {
				code: "unsupported_feature",
				message: `feature ${feature} was not negotiated`,
				retryable: false,
			});
		}
		if (request.kind === "command") {
			if (!this.#commandTypes.has(request.type)) {
				return errorResponse(request.commandId, {
					code: "unsupported_feature",
					message: `command ${request.type} is not authorized by the daemon composition`,
					retryable: false,
				});
			}
			const result = await this.#commands.execute(request, connection.context);
			return result.ok ? result.value : errorResponse(request.commandId, result.error);
		}
		if (request.kind === "query") {
			if (!this.#queryTypes.has(request.type)) {
				return errorResponse(request.queryId, {
					code: "unsupported_feature",
					message: `query ${request.type} is not authorized by the daemon composition`,
					retryable: false,
				});
			}
			const result = await this.#queries.execute(request, connection.context);
			return result.ok ? result.value : errorResponse(request.queryId, result.error);
		}
		if (!this.#eventSubscription) {
			return errorResponse(request.subscriptionId, {
				code: "unsupported_feature",
				message: "event subscription is not authorized by the daemon composition",
				retryable: false,
			});
		}
		const previous = connection.subscriptions.get(request.subscriptionId);
		if (!previous && connection.subscriptions.size >= this.#maxSubscriptionsPerConnection) {
			return errorResponse(request.subscriptionId, {
				code: "overloaded",
				message: "active subscription limit was reached",
				retryable: true,
				details: { maxSubscriptions: this.#maxSubscriptionsPerConnection },
			});
		}
		const lease = this.#subscriptionLifecycle
			? await this.#subscriptionLifecycle.acquireSubscription(request.sessionId)
			: undefined;
		if (lease && !lease.ok) return errorResponse(request.subscriptionId, lease.error);
		const opened = this.#subscriptions.open(request, connection.context);
		if (!opened.ok) {
			if (lease?.ok) await lease.value.release();
			return errorResponse(request.subscriptionId, opened.error);
		}
		if (previous) {
			previous.stream.close();
			await previous.lease?.release();
		}
		connection.subscriptions.set(request.subscriptionId, {
			stream: opened.value,
			...(lease?.ok ? { lease: lease.value } : {}),
		});
		return {
			kind: "subscription_result",
			subscriptionId: request.subscriptionId,
			type: "events:subscribe",
			status: "accepted",
			deliveryGuarantee: "at_least_once",
			fromCursor: request.fromCursor,
		};
	}

	public subscription(connectionId: string, subscriptionId: string): BoundedEventSubscription | undefined {
		return this.#connections.get(connectionId)?.subscriptions.get(subscriptionId)?.stream;
	}

	/** expected 防止旧 delivery pump 的 finally 删除同 id 的新 subscription。 */
	public async releaseSubscription(
		connectionId: string,
		subscriptionId: string,
		expected?: BoundedEventSubscription,
	): Promise<void> {
		const connection = this.#connections.get(connectionId);
		if (!connection) return;
		const subscription = connection.subscriptions.get(subscriptionId);
		if (!subscription || (expected && subscription.stream !== expected)) return;
		connection.subscriptions.delete(subscriptionId);
		subscription.stream.close();
		await subscription.lease?.release();
	}

	public async closeConnection(connectionId: string): Promise<void> {
		const connection = this.#connections.get(connectionId);
		if (!connection) return;
		this.#connections.delete(connectionId);
		const subscriptions = [...connection.subscriptions.values()];
		connection.subscriptions.clear();
		for (const subscription of subscriptions) subscription.stream.close();
		await Promise.allSettled(subscriptions.map((subscription) => subscription.lease?.release()));
	}

	async #handshake(
		connection: DaemonConnection,
		request: Extract<ControlPlaneRequest, { kind: "handshake" }>,
	): Promise<ControlPlaneResponse> {
		if (connection.context) {
			return errorResponse(request.requestId, {
				code: "invalid_request",
				message: "Control Plane handshake has already completed",
				retryable: false,
			});
		}
		if (request.transport !== connection.evidence.transport) {
			return errorResponse(request.requestId, {
				code: "unauthorized_peer",
				message: "handshake transport does not match connection evidence",
				retryable: false,
			});
		}
		const peer = await this.#peerIdentity.resolve(connection.evidence);
		if (!peer.ok) return errorResponse(request.requestId, peer.error);
		const handshake = negotiateControlPlaneHandshake(request, this.#handshakeCapabilities);
		if (!handshake.ok) return errorResponse(request.requestId, handshake.error);
		connection.context = { peer: peer.value, handshake: handshake.value };
		return handshake.value;
	}
}
