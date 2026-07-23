/** Runtime v3 session composition root：event store、writer lease、recovery 与 model-history replay。 */

import { readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
import {
	readAllRuntimeEvents,
	readSessionSnapshot,
} from "../runtime/session/snapshot.ts";
import {
	registerSessionRestoreDependencies,
	verifySessionRestoreDependencies,
	type SessionRestoreDependencyKind,
	type SessionRestoreDependencyRegistrar,
	type SessionRestoreDependencyRegistry,
} from "../runtime/session/restore-dependencies.ts";
import { recoverSession, type RecoveryDecision } from "../runtime/session/recovery.ts";
import { reduceSessionEvents } from "../runtime/session/reducer.ts";
import { writeStopTombstone } from "../runtime/session/stop-tombstone.ts";
import {
	FileWriterLeaseStore,
	type WriterLeaseRecord,
	type WriterLeaseScope,
} from "../runtime/session/writer-lease.ts";
import type { RuntimeEventStore } from "../runtime/session/event-store.ts";
import type {
	AcceptedEventCursor,
	DurableEventReceipt,
	SessionResult,
} from "../runtime/session/types.ts";
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
	/** 已预分配的 exact target；必须与 resolved sessionDir 和 sessionId 双重绑定。 */
	filePath?: string;
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
	/**
	 * 必须在任何 durable session read/reduce 前完成。
	 * 旧的 dependency-free session 可缺省；dependency-bound snapshot 必须显式提供。
	 */
	registerDependencies?: SessionRestoreDependencyRegistrar;
}

