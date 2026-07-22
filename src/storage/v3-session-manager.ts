/** Runtime v3 session composition root：event store、writer lease、recovery 与 model-history replay。 */

import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AgentId,
	type GoalId,
	type ReceiptId,
	type RuntimeInstanceId,
	type SessionId,
} from "../runtime/protocol/v3/ids.ts";
import {
	createSessionEventStreamRef,
	type SessionEventStreamRef,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../runtime/protocol/v3/events.ts";
import { validateRuntimeEvent } from "../runtime/protocol/v3/schemas.ts";
import { createLocalIdentityContext } from "../runtime/identity/local-principal.ts";
import type { RuntimeIdentityContext } from "../runtime/identity/types.ts";
import { AgentLoopSessionEvents } from "../runtime/session/agent-loop-events.ts";
import { replayDurableQueue } from "../runtime/session/durable-queue.ts";
import {
	replayConversationEvents,
	replayRuntimeConfigurationEvents,
} from "../runtime/session/conversation-replay.ts";
import { EventWriter, openEventWriter } from "../runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../runtime/session/jsonl-v3-store.ts";
import {
	failLegacyMigrationTarget,
	type FailedLegacyMigrationReceipt,
} from "../runtime/session/legacy-migration.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import { recoverSession, type RecoveryDecision } from "../runtime/session/recovery.ts";
import { reduceSessionEvents } from "../runtime/session/reducer.ts";
import { writeStopTombstone } from "../runtime/session/stop-tombstone.ts";
import {
	FileWriterLeaseStore,
	type WriterLeaseRecord,
	type WriterLeaseScope,
} from "../runtime/session/writer-lease.ts";
import type { RuntimeEventStore } from "../runtime/session/event-store.ts";
import type { SessionResult } from "../runtime/session/types.ts";
import type { AgentMessage } from "../runtime/types.ts";
import type { SessionRuntimeConfig } from "./session-codec.ts";
import type { ToolResultArtifactSink } from "../runtime/types.ts";
import type { RuntimeFeatureFlags } from "../runtime/runtime-features.ts";
import {
	ArtifactCasStore,
	ArtifactRepository,
	type ArtifactReconciliationReport,
} from "../runtime/artifacts/cas-store.ts";
import type { ArtifactResult } from "../runtime/artifacts/types.ts";
import { ArtifactMetadataStore } from "../runtime/artifacts/metadata-store.ts";
import { UnavailableArtifactKeyProvider } from "../runtime/artifacts/key-provider.ts";
import { ArtifactReadLeaseRegistry } from "../runtime/artifacts/access.ts";
import {
	ArtifactRetentionService,
	type ArtifactGcOptions,
	type ArtifactGcReport,
} from "../runtime/artifacts/retention.ts";
import type { ArtifactMetadata } from "../runtime/artifacts/types.ts";
import { SessionArtifactJournal } from "../runtime/artifacts/session-journal.ts";
import { ArtifactToolResultSink } from "../runtime/artifacts/tool-result-sink.ts";
import {
	VerificationSessionRuntime,
	type VerificationSessionRuntimePhase,
} from "../runtime/verification/session-runtime.ts";
import { buildSessionFileName } from "./path-utils.ts";
import { resolveSessionDir } from "./paths.ts";

const LEASE_DURATION_MS = 30_000;

export interface V3SessionCreateOptions {
	cwd: string;
	sessionDir?: string;
	identity?: RuntimeIdentityContext;
	runtimeId?: RuntimeInstanceId;
	sessionId?: SessionId;
	features: Readonly<RuntimeFeatureFlags>;
	/** migration core 需要空 writer，因此禁止自动写 session.created。 */
	writeGenesis?: boolean;
	/** stable fork 在写 genesis 前先固定 lineage；两项必须成对提供。 */
	lineage?: { goalId: GoalId; agentId: AgentId };
}

export interface V3SessionOpenOptions {
	/** governed startup 会先完成 integrity/tombstone/receipt audit，再显式 reconcile。 */
	reconcileArtifacts?: boolean;
	/** production replacement 预先分配的 candidate runtime identity。 */
	runtimeId?: RuntimeInstanceId;
}

export interface V3SessionWriterFenceReceipt {
	authorityId: RuntimeIdentityContext["authorityId"];
	tenantId: RuntimeIdentityContext["tenantId"];
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	stream: RuntimeEventStreamRef;
	leaseId: WriterLeaseRecord["leaseId"];
	writerEpoch: number;
	fencingTokenDigest: string;
	acquiredAt: string;
	expiresAt: string;
	receiptId: ReceiptId;
	receiptDigest: string;
}

interface OpenedV3Runtime {
	filePath: string;
	stateDirectory: string;
	identity: RuntimeIdentityContext;
	runtimeId: RuntimeInstanceId;
	sessionId: SessionId;
	stream: RuntimeEventStreamRef;
	leaseStore: FileWriterLeaseStore;
	fence: WriterLeaseRecord;
	store: JsonlV3EventStore;
	writer: EventWriter;
	sessionEvents: AgentLoopSessionEvents;
	artifactCas: ArtifactCasStore;
	artifactRepository: ArtifactRepository;
	artifactMetadata: ArtifactMetadataStore;
	artifactReadLeases: ArtifactReadLeaseRegistry;
	artifactRetention: ArtifactRetentionService;
	toolResultArtifactSink: ToolResultArtifactSink;
	artifactReconciliation?: ArtifactResult<ArtifactReconciliationReport>;
	recovery?: RecoveryDecision;
}

function resultValue<T>(result: SessionResult<T>, operation: string): T {
	if (!result.ok) throw new Error(`${operation}: ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function stateDirectoryFor(filePath: string): string {
	return `${filePath}.state`;
}

function deterministicLineage(sessionId: SessionId): { goalId: GoalId; agentId: AgentId } {
	return {
		goalId: createRuntimeId("goal", canonicalDigest({ sessionId, kind: "session-root-goal" }).slice(0, 32)),
		agentId: createRuntimeId("agent", canonicalDigest({ sessionId, kind: "session-root-agent" }).slice(0, 32)),
	};
}

/** lineage 只能来自 canonical genesis/projection，open 不再推断或生成缺失身份。 */
function restoreLineage(
	events: readonly RuntimeEventV3[],
): { goalId: GoalId; agentId: AgentId } {
	const projection = resultValue(reduceSessionEvents(events), "v3 session lineage projection failed");
	return { goalId: projection.genesis.initialGoalId, agentId: projection.genesis.rootAgentId };
}

async function readFirstEvent(filePath: string): Promise<RuntimeEventV3 & { stream: SessionEventStreamRef }> {
	const source = await readFile(filePath, "utf8");
	const newline = source.indexOf("\n");
	if (newline < 0) throw new Error("v3 session has no LF-terminated genesis event");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source.slice(0, newline)) as unknown;
	} catch {
		throw new Error("v3 session genesis is malformed JSON");
	}
	const validated = validateRuntimeEvent(parsed);
	if (!validated.ok || validated.value.sequence !== 0 || validated.value.stream.scope !== "session") {
		throw new Error("v3 session genesis is invalid");
	}
	return validated.value as RuntimeEventV3 & { stream: SessionEventStreamRef };
}

function acquireWriterLease(
	leaseStore: FileWriterLeaseStore,
	scope: WriterLeaseScope,
	ownerRuntimeId: RuntimeInstanceId,
): WriterLeaseRecord {
	const acquired = leaseStore.acquire({ ...scope, ownerRuntimeId, durationMs: LEASE_DURATION_MS });
	if (acquired.ok) return acquired.value;
	const inspected = leaseStore.inspect(scope);
	if (!inspected.ok || !inspected.value || Date.now() < Date.parse(inspected.value.expiresAt)) {
		throw new Error(`v3 writer lease unavailable: ${acquired.error.code}: ${acquired.error.message}`);
	}
	return resultValue(
		leaseStore.takeover({
			expectedFence: inspected.value,
			ownerRuntimeId,
			durationMs: LEASE_DURATION_MS,
		}),
		"v3 stale writer takeover failed",
	);
}

async function composeRuntime(options: {
	filePath: string;
	identity: RuntimeIdentityContext;
	runtimeId: RuntimeInstanceId;
	sessionId: SessionId;
	features: Readonly<RuntimeFeatureFlags>;
	create: boolean;
	lineage?: { goalId: GoalId; agentId: AgentId };
}): Promise<OpenedV3Runtime> {
	const stateDirectory = stateDirectoryFor(options.filePath);
	const stream = createSessionEventStreamRef(options.identity, options.sessionId);
	const scope = {
		authorityId: options.identity.authorityId,
		tenantId: options.identity.tenantId,
		stream,
	};
	const leaseStore = new FileWriterLeaseStore(join(stateDirectory, "writer-lease.json"), { scope });
	const fence = acquireWriterLease(leaseStore, scope, options.runtimeId);
	const eventStoreResult = options.create
		? await JsonlV3EventStore.create({
				filePath: options.filePath,
				...scope,
				validateFence: (candidate) => leaseStore.validate(candidate).ok,
			})
		: await JsonlV3EventStore.open({
				filePath: options.filePath,
				...scope,
				validateFence: (candidate) => leaseStore.validate(candidate).ok,
			});
	if (!eventStoreResult.ok) {
		leaseStore.release(fence);
		throw new Error(`v3 event store open failed: ${eventStoreResult.error.code}: ${eventStoreResult.error.message}`);
	}
	const store = eventStoreResult.value;
	const writerResult = options.create
		? { ok: true as const, value: new EventWriter({ ...scope, store, fence }) }
		: await openEventWriter({ ...scope, store, fence });
	if (!writerResult.ok) {
		await store.close();
		leaseStore.release(fence);
		throw new Error(`v3 event writer open failed: ${writerResult.error.code}: ${writerResult.error.message}`);
	}
	const writer = writerResult.value;
	let restoredEvents: readonly RuntimeEventV3[] = [];
	if (!options.create) {
		restoredEvents = resultValue(await readAllRuntimeEvents(store), "v3 session state replay failed");
	}
	const lineage = options.create
		? options.lineage ?? deterministicLineage(options.sessionId)
		: restoreLineage(restoredEvents);
	const restoredQueue = replayDurableQueue(restoredEvents);
	const artifactRoot = join(stateDirectory, "artifacts");
	const artifactCas = new ArtifactCasStore({ rootDir: artifactRoot });
	const artifactMetadata = new ArtifactMetadataStore({ rootDir: artifactRoot });
	const artifactReadLeases = new ArtifactReadLeaseRegistry();
	const artifactJournal = new SessionArtifactJournal({
		writer,
		store,
		principalId: options.identity.principalId,
	});
	const artifactRepository = new ArtifactRepository({
		cas: artifactCas,
		metadata: artifactMetadata,
		journal: artifactJournal,
		keyProvider: new UnavailableArtifactKeyProvider(),
	});
	return {
		filePath: options.filePath,
		stateDirectory,
		identity: options.identity,
		runtimeId: options.runtimeId,
		sessionId: options.sessionId,
		stream,
		leaseStore,
		fence,
		store,
		writer,
		sessionEvents: new AgentLoopSessionEvents({
			writer,
			principalId: options.identity.principalId,
			runtimeId: options.runtimeId,
			goalId: lineage.goalId,
			agentId: lineage.agentId,
			featureDigest: canonicalDigest(options.features),
			restoredQueue,
		}),
		artifactCas,
		artifactRepository,
		artifactMetadata,
		artifactReadLeases,
		artifactRetention: new ArtifactRetentionService({
			cas: artifactCas,
			metadata: artifactMetadata,
			readLeases: artifactReadLeases,
		}),
		toolResultArtifactSink: new ArtifactToolResultSink({
			repository: artifactRepository,
			authorityId: options.identity.authorityId,
			tenantId: options.identity.tenantId,
			principalId: options.identity.principalId,
			sessionId: options.sessionId,
			producerId: options.identity.principalId,
		}),
	};
}

export class V3SessionManager {
	private readonly runtime: OpenedV3Runtime;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private closePromise: Promise<void> | undefined;
	private closed = false;

	private constructor(runtime: OpenedV3Runtime) {
		this.runtime = runtime;
		this.heartbeat = setInterval(() => {
			const renewed = runtime.leaseStore.heartbeat(runtime.fence, LEASE_DURATION_MS);
			if (!renewed.ok && this.heartbeat) {
				clearInterval(this.heartbeat);
				this.heartbeat = undefined;
			}
		}, LEASE_DURATION_MS / 3);
		this.heartbeat.unref();
	}

	public static async create(options: V3SessionCreateOptions): Promise<V3SessionManager> {
		const identity = options.identity ?? createLocalIdentityContext();
		const runtimeId = options.runtimeId ?? createRuntimeId("runtime");
		const sessionId = options.sessionId ?? createRuntimeId("session");
		const sessionDir = options.sessionDir ?? resolveSessionDir(options.cwd);
		if (
			options.lineage &&
			(!isRuntimeId(options.lineage.goalId, "goal") || !isRuntimeId(options.lineage.agentId, "agent"))
		) throw new TypeError("v3 session lineage override is invalid");
		const filePath = join(sessionDir, buildSessionFileName(new Date(), sessionId));
		const runtime = await composeRuntime({
			filePath,
			identity,
			runtimeId,
			sessionId,
			features: options.features,
			create: true,
			...(options.lineage ? { lineage: options.lineage } : {}),
		});
		const manager = new V3SessionManager(runtime);
		if (options.writeGenesis !== false) await runtime.sessionEvents.ensureInitialized();
		return manager;
	}

	public static async open(
		filePath: string,
		features: Readonly<RuntimeFeatureFlags>,
		identity: RuntimeIdentityContext = createLocalIdentityContext(),
		options: V3SessionOpenOptions = {},
	): Promise<V3SessionManager> {
		const absolute = resolve(filePath);
		const first = await readFirstEvent(absolute);
		if (first.authorityId !== identity.authorityId || first.tenantId !== identity.tenantId) {
			throw new Error("v3 session authority or tenant does not match the current runtime identity");
		}
		const runtime = await composeRuntime({
			filePath: absolute,
			identity,
			runtimeId: options.runtimeId ?? createRuntimeId("runtime"),
			sessionId: first.stream.sessionId,
			features,
			create: false,
		});
		const recovery = await recoverSession({
			store: runtime.store,
			sessionDirectory: runtime.stateDirectory,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: first.stream.sessionId,
			snapshotFilePath: join(runtime.stateDirectory, "snapshot.json"),
		});
		runtime.recovery = recovery;
		const migrationInspectOnly =
			(recovery.kind === "pause_for_approval" && recovery.projection.migration?.status === "in_progress") ||
			(recovery.kind === "stopped" && recovery.reason === "migration_failed");
		if (recovery.kind !== "corrupted" && !migrationInspectOnly && options.reconcileArtifacts !== false) {
			runtime.artifactReconciliation = await runtime.artifactRepository.reconcile({
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
			});
		}
		if (
			runtime.artifactReconciliation !== undefined &&
			(recovery.kind === "resume" || recovery.kind === "pause_for_approval") &&
			(!runtime.artifactReconciliation.ok || runtime.artifactReconciliation.value.failed.length > 0)
		) {
			runtime.recovery = {
				kind: "pause_for_approval",
				projection: recovery.projection,
				cursor: recovery.cursor,
				reasons: [...new Set([
					...(recovery.kind === "pause_for_approval" ? recovery.reasons : []),
					"artifact_reconciliation_failed" as const,
				])],
				snapshotSource: recovery.snapshotSource,
			};
		}
		return new V3SessionManager(runtime);
	}

	public sessionId(): SessionId {
		return this.runtime.sessionId;
	}

	public runtimeId(): RuntimeInstanceId {
		return this.runtime.runtimeId;
	}

	/** 不暴露 raw fencing token；receipt 可安全跨越 replacement adapter 边界。 */
	public writerFenceReceipt(): V3SessionWriterFenceReceipt {
		const body = {
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
			sessionId: this.runtime.sessionId,
			runtimeId: this.runtime.runtimeId,
			stream: { ...this.runtime.stream },
			leaseId: this.runtime.fence.leaseId,
			writerEpoch: this.runtime.fence.writerEpoch,
			fencingTokenDigest: this.runtime.fence.fencingTokenDigest,
			acquiredAt: this.runtime.fence.acquiredAt,
			expiresAt: this.runtime.fence.expiresAt,
		};
		const receiptDigest = canonicalDigest(body);
		return {
			...body,
			receiptId: createRuntimeId("receipt", `writer-fence-${receiptDigest.slice(0, 48)}`),
			receiptDigest,
		};
	}

	public filePath(): string {
		return this.runtime.filePath;
	}

	public stateDirectory(): string {
		return this.runtime.stateDirectory;
	}

	public writer(): EventWriter {
		return this.runtime.writer;
	}

	public eventStore(): RuntimeEventStore {
		return this.runtime.store;
	}

	public sessionEvents(): AgentLoopSessionEvents {
		return this.runtime.sessionEvents;
	}

	public toolResultArtifactSink(): ToolResultArtifactSink {
		return this.runtime.toolResultArtifactSink;
	}

	public artifactRepository(): ArtifactRepository {
		return this.runtime.artifactRepository;
	}

	public artifactReconciliation(): ArtifactResult<ArtifactReconciliationReport> | undefined {
		return this.runtime.artifactReconciliation;
	}

	public async reconcileArtifacts(): Promise<ArtifactResult<ArtifactReconciliationReport>> {
		const reconciled = await this.runtime.artifactRepository.reconcile({
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
		});
		this.runtime.artifactReconciliation = reconciled;
		return reconciled;
	}

	public listCommittedArtifacts(): Promise<ArtifactResult<readonly ArtifactMetadata[]>> {
		return this.runtime.artifactMetadata.listCommitted(
			this.runtime.identity.authorityId,
			this.runtime.identity.tenantId,
		);
	}

	public collectArtifactGarbage(options: ArtifactGcOptions): Promise<ArtifactResult<ArtifactGcReport>> {
		return this.runtime.artifactRetention.collect(
			this.runtime.identity.authorityId,
			this.runtime.identity.tenantId,
			options,
		);
	}

	/** Artifact access adapters 必须复用同一个 registry，GC 才能与 active read 互斥。 */
	public artifactReadLeases(): ArtifactReadLeaseRegistry {
		return this.runtime.artifactReadLeases;
	}

	/** Verification 只能复用本 session 的 EventWriter 与 Artifact stores，避免 scope 漂移。 */
	public createVerificationSessionRuntime(options: {
		onPhase?: (phase: VerificationSessionRuntimePhase) => Promise<void> | void;
	} = {}): VerificationSessionRuntime {
		if (this.closed) throw new Error("cannot create verification runtime for a closed v3 session");
		return new VerificationSessionRuntime({
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
			sessionId: this.runtime.sessionId,
			principalId: this.runtime.identity.principalId,
			writer: this.runtime.writer,
			store: this.runtime.store,
			artifacts: this.runtime.artifactRepository,
			metadata: this.runtime.artifactMetadata,
			cas: this.runtime.artifactCas,
			...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
		});
	}

	public isClosed(): boolean {
		return this.closed;
	}

	public identity(): RuntimeIdentityContext {
		return this.runtime.identity;
	}

	public recoveryDecision(): RecoveryDecision | undefined {
		return this.runtime.recovery;
	}

	public async replayMessages(): Promise<readonly AgentMessage[]> {
		const events = resultValue(await readAllRuntimeEvents(this.runtime.store), "v3 event replay failed");
		return resultValue(replayConversationEvents(events), "v3 conversation replay failed");
	}

	public async replayRuntimeConfig(): Promise<Readonly<SessionRuntimeConfig>> {
		const events = resultValue(await readAllRuntimeEvents(this.runtime.store), "v3 event replay failed");
		return resultValue(replayRuntimeConfigurationEvents(events), "v3 runtime config replay failed");
	}

	/** partial legacy migration 的显式 terminal；不会隐式改绑 source/manifest。 */
	public async markLegacyMigrationFailed(reasonCode: string, reason: string): Promise<FailedLegacyMigrationReceipt> {
		const receipt = resultValue(
			await failLegacyMigrationTarget({
				writer: this.runtime.writer,
				eventStore: this.runtime.store,
				principalId: this.runtime.identity.principalId,
				traceId: createRuntimeId("trace"),
				reasonCode,
				reason,
			}),
			"v3 legacy migration failure terminal failed",
		);
		this.runtime.recovery = { kind: "stopped", cursor: receipt.head, reason: "migration_failed" };
		return receipt;
	}

	public async requestStop(reason: string): Promise<void> {
		const head = this.runtime.writer.currentHead();
		if (!head) throw new Error("cannot stop a v3 session before genesis");
		const requested = await this.runtime.writer.append({
			type: "session.stop_requested",
			principalId: this.runtime.identity.principalId,
			traceId: createRuntimeId("trace"),
			payload: {
				reason: reason.slice(0, 512) || "stop requested",
				requestedBy: this.runtime.identity.principalId,
				expectedRevision: {
					stream: head.stream,
					sequence: head.sequence,
					eventHash: head.eventHash,
				},
			},
		});
		if (!requested.ok) throw new Error(`v3 stop request failed: ${requested.error.code}`);
		const tombstone = await writeStopTombstone(this.runtime.stateDirectory, {
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
			sessionId: this.runtime.sessionId,
			requestedBy: this.runtime.identity.principalId,
			stopCursor: {
				stream: requested.value.cursor.stream,
				sequence: requested.value.cursor.sequence,
				eventId: requested.value.cursor.eventId,
				eventHash: requested.value.cursor.eventHash,
			},
			reasonDigest: canonicalDigest(reason),
			writtenAt: new Date().toISOString(),
		});
		if (!tombstone.ok) throw new Error(`v3 stop tombstone failed: ${tombstone.error.code}`);
		const stopped = await this.runtime.writer.append({
			type: "session.stopped",
			principalId: this.runtime.identity.principalId,
			traceId: createRuntimeId("trace"),
			payload: {
				reason: reason.slice(0, 512) || "stop requested",
				tombstoneDigest: tombstone.value.tombstoneDigest,
				lastDurableSequence: requested.value.cursor.sequence,
			},
		});
		if (!stopped.ok) throw new Error(`v3 stop terminal failed: ${stopped.error.code}`);
	}

	public closeAll(): Promise<void> {
		this.closePromise ??= this.closeRuntime();
		return this.closePromise;
	}

	private async closeRuntime(): Promise<void> {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		const closed = await this.runtime.writer.close();
		const released = this.runtime.leaseStore.release(this.runtime.fence);
		if (!closed.ok) throw new Error(`v3 event writer close failed: ${closed.error.code}`);
		if (!released.ok) throw new Error(`v3 writer lease release failed: ${released.error.code}`);
		this.closed = true;
	}

	/** 仅用于失败于首个 event 前的显式迁移 target 回收。 */
	public async discardEmptyTarget(): Promise<void> {
		if (this.runtime.writer.currentHead() !== undefined) {
			throw new Error("cannot discard a v3 target after its first durable event");
		}
		await this.closeAll();
		await rm(this.runtime.filePath, { force: true });
		await rm(this.runtime.stateDirectory, { recursive: true, force: true });
	}
}
