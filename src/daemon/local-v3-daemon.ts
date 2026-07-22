/** 本地 v3 daemon 的 production composition；未接能力一律不宣告且 fail closed。 */

import { join, resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createLocalIdentityContext } from "../runtime/identity/local-principal.ts";
import type { RuntimeIdentityContext } from "../runtime/identity/types.ts";
import type { StartupExternalReceiptAuditPort } from "../runtime/lifecycle/recovery.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../runtime/protocol/v3/ids.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import { AuthorityCommandIdempotencyRepository } from "../runtime/control-plane/authority-command-idempotency.ts";
import type { SessionHandleValidationPort } from "../runtime/control-plane/query-service.ts";
import type { SessionRuntimeRegistry } from "../runtime/control-plane/session-registry.ts";
import { ShutdownCoordinator } from "../runtime/control-plane/shutdown.ts";
import {
	CONTROL_PLANE_PROTOCOL_MAJOR,
	CONTROL_PLANE_PROTOCOL_MINOR,
	type ApprovalResolutionCoordinatorPort,
	type ControlPlaneCommand,
	type ControlPlaneCommandEffect,
	type ControlPlaneFeature,
	type ControlPlaneQuery,
	type ControlPlaneQueryValue,
	type ControlPlaneRequestContext,
	type ControlPlaneTransport,
	type MutationExecutorPort,
	type PromptEnqueuePort,
	type QueryExecutorPort,
} from "../runtime/control-plane/types.ts";
import { validateRuntimeFeatureFlags, type RuntimeFeatureFlags } from "../runtime/runtime-features.ts";
import { getProjectDir, resolveSessionDir } from "../storage/paths.ts";
import { AuthorityRuntimeManager } from "../storage/authority-runtime-manager.ts";
import { createProductionStartupExternalReceiptAuditor } from "../storage/production-startup-receipt-auditor.ts";
import {
	createHeadlessDaemonComposition,
	type HeadlessDaemonComposition,
} from "./composition-root.ts";
import {
	createProductionAdapterEvidence,
	createProductionCompositionReceipt,
	type ProductionAdapterEvidence,
	type ProductionCompositionReceipt,
} from "./production-composition.ts";
import { FileDurableProjectionCheckpointStore } from "./durable-consumer-checkpoint-store.ts";
import { DaemonRecoveryAdapter, type DaemonRecoveryReport, type RestoredDaemonSession } from "./recovery-adapter.ts";
import {
	DirectoryV3SessionLocator,
	V3ArtifactStoreQueryAdapter,
	V3DaemonRuntimeRecoveryPortAdapter,
	V3EventSubscriptionSourceAdapter,
	V3QueueControlAdapter,
	V3QueryExecutorAdapter,
	V3SessionControlStateAdapter,
	V3SessionEvidenceReader,
	V3SessionRuntimeFactoryAdapter,
	type V3ArtifactAuthorizationPort,
	type V3ArtifactQueryPort,
} from "./v3-session-adapters.ts";
import { LocalPeerIdentityResolver } from "../runtime/control-plane/local-peer.ts";
import { AuthorityRuntimeGenerationCoordinator } from "./authority-runtime-generation.ts";
import {
	AuthorityDaemonShutdownProtocol,
	resolveAuthorityShutdownAppliedCursor,
	resolveAuthorityShutdownAppliedEffect,
} from "./authority-shutdown.ts";

export interface StartLocalV3DaemonOptions {
	cwd: string;
	sessionDir?: string;
	features: Readonly<RuntimeFeatureFlags>;
	identity?: RuntimeIdentityContext;
	serverInstanceId?: RuntimeInstanceId;
	authorityStateDirectory?: string;
	shutdown?: ShutdownCoordinator;
	shutdownTimeoutMs?: number;
	startupExternalReceiptAuditor?: StartupExternalReceiptAuditPort;
	/** Production workspace/tool-gateway 共用的 durable state root。 */
	startupExternalReceiptStateRoot?: string;
	startupExternalReceiptAuditTimeoutMs?: number;
	clock?: () => Date;
	/** 此入口当前只实现继承 stdio JSONL；socket/pipe 必须由独立 secure host 提供。 */
	transport?: ControlPlaneTransport;
	production?: LocalV3DaemonProductionPorts;
}

export interface LocalV3DaemonEventDeliveryOptions {
	checkpointDirectory?: string;
}