export interface V3SessionRestoreOptions extends V3SessionOpenOptions {
	registerDependencies: SessionRestoreDependencyRegistrar;
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

/** confirmed durable release；不跨边界暴露 raw fencing token。 */
export interface V3SessionWriterLeaseReleasedEvidence {
	readonly authorityId: RuntimeIdentityContext["authorityId"];
	readonly tenantId: RuntimeIdentityContext["tenantId"];
	readonly sessionId: SessionId;
	readonly runtimeInstanceId: RuntimeInstanceId;
	readonly leaseId: WriterLeaseRecord["leaseId"];
	readonly writerEpoch: number;
	readonly fencingTokenDigest: string;
	readonly releasedAt: string;
	readonly evidenceDigest: string;
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
	restoreDependencies: SessionRestoreDependencyRegistry;
}

function resultValue<T>(result: SessionResult<T>, operation: string): T {
	if (!result.ok) throw new Error(`${operation}: ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function stateDirectoryFor(filePath: string): string {
	return `${filePath}.state`;
}

function createFilePath(
	sessionDir: string,
	sessionId: SessionId,
	exactFilePath: string | undefined,
): string {
	if (exactFilePath === undefined) return join(sessionDir, buildSessionFileName(new Date(), sessionId));
	if (!isAbsolute(exactFilePath)) {
		throw new TypeError("v3 exact session filePath must be absolute");
	}
	const resolvedSessionDir = resolve(sessionDir);
	if (dirname(exactFilePath) !== resolvedSessionDir) {
		throw new TypeError("v3 exact session filePath dirname must equal the resolved session directory");
	}
	if (!basename(exactFilePath).endsWith(`_${sessionId}.jsonl`)) {
		throw new TypeError("v3 exact session filePath filename must be bound to sessionId");
	}
	return exactFilePath;
}

function cleanupError(cause: unknown): Error {
	if (cause instanceof Error) return cause;
	return new Error(typeof cause === "string" ? cause : "unknown runtime cleanup failure");
}

function resultError(
	operation: string,
	error: { code: string; message: string },
): Error {
	return new Error(`${operation}: ${error.code}: ${error.message}`);
}

function aggregateCleanupErrors(cause: unknown): readonly unknown[] {
	return cause instanceof AggregateError ? cause.errors : [cause];
}

async function closeWriterAndStore(
	writer: EventWriter | undefined,
	store: JsonlV3EventStore | undefined,
	onWriterSettled?: () => void,
): Promise<Error[]> {
	const errors: Error[] = [];
	let writerThrew = false;
	if (writer) {
		try {
			const closed = await writer.close();
			if (!closed.ok) {
				errors.push(resultError("v3 event writer close failed", closed.error));
			}
		} catch (cause) {
			writerThrew = true;
			errors.push(cleanupError(cause));
		} finally {
			onWriterSettled?.();
		}
	}
	if (!writer) onWriterSettled?.();
	if (store && (!writer || writerThrew)) {
		try {
			const closed = await store.close();
			if (!closed.ok) {
				errors.push(resultError("v3 event store close failed", closed.error));
			}
		} catch (cause) {
			errors.push(cleanupError(cause));
		}
	}
	return errors;
}

function releaseWriterLease(
	leaseStore: FileWriterLeaseStore,
	fence: WriterLeaseRecord,
): { releasedRecord?: WriterLeaseRecord; errors: Error[] } {
	let releaseFailure: Error | undefined;
	try {
		const released = leaseStore.release(fence);
		if (released.ok) return { releasedRecord: released.value, errors: [] };
		releaseFailure = resultError("v3 writer lease release failed", released.error);
	} catch (cause) {
		releaseFailure = cleanupError(cause);
	}
	try {
		const inspected = leaseStore.inspectReleased(fence);
		if (inspected.ok && inspected.value) {
			return { releasedRecord: inspected.value, errors: [] };
		}
		if (!inspected.ok) {
			return {
				errors: [
					releaseFailure,
					resultError("v3 writer lease release inspection failed", inspected.error),
				],
			};
		}
	} catch (cause) {
		return { errors: [releaseFailure, cleanupError(cause)] };
	}
	return { errors: [releaseFailure] };
}

async function cleanupComposedRuntime(
	leaseStore: FileWriterLeaseStore,
	fence: WriterLeaseRecord,
	store: JsonlV3EventStore | undefined,
	writer: EventWriter | undefined,
): Promise<Error[]> {
	const errors = await closeWriterAndStore(writer, store);
	errors.push(...releaseWriterLease(leaseStore, fence).errors);
	return errors;
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
	restoreDependencies?: SessionRestoreDependencyRegistry;
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
	let store: JsonlV3EventStore | undefined;
	let writer: EventWriter | undefined;
	try {
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
			throw resultError("v3 event store open failed", eventStoreResult.error);
		}
		store = eventStoreResult.value;
		const writerResult = options.create
			? { ok: true as const, value: new EventWriter({ ...scope, store, fence }) }
			: await openEventWriter({ ...scope, store, fence });
		if (!writerResult.ok) {
			throw resultError("v3 event writer open failed", writerResult.error);
		}
		writer = writerResult.value;
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
			restoreDependencies:
				options.restoreDependencies ??
				await registerSessionRestoreDependencies(),
		};
	} catch (cause) {
		const cleanupErrors = await cleanupComposedRuntime(leaseStore, fence, store, writer);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[cause, ...cleanupErrors],
				"v3 runtime composition failed and cleanup was incomplete",
			);
		}
		throw cause;
	}
}

export class V3SessionManager {
	private readonly runtime: OpenedV3Runtime;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private closePromise: Promise<void> | undefined;
	private closeWithWriterLeaseEvidencePromise: Promise<V3SessionWriterLeaseReleasedEvidence> | undefined;
	private releasedWriterLeaseEvidence: V3SessionWriterLeaseReleasedEvidence | undefined;
	private writerFenceFailure: string | undefined;
	private closed = false;

	private constructor(runtime: OpenedV3Runtime) {
		this.runtime = runtime;
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		if (this.heartbeat || this.closed || this.writerFenceFailure) return;
		this.heartbeat = setInterval(() => {
			const renewed = this.runtime.leaseStore.heartbeat(this.runtime.fence, LEASE_DURATION_MS);
			if (!renewed.ok) {
				this.latchWriterFenceFailure(renewed.error.code, renewed.error.message);
				return;
			}
			this.runtime.fence = renewed.value;
		}, LEASE_DURATION_MS / 3);
		this.heartbeat.unref();
	}

	private stopHeartbeat(): void {
		if (!this.heartbeat) return;
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	private latchWriterFenceFailure(code: string, message: string): void {
		this.writerFenceFailure ??= `${code}: ${message}`;
		this.stopHeartbeat();
	}

	private currentWriterFence(): WriterLeaseRecord {
		if (this.writerFenceFailure) {
			throw new Error(`v3 writer lease is fenced: ${this.writerFenceFailure}`);
		}
		const current = this.runtime.leaseStore.validate(this.runtime.fence);
		if (!current.ok) {
			this.latchWriterFenceFailure(current.error.code, current.error.message);
			throw new Error(`v3 writer lease is fenced: ${this.writerFenceFailure}`);
		}
		this.runtime.fence = current.value;
		return current.value;
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
		const filePath = createFilePath(sessionDir, sessionId, options.filePath);
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
		try {
			if (options.writeGenesis !== false) await runtime.sessionEvents.ensureInitialized();
			return manager;
		} catch (cause) {
			try {
				await manager.closeAll();
			} catch (cleanupCause) {
				throw new AggregateError(
					[cause, ...aggregateCleanupErrors(cleanupCause)],
					"v3 session create failed and cleanup was incomplete",
				);
			}
			throw cause;
		}
	}

	public static async open(
		filePath: string,
		features: Readonly<RuntimeFeatureFlags>,
		identity: RuntimeIdentityContext = createLocalIdentityContext(),
		options: V3SessionOpenOptions = {},
	): Promise<V3SessionManager> {
		return V3SessionManager.openRegistered(filePath, features, identity, options);
	}

	/**
	 * dependency-bound session 的显式异步 restore factory。
	 * registrar 完成且 snapshot identity/generation 匹配前不会打开 Event Store 或返回 manager。
	 */
	public static async restore(
		filePath: string,
		features: Readonly<RuntimeFeatureFlags>,
		identity: RuntimeIdentityContext,
		options: V3SessionRestoreOptions,
	): Promise<V3SessionManager> {
		return V3SessionManager.openRegistered(filePath, features, identity, options);
	}

	private static async openRegistered(
		filePath: string,
		features: Readonly<RuntimeFeatureFlags>,
		identity: RuntimeIdentityContext,
		options: V3SessionOpenOptions,
	): Promise<V3SessionManager> {
		const restoreDependencies = await registerSessionRestoreDependencies(
			options.registerDependencies,
		);
		const absolute = resolve(filePath);
		const dependencySnapshot = await readSessionSnapshot(
			join(stateDirectoryFor(absolute), "snapshot.json"),
		);
		if (!dependencySnapshot.ok) {
			throw resultError("v3 session dependency snapshot read failed", dependencySnapshot.error);
		}
		verifySessionRestoreDependencies(
			dependencySnapshot.value?.restoreDependencies,
			restoreDependencies,
		);
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
			restoreDependencies,
		});
		const recovery = await recoverSession({
			store: runtime.store,
			sessionDirectory: runtime.stateDirectory,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: first.stream.sessionId,
			snapshotFilePath: join(runtime.stateDirectory, "snapshot.json"),
			...(dependencySnapshot.value === undefined
				? {}
				: { snapshot: dependencySnapshot.value }),
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

	public restoreDependency(
		kind: SessionRestoreDependencyKind,
		identity: string,
	): unknown {
		return this.runtime.restoreDependencies.get(kind, identity);
	}

	public sessionId(): SessionId {
		return this.runtime.sessionId;
	}

	public runtimeId(): RuntimeInstanceId {
		return this.runtime.runtimeId;
	}

	/** 不暴露 raw fencing token；receipt 可安全跨越 replacement adapter 边界。 */
	public writerFenceReceipt(): V3SessionWriterFenceReceipt {
		const fence = this.currentWriterFence();
		const body = {
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
			sessionId: this.runtime.sessionId,
			runtimeId: this.runtime.runtimeId,
			stream: { ...this.runtime.stream },
			leaseId: fence.leaseId,
			writerEpoch: fence.writerEpoch,
			fencingTokenDigest: fence.fencingTokenDigest,
			acquiredAt: fence.acquiredAt,
			expiresAt: fence.expiresAt,
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

	/**
	 * 对当前 exact head 重做 durable barrier。即使前一次 flush receipt 丢失，
	 * 调用方也能用同一 writer epoch 取得可验证的 committed receipt。
	 */
	public flushCurrentHead(): Promise<SessionResult<DurableEventReceipt>> {
		const head = this.runtime.writer.currentHead();
		if (!head) {
			return Promise.resolve({
				ok: false,
				error: {
					code: "sequence_conflict",
					message: "v3 session has no current event head to flush",
					retryable: false,
					effect: "none",
				},
			});
		}
		let fence: WriterLeaseRecord;
		try {
			fence = this.currentWriterFence();
		} catch {
			return Promise.resolve({
				ok: false,
				error: {
					code: "writer_fenced",
					message: "v3 session writer fence is unavailable",
					retryable: false,
					effect: "uncertain",
				},
			});
		}
		const cursor: AcceptedEventCursor = {
			...head,
			writerEpoch: fence.writerEpoch,
		};
		return this.runtime.store.flushThrough(
			this.runtime.stream,
			cursor,
			fence,
		);
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

	public async refreshRecoveryDecision(): Promise<RecoveryDecision> {
		const recovery = await recoverSession({
			store: this.runtime.store,
			sessionDirectory: this.runtime.stateDirectory,
			authorityId: this.runtime.identity.authorityId,
			tenantId: this.runtime.identity.tenantId,
			sessionId: this.runtime.sessionId,
			snapshotFilePath: join(this.runtime.stateDirectory, "snapshot.json"),
		});
		this.runtime.recovery = recovery;
		return recovery;
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
		if (this.closePromise) return this.closePromise;
		if (this.closed) return Promise.resolve();
		this.closePromise = this.closeRuntime();
		return this.closePromise;
	}

	/** 与 closeAll 共用同一次 close/release effect，并返回 confirmed durable release evidence。 */
	public closeAllWithWriterLeaseEvidence(): Promise<V3SessionWriterLeaseReleasedEvidence> {
		this.closeWithWriterLeaseEvidencePromise ??= this.closeAll().then(
			() => this.writerLeaseReleasedEvidence(),
		);
		return this.closeWithWriterLeaseEvidencePromise;
	}

	/** release 未经 exact durable confirmation 前拒绝生成证据。 */
	public writerLeaseReleasedEvidence(): V3SessionWriterLeaseReleasedEvidence {
		if (!this.releasedWriterLeaseEvidence) {
			throw new Error("v3 writer lease release is not confirmed");
		}
		return { ...this.releasedWriterLeaseEvidence };
	}

	private async closeRuntime(): Promise<void> {
		const errors = await closeWriterAndStore(
			this.runtime.writer,
			this.runtime.store,
			() => this.stopHeartbeat(),
		);
		const released = releaseWriterLease(this.runtime.leaseStore, this.runtime.fence);
		errors.push(...released.errors);
		if (released.releasedRecord) {
			const releasedAt = released.releasedRecord.releasedAt;
			if (releasedAt === undefined) {
				errors.push(new Error("v3 writer lease release failed: durable_write_failed: releasedAt is missing"));
			} else {
				const evidenceBody = {
					authorityId: this.runtime.identity.authorityId,
					tenantId: this.runtime.identity.tenantId,
					sessionId: this.runtime.sessionId,
					runtimeInstanceId: this.runtime.runtimeId,
					leaseId: released.releasedRecord.leaseId,
					writerEpoch: released.releasedRecord.writerEpoch,
					fencingTokenDigest: released.releasedRecord.fencingTokenDigest,
					releasedAt,
				};
				this.releasedWriterLeaseEvidence = {
					...evidenceBody,
					evidenceDigest: canonicalDigest(evidenceBody),
				};
				this.closed = true;
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			throw new AggregateError(errors, "v3 session runtime close failed");
		}
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