/**
 * 可选 production ports 必须同时提供对应的已探测 evidence；有 port 无 evidence、或
 * evidence 宣告未接 port 的能力都拒绝启动。默认 CLI 不传此对象，能力保持关闭。
 */
export interface LocalV3DaemonProductionPorts {
	mutationExecutor?: MutationExecutorPort;
	prompts?: PromptEnqueuePort;
	approvals?: ApprovalResolutionCoordinatorPort;
	artifactAuthorization?: V3ArtifactAuthorizationPort;
	eventDelivery?: LocalV3DaemonEventDeliveryOptions;
	adapterEvidence?: readonly ProductionAdapterEvidence[];
}

export type DaemonConsumerProjection = Readonly<Record<string, unknown>>;

export interface StartedLocalV3Daemon {
	composition: HeadlessDaemonComposition;
	recovery: DaemonRecoveryReport;
	identity: RuntimeIdentityContext;
	features: readonly ControlPlaneFeature[];
	compositionReceipt: ProductionCompositionReceipt;
	authorityRuntime: AuthorityRuntimeManager;
	consumerCheckpoints?: FileDurableProjectionCheckpointStore<DaemonConsumerProjection>;
}

function compositionAdapterExpiresAt(issuedAt: string): string {
	return new Date(Date.parse(issuedAt) + 10 * 60 * 1_000).toISOString();
}

function compositionReceiptExpiresAt(issuedAt: string): string {
	return new Date(Date.parse(issuedAt) + 5 * 60 * 1_000).toISOString();
}

function compositionAdapterTrust(kind: string, issuedAt: string, evidence: unknown) {
	return {
		status: "trusted" as const,
		issuerId: "runledger.local-daemon.trust",
		issuedAt,
		expiresAt: compositionAdapterExpiresAt(issuedAt),
		evidenceDigest: canonicalDigest({ kind, evidence }),
	};
}

function unavailable<T>(capability: string): ControlPlaneResult<T> {
	return controlPlaneFailure("unsupported_feature", `${capability} is not wired in the local stdio daemon`);
}

class LocalV3SessionMutationExecutor implements MutationExecutorPort {
	readonly #sessions: V3SessionRuntimeFactoryAdapter;
	readonly #delegate: MutationExecutorPort | undefined;

	public constructor(sessions: V3SessionRuntimeFactoryAdapter, delegate?: MutationExecutorPort) {
		this.#sessions = sessions;
		this.#delegate = delegate;
	}

	public async execute(
		command: ControlPlaneCommand,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandEffect>> {
		if (command.type !== "session:stop") {
			return this.#delegate ? this.#delegate.execute(command, _context) : unavailable(command.type);
		}
		const runtime = this.#sessions.activeRuntime(command.payload.sessionId);
		if (!runtime || runtime.isClosed()) {
			return controlPlaneFailure("stale_session_handle", "session runtime is not active");
		}
		try {
			await runtime.manager().requestStop(`control-plane:${command.payload.reasonDigest}`);
			const terminalCursor = runtime.head();
			if (!terminalCursor) {
				return controlPlaneFailure("recovery_required", "session stop completed without a durable terminal cursor", false, undefined, "uncertain");
			}
			return {
				ok: true,
				value: { type: "session:stop", sessionId: command.payload.sessionId, terminalCursor },
			};
		} catch (error) {
			return controlPlaneFailure(
				"recovery_required",
				"session stop did not reach a confirmed durable terminal state",
				false,
				{ errorName: error instanceof Error ? error.name : "UnknownError" },
				"uncertain",
			);
		}
	}
}

class LocalOperationalQueryExecutor implements QueryExecutorPort {
	readonly #shutdown: ShutdownCoordinator;
	readonly #clock: () => Date;
	readonly #startedAt: number;
	#degraded = false;

	public constructor(shutdown: ShutdownCoordinator, clock: () => Date) {
		this.#shutdown = shutdown;
		this.#clock = clock;
		this.#startedAt = clock().getTime();
	}

	public observeRecovery(report: DaemonRecoveryReport): void {
		this.#degraded = report.paused.length > 0 || report.corrupted.length > 0 || report.inFlightCommands.length > 0;
	}

	public execute(
		query: ControlPlaneQuery,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneQueryValue>> {
		const shuttingDown = this.#shutdown.state() !== "open";
		if (query.type === "activity:get") {
			if (query.payload.sessionId !== null || query.payload.sessionHandle !== null) {
				return Promise.resolve(controlPlaneFailure(
					"adapter_contract_violation",
					"session activity must be projected by the v3 Event Store adapter",
				));
			}
			return Promise.resolve({
				ok: true,
				value: {
					type: "activity:get",
					state: shuttingDown ? "draining" : "idle",
					sessionId: null,
					activeTurnId: null,
					updatedAt: this.#clock().toISOString(),
					snapshot: null,
				},
			});
		}
		if (query.type !== "health") return Promise.resolve(unavailable(query.type));
		return Promise.resolve({
			ok: true,
			value: {
				type: "health",
				status: shuttingDown ? "draining" : this.#degraded ? "degraded" : "ok",
				protocolMajor: CONTROL_PLANE_PROTOCOL_MAJOR,
				protocolMinor: CONTROL_PLANE_PROTOCOL_MINOR,
				uptimeMs: Math.max(0, this.#clock().getTime() - this.#startedAt),
				shuttingDown,
			},
		});
	}
}

class LateBoundSessionHandles implements SessionHandleValidationPort {
	#sessions: SessionRuntimeRegistry | undefined;

	public bind(sessions: SessionRuntimeRegistry): void {
		if (this.#sessions) throw new Error("session handles are already bound");
		this.#sessions = sessions;
	}

	public validate(handle: Parameters<SessionHandleValidationPort["validate"]>[0]): ReturnType<SessionHandleValidationPort["validate"]> {
		if (!this.#sessions) return controlPlaneFailure("adapter_unavailable", "session handle registry is not bound");
		const validated = this.#sessions.validate(handle);
		return validated.ok ? { ok: true, value: undefined } : validated;
	}
}

class LateBoundRecoveryActivation {
	#sessions: SessionRuntimeRegistry | undefined;
	readonly #states: V3SessionControlStateAdapter;
	#activatedSessionId: SessionId | undefined;

	public constructor(states: V3SessionControlStateAdapter) {
		this.#states = states;
	}

	public bind(sessions: SessionRuntimeRegistry): void {
		if (this.#sessions) throw new Error("recovery activation is already bound");
		this.#sessions = sessions;
	}

	public async activate(restored: RestoredDaemonSession): Promise<ControlPlaneResult<void>> {
		if (!this.#sessions) return controlPlaneFailure("adapter_unavailable", "recovery activation registry is not bound");
		if (this.#activatedSessionId && this.#activatedSessionId !== restored.sessionId) {
			return controlPlaneFailure("recovery_required", "multiple active recovery candidates require explicit operator selection");
		}
		const resumed = await this.#sessions.resume(restored.sessionId);
		if (!resumed.ok) return resumed;
		const inspected = await this.#states.inspectForQuery(restored.sessionId);
		if (!inspected.ok || inspected.value.projectionDigest !== restored.projectionDigest) {
			await this.#sessions.shutdown();
			return controlPlaneFailure("recovery_required", "activated session projection does not match recovery evidence");
		}
		this.#activatedSessionId = restored.sessionId;
		return { ok: true, value: undefined };
	}
}

const unavailablePrompts: PromptEnqueuePort = {
	preflight: async () => unavailable("turn"),
	enqueueDurable: async () => unavailable("turn"),
};

const unavailableApprovals: ApprovalResolutionCoordinatorPort = {
	resolve: async () => unavailable("approval"),
};

const unavailableArtifacts: V3ArtifactQueryPort = {
	metadata: async () => unavailable("artifact"),
	read: async () => unavailable("artifact"),
};

function validateProductionPortBindings(
	production: LocalV3DaemonProductionPorts | undefined,
): ControlPlaneResult<readonly ProductionAdapterEvidence[]> {
	const evidence = [...(production?.adapterEvidence ?? [])];
	const byKind = new Map(evidence.map((adapter) => [adapter.kind, adapter]));
	if (byKind.size !== evidence.length) {
		return controlPlaneFailure("adapter_contract_violation", "local daemon production evidence contains duplicate adapter kinds");
	}
	for (const reserved of ["daemon_core", "session_reader", "event_delivery", "activity"] as const) {
		if (byKind.has(reserved)) {
			return controlPlaneFailure("adapter_contract_violation", `local daemon owns ${reserved} evidence`);
		}
	}
	for (const unsupported of ["change_proposal", "human_gate"] as const) {
		if (byKind.has(unsupported)) {
			return controlPlaneFailure("adapter_contract_violation", `${unsupported} has no local daemon production port binding`);
		}
	}

	const writer = byKind.get("session_writer");
	const hasPromptRuntime = Boolean(production?.prompts || production?.mutationExecutor);
	if (Boolean(production?.prompts) !== Boolean(production?.mutationExecutor)) {
		return controlPlaneFailure("adapter_contract_violation", "turn runtime requires both prompt and mutation ports");
	}
	if (hasPromptRuntime && (!writer?.features.includes("turn") || !writer.features.includes("session"))) {
		return controlPlaneFailure("adapter_contract_violation", "turn runtime lacks session_writer production evidence");
	}
	if (writer?.features.includes("turn") && !hasPromptRuntime) {
		return controlPlaneFailure("adapter_contract_violation", "session_writer advertises turn without a bound prompt runtime");
	}

	const approval = byKind.get("approval");
	if (production?.approvals && !approval?.features.includes("approval")) {
		return controlPlaneFailure("adapter_contract_violation", "ApprovalCoordinator lacks production evidence");
	}
	if (approval?.features.includes("approval") && !production?.approvals) {
		return controlPlaneFailure("adapter_contract_violation", "approval evidence has no bound ApprovalCoordinator");
	}

	const artifact = byKind.get("artifact");
	if (production?.artifactAuthorization && !artifact?.features.includes("artifact")) {
		return controlPlaneFailure("adapter_contract_violation", "artifact authorization lacks production evidence");
	}
	if (artifact?.features.includes("artifact") && !production?.artifactAuthorization) {
		return controlPlaneFailure("adapter_contract_violation", "artifact evidence has no bound authorization port");
	}
	return { ok: true, value: evidence };
}

export async function startLocalV3Daemon(
	options: StartLocalV3DaemonOptions,
): Promise<ControlPlaneResult<StartedLocalV3Daemon>> {
	if ((options.transport ?? "jsonl") !== "jsonl") {
		return controlPlaneFailure(
			"unsupported_feature",
			"local v3 daemon implements inherited stdio JSONL only; local socket, named pipe, SSE, and remote listeners are disabled",
		);
	}
	if (!options.features.daemon) {
		return controlPlaneFailure("unsupported_feature", "local daemon requires the daemon rollout feature");
	}
	const featureErrors = validateRuntimeFeatureFlags(options.features);
	if (featureErrors.length > 0) {
		return controlPlaneFailure("invalid_request", "runtime feature dependencies are invalid", false, {
			firstError: featureErrors[0] ?? "unknown dependency error",
		});
	}
	if (
		options.startupExternalReceiptAuditor !== undefined &&
		options.startupExternalReceiptStateRoot !== undefined
	) {
		return controlPlaneFailure(
			"invalid_request",
			"raw startup external receipt auditor cannot be combined with a durable state root",
		);
	}
	const productionEvidence = validateProductionPortBindings(options.production);
	if (!productionEvidence.ok) return productionEvidence;

	const cwd = resolve(options.cwd);
	const sessionDir = resolve(options.sessionDir ?? resolveSessionDir(cwd));
	const clock = options.clock ?? (() => new Date());
	const identity = options.identity ?? createLocalIdentityContext(clock());
	const shutdown = options.shutdown ?? new ShutdownCoordinator(clock);
	const serverInstanceId = options.serverInstanceId ?? createRuntimeId("runtime");
	let startupExternalReceiptAuditor = options.startupExternalReceiptAuditor;
	if (!startupExternalReceiptAuditor && options.startupExternalReceiptStateRoot !== undefined) {
		try {
			startupExternalReceiptAuditor = await createProductionStartupExternalReceiptAuditor({
				stateRoot: options.startupExternalReceiptStateRoot,
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				clock,
			});
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "startup external receipt stores are unavailable", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}
	let consumerCheckpoints: FileDurableProjectionCheckpointStore<DaemonConsumerProjection> | undefined;
	let eventDeliveryEvidence: ProductionAdapterEvidence | undefined;
	if (options.production?.eventDelivery) {
		const checkpointDirectory = resolve(
			options.production.eventDelivery.checkpointDirectory ?? join(getProjectDir(cwd), "daemon", "consumer-checkpoints"),
		);
		const opened = await FileDurableProjectionCheckpointStore.open<DaemonConsumerProjection>({
			rootDirectory: checkpointDirectory,
			initial: () => ({}),
		});
		if (!opened.ok) return opened;
		consumerCheckpoints = opened.value;
		const checkedAt = clock().toISOString();
		const probeSessionId = createRuntimeId("session", "event-delivery-probe");
		const probe = await consumerCheckpoints.load("runledger.event-delivery-probe", probeSessionId);
		if (!probe.ok) return probe;
			eventDeliveryEvidence = createProductionAdapterEvidence({
			kind: "event_delivery",
			adapterId: "runledger.local.event-delivery",
			implementationId: "src/daemon/stdio-host.ts#event-delivery-pump",
			implementationDigest: canonicalDigest({
				modules: ["stdio-host", "v3-event-source", "durable-consumer-checkpoint-store"],
					contractVersion: 1,
			}),
			configDigest: canonicalDigest({ checkpointDirectory, transport: "jsonl", delivery: "at_least_once" }),
			generation: 1,
			health: "healthy",
			features: ["event_subscription", "consumer_checkpoint"],
			probe: {
				status: "passed",
				checkedAt,
				expiresAt: compositionAdapterExpiresAt(checkedAt),
				evidenceDigest: canonicalDigest({
					checkpointRevision: probe.value.revision,
					checkpointDigest: probe.value.projectionDigest,
					stdioPump: "available",
				}),
			},
			trust: compositionAdapterTrust("event_delivery", checkedAt, {
				checkpointDirectory,
				transport: "jsonl",
			}),
		});
	}

	let authorityRuntime: AuthorityRuntimeManager | undefined;
	try {
		authorityRuntime = await AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: serverInstanceId,
			...(options.authorityStateDirectory ? { stateDirectory: options.authorityStateDirectory } : {}),
			clock,
		});
		const idempotency = new AuthorityCommandIdempotencyRepository(
			authorityRuntime.authorityRepository(),
			{
				clock,
				resolveAppliedCursor: resolveAuthorityShutdownAppliedCursor,
				resolveAppliedEffect: resolveAuthorityShutdownAppliedEffect,
			},
		);
		const runtimeGeneration = await AuthorityRuntimeGenerationCoordinator.open(authorityRuntime, clock);
		if (!runtimeGeneration.ok) {
			await authorityRuntime.close().catch(() => undefined);
			return runtimeGeneration;
		}
		const shutdownProtocol = AuthorityDaemonShutdownProtocol.open(authorityRuntime, shutdown, clock);
		if (!shutdownProtocol.ok) {
			await authorityRuntime.close().catch(() => undefined);
			return shutdownProtocol;
		}
		const locator = new DirectoryV3SessionLocator({ cwd, sessionDir });
		const sessionProbeCheckedAt = clock().toISOString();
		const sessionProbe = await locator.list();
		const sessionFactory = new V3SessionRuntimeFactoryAdapter({
			cwd,
			sessionDir,
			features: options.features,
			identity,
			locator,
			candidateAuthority: runtimeGeneration.value,
			...(startupExternalReceiptAuditor === undefined
				? {}
				: { externalReceiptAuditor: startupExternalReceiptAuditor }),
			...(options.startupExternalReceiptAuditTimeoutMs === undefined
				? {}
				: { externalReceiptAuditTimeoutMs: options.startupExternalReceiptAuditTimeoutMs }),
		});
		const evidence = new V3SessionEvidenceReader({ locator, identity });
		const states = new V3SessionControlStateAdapter({ sessions: sessionFactory, evidence });
		const queues = new V3QueueControlAdapter(sessionFactory);
		const handles = new LateBoundSessionHandles();
		const operationalQueries = new LocalOperationalQueryExecutor(shutdown, clock);
		const artifacts: V3ArtifactQueryPort = options.production?.artifactAuthorization
			? new V3ArtifactStoreQueryAdapter(options.production.artifactAuthorization)
			: unavailableArtifacts;
		const queryExecutor = new V3QueryExecutorAdapter({
			sessions: sessionFactory,
			inspections: states,
			handles,
			artifacts,
			operationalQueries,
		});
		const issuedAt = clock().toISOString();
		const expiresAt = compositionReceiptExpiresAt(issuedAt);
		const daemonEvidence = createProductionAdapterEvidence({
			kind: "daemon_core",
			adapterId: "runledger.local.daemon-core",
			implementationId: "src/daemon/local-v3-daemon.ts#startLocalV3Daemon",
			implementationDigest: canonicalDigest({ module: "local-v3-daemon", contractVersion: 1 }),
			configDigest: canonicalDigest({
				transport: "jsonl",
				remoteAccess: "disabled",
				runtimeFeatures: options.features,
			}),
			generation: 1,
			health: "healthy",
			features: ["health", "shutdown"],
			probe: {
				status: "passed",
				checkedAt: issuedAt,
				expiresAt: compositionAdapterExpiresAt(issuedAt),
				evidenceDigest: canonicalDigest({
					featureValidation: "passed",
					shutdownState: shutdown.state(),
				}),
			},
			trust: compositionAdapterTrust("daemon_core", issuedAt, options.features),
		});
		const eventStoreEvidence = createProductionAdapterEvidence({
			kind: "event_store",
			adapterId: "runledger.local.v3-event-store",
			implementationId: "src/runtime/session/jsonl-event-store.ts#JsonlV3EventStore",
			implementationDigest: canonicalDigest({ module: "jsonl-event-store", contractVersion: 1 }),
			configDigest: canonicalDigest({ sessionDir, authorityId: identity.authorityId, tenantId: identity.tenantId }),
			generation: 1,
			health: sessionProbe.ok ? "healthy" : "unavailable",
			features: ["session", "queue", "event_subscription", "activity"],
			probe: {
				status: sessionProbe.ok ? "passed" : "failed",
				checkedAt: sessionProbeCheckedAt,
				expiresAt: compositionAdapterExpiresAt(sessionProbeCheckedAt),
				evidenceDigest: canonicalDigest(sessionProbe.ok
					? { result: "passed", sessionCount: sessionProbe.value.length }
					: { result: "failed", code: sessionProbe.error.code }),
			},
			trust: compositionAdapterTrust("event_store", sessionProbeCheckedAt, { sessionDir }),
		});
		const readerEvidence = createProductionAdapterEvidence({
			kind: "session_reader",
			adapterId: "runledger.local.v3-session-reader",
			implementationId: "src/daemon/v3-session-adapters.ts#V3SessionEvidenceReader",
			implementationDigest: canonicalDigest({ module: "v3-session-adapters", adapter: "evidence-reader", contractVersion: 1 }),
			configDigest: canonicalDigest({ cwd, sessionDir, authorityId: identity.authorityId, tenantId: identity.tenantId }),
			generation: 1,
			health: sessionProbe.ok ? "healthy" : "unavailable",
			features: ["session"],
			probe: {
				status: sessionProbe.ok ? "passed" : "failed",
				checkedAt: sessionProbeCheckedAt,
				expiresAt: compositionAdapterExpiresAt(sessionProbeCheckedAt),
				evidenceDigest: canonicalDigest(sessionProbe.ok
					? { result: "passed", sessionIds: sessionProbe.value.map((entry) => entry.sessionId).sort() }
					: { result: "failed", code: sessionProbe.error.code }),
			},
			trust: compositionAdapterTrust("session_reader", sessionProbeCheckedAt, { cwd, sessionDir }),
		});
		const activityEvidence = createProductionAdapterEvidence({
			kind: "activity",
			adapterId: "runledger.local.runtime-activity",
			implementationId: "src/runtime/activity/projection.ts#projectRuntimeActivityEvents",
			implementationDigest: canonicalDigest({
				modules: ["runtime/activity/projection", "session/reducer", "session/security-reducer"],
				contractVersion: 2,
			}),
			configDigest: canonicalDigest({
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				sessionDir,
				truthSource: "canonical-v3-event-store",
			}),
			generation: 1,
			health: sessionProbe.ok ? "healthy" : "unavailable",
			features: ["activity"],
			probe: {
				status: sessionProbe.ok ? "passed" : "failed",
				checkedAt: sessionProbeCheckedAt,
				expiresAt: compositionAdapterExpiresAt(sessionProbeCheckedAt),
				evidenceDigest: canonicalDigest(sessionProbe.ok
					? { result: "passed", projectionInput: "strict-event-chain", sessionCount: sessionProbe.value.length }
					: { result: "failed", code: sessionProbe.error.code }),
			},
			trust: compositionAdapterTrust("activity", sessionProbeCheckedAt, {
				projectionInput: "strict-event-chain",
				metadataOnly: true,
			}),
		});
		const localWriterEvidence = createProductionAdapterEvidence({
			kind: "session_writer",
			adapterId: "runledger.local.v3-queue-writer",
			implementationId: "src/daemon/v3-session-adapters.ts#V3QueueControlAdapter",
			implementationDigest: canonicalDigest({ module: "v3-session-adapters", adapter: "queue-control", contractVersion: 1 }),
			configDigest: canonicalDigest({ cwd, sessionDir, authorityId: identity.authorityId, tenantId: identity.tenantId }),
			generation: 1,
			health: sessionProbe.ok ? "healthy" : "unavailable",
			features: ["queue"],
			probe: {
				status: sessionProbe.ok ? "passed" : "failed",
				checkedAt: sessionProbeCheckedAt,
				expiresAt: compositionAdapterExpiresAt(sessionProbeCheckedAt),
				evidenceDigest: canonicalDigest(sessionProbe.ok
					? { result: "passed", queueMutex: "agent-loop-session-events" }
					: { result: "failed", code: sessionProbe.error.code }),
			},
			trust: compositionAdapterTrust("session_writer", sessionProbeCheckedAt, { cwd, sessionDir, queue: true }),
		});
		const externalWriter = productionEvidence.value.find((adapter) => adapter.kind === "session_writer");
		const externalSupporting = productionEvidence.value.filter((adapter) => adapter.kind !== "session_writer");
		const receipt = createProductionCompositionReceipt({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			serverInstanceId,
			issuerId: "runledger.local-v3-daemon",
			runtimeGeneration: 1,
			issuedAt,
			expiresAt,
			adapters: [
				daemonEvidence,
				eventStoreEvidence,
				readerEvidence,
				externalWriter ?? localWriterEvidence,
				...externalSupporting,
				...(eventDeliveryEvidence ? [eventDeliveryEvidence] : []),
				activityEvidence,
			],
		});
		if (!receipt.ok) {
			await shutdown.begin(options.shutdownTimeoutMs ?? 30_000);
			return receipt;
		}
		const boundComposition = runtimeGeneration.value.bindBaseComposition(receipt.value);
		if (!boundComposition.ok) {
			await shutdown.begin(options.shutdownTimeoutMs ?? 30_000);
			return boundComposition;
		}
		const composition = createHeadlessDaemonComposition({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			serverInstanceId,
			peerIdentity: new LocalPeerIdentityResolver(identity.principalId),
			sessionFactory,
			sessionState: states,
			mutationExecutor: new LocalV3SessionMutationExecutor(sessionFactory, options.production?.mutationExecutor),
			prompts: options.production?.prompts ?? unavailablePrompts,
			approvals: options.production?.approvals ?? unavailableApprovals,
			queues,
			queryExecutor,
			eventSource: new V3EventSubscriptionSourceAdapter(sessionFactory),
			idempotency,
			runtimeGenerationTransition: runtimeGeneration.value,
			runtimeGeneration: () => runtimeGeneration.value.currentGeneration(),
			shutdown,
			shutdownProtocol: shutdownProtocol.value,
			compositionReceipt: receipt.value,
			clock,
		});
		handles.bind(composition.sessions);
		const activation = new LateBoundRecoveryActivation(states);
		activation.bind(composition.sessions);
		const recoveryPort = new V3DaemonRuntimeRecoveryPortAdapter({ evidence, activation });
		const recovered = await new DaemonRecoveryAdapter(recoveryPort, idempotency).recover();
		if (!recovered.ok) {
			await composition.shutdown.begin(options.shutdownTimeoutMs ?? 30_000);
			return recovered;
		}
		operationalQueries.observeRecovery(recovered.value);
		return {
			ok: true,
			value: {
				composition,
				recovery: recovered.value,
				identity,
					features: composition.features,
					compositionReceipt: receipt.value,
					authorityRuntime,
				...(consumerCheckpoints ? { consumerCheckpoints } : {}),
			},
		};
	} catch (error) {
		if (authorityRuntime) await shutdown.begin(options.shutdownTimeoutMs ?? 30_000);
		return controlPlaneFailure("adapter_unavailable", "local v3 daemon composition failed", true, {
			errorName: error instanceof Error ? error.name : "UnknownError",
		});
	}
}
