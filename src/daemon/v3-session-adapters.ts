/** Runtime v3 session kernel 到 Phase 10 Control Plane 的 fail-closed production adapters。 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { projectRuntimeActivityEvents } from "../runtime/activity/projection.ts";
import {
	sameRuntimeEventStream,
	type EventCursor,
	type ExpectedRevision,
	type RuntimeEventStreamRef,
	type RuntimeEventV3,
} from "../runtime/protocol/v3/events.ts";
import {
	createRuntimeId,
	isRuntimeId,
	parseRuntimeId,
	type ArtifactId,
	type CommandId,
	type RuntimeInstanceId,
	type SessionId,
} from "../runtime/protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../runtime/protocol/v3/schemas.ts";
import type { RuntimeIdentityContext } from "../runtime/identity/types.ts";
import type { RuntimeFeatureFlags } from "../runtime/runtime-features.ts";
import type {
	ExternalReceiptAuditReceipt,
	LifecycleResult,
	StartupExternalReceiptAuditPort,
} from "../runtime/lifecycle/recovery.ts";
import { CanonicalEventExternalReferenceSource } from "../runtime/lifecycle/canonical-references.ts";
import { StartupRecoveryCoordinator } from "../runtime/lifecycle/startup.ts";
import { createStableForkPlan } from "../runtime/session/checkpoint.ts";
import { verifyRuntimeEventChain } from "../runtime/session/chain-verification.ts";
import type { RuntimeEventStore } from "../runtime/session/event-store.ts";
import { scanJsonlV3EventLog } from "../runtime/session/jsonl-v3-store.ts";
import type { SessionProjection } from "../runtime/session/projections.ts";
import { recoverSession, type RecoveryDecision } from "../runtime/session/recovery.ts";
import { reduceSessionEvents } from "../runtime/session/reducer.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import type {
	AcceptedEventCursor,
	DurableEventReceipt,
	EventLogVerification,
	EventPage,
	EventPageQuery,
	MutationEffect,
	SessionKernelError,
	SessionResult,
	WriterFence,
} from "../runtime/session/types.ts";
import { ArtifactCasStore } from "../runtime/artifacts/cas-store.ts";
import { ArtifactMetadataStore } from "../runtime/artifacts/metadata-store.ts";
import type { ArtifactMetadata } from "../runtime/artifacts/types.ts";
import { controlPlaneFailure, ControlPlaneError, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import type {
	QueueCancelCommand,
	QueueControlPlanePort,
	QueueListQuery,
	QueueListValue,
} from "../runtime/control-plane/types.ts";
import type { SessionHandleValidationPort } from "../runtime/control-plane/query-service.ts";
import type {
	CandidateAuthorityBinding,
	ManagedSessionRuntime,
	SessionRuntimeFactoryPort,
} from "../runtime/control-plane/session-registry.ts";
import type {
	EventSourceRecord,
	EventSubscriptionSourcePort,
} from "../runtime/control-plane/subscriptions.ts";
import {
	MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES,
	type ActivityGetQuery,
	type ArtifactMetadataQuery,
	type ArtifactReadQuery,
	type ControlPlaneQuery,
	type ControlPlaneQueryValue,
	type ControlPlaneRequestContext,
	type QueryExecutorPort,
	type SessionInspection,
} from "../runtime/control-plane/types.ts";
import type { SessionControlState, SessionControlStatePort } from "./composition-root.ts";
import type {
	DaemonRuntimeRecoveryPort,
	DaemonSessionRecoveryDescriptor,
	DaemonSessionRecoveryState,
	RecoveredSideEffectKind,
	RecoveredSideEffectState,
	RestoredDaemonSession,
} from "./recovery-adapter.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { resolveSessionDir } from "../storage/paths.ts";
import { GovernedV3SessionRuntime } from "../storage/v3-runtime-adapter.ts";
import { V3SessionManager } from "../storage/v3-session-manager.ts";
import {
	DurableQueueBindingError,
	DurableQueueCancellationPartialError,
	DurableQueueRevisionConflictError,
} from "../runtime/session/agent-loop-events.ts";

export interface V3SessionLocation {
	sessionId: SessionId;
	filePath: string;
	stateDirectory: string;
}

export interface V3SessionLocatorPort {
	list(): Promise<ControlPlaneResult<readonly V3SessionLocation[]>>;
	locate(sessionId: SessionId): Promise<ControlPlaneResult<V3SessionLocation>>;
}

export interface DirectoryV3SessionLocatorOptions {
	cwd: string;
	sessionDir?: string;
}

function adapterUnavailable<T>(operation: string, error?: unknown, effect: "none" | "uncertain" = "none"): ControlPlaneResult<T> {
	return controlPlaneFailure(
		"adapter_unavailable",
		`${operation} is unavailable`,
		true,
		{ errorName: error instanceof Error ? error.name : "UnknownError" },
		effect,
	);
}

function recoveryRequired<T>(message: string, details?: Readonly<Record<string, string | number | boolean>>): ControlPlaneResult<T> {
	return controlPlaneFailure("recovery_required", message, false, details);
}

function unavailableExternalReceiptAudit(): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
	return Promise.resolve({
		ok: false,
		error: {
			code: "external_unavailable",
			message: "startup external receipt auditor is not configured",
			retryable: true,
		},
	});
}

const FAIL_CLOSED_STARTUP_AUDITOR: StartupExternalReceiptAuditPort = Object.freeze({
	auditWorkspaceLease: unavailableExternalReceiptAudit,
	auditApprovalDecision: unavailableExternalReceiptAudit,
});

/**
 * Session effect 描述此前待 flush 的 canonical mutation；Control Plane effect 描述本次只读 query。
 * 已确定 committed 不会把失败 query 伪装成成功，也不表示 query outcome uncertain。
 */
function activityQueryFailureEffect(effect: MutationEffect | undefined): "none" | "uncertain" {
	return effect === "uncertain" || effect === undefined ? "uncertain" : "none";
}

function pathIsWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** 只枚举配置 sessionDir 下可识别的 v3 文件；重复 sessionId 与 symlink escape 均拒绝。 */
export class DirectoryV3SessionLocator implements V3SessionLocatorPort {
	readonly #cwd: string;
	readonly #sessionDir: string;

	public constructor(options: DirectoryV3SessionLocatorOptions) {
		this.#cwd = resolve(options.cwd);
		this.#sessionDir = resolve(options.sessionDir ?? resolveSessionDir(this.#cwd));
	}

	public async list(): Promise<ControlPlaneResult<readonly V3SessionLocation[]>> {
		try {
			const listed = await SessionManager.listAll(this.#sessionDir);
			const v3 = listed.filter((entry) => entry.format === "v3" && entry.version === 3);
			if (v3.length === 0) return { ok: true, value: [] };
			const root = await realpath(this.#sessionDir);
			const locations: V3SessionLocation[] = [];
			const seen = new Set<SessionId>();
			for (const entry of v3) {
				const sessionId = parseRuntimeId("session", entry.id);
				if (!sessionId) {
					return recoveryRequired("session locator found an invalid v3 session id");
				}
				const filePath = await realpath(entry.filePath);
				if (!pathIsWithin(root, filePath)) {
					return recoveryRequired("session locator refused a path outside the configured session directory");
				}
				if (seen.has(sessionId)) return recoveryRequired("session locator found duplicate v3 session ids");
				seen.add(sessionId);
				locations.push({ sessionId, filePath, stateDirectory: `${filePath}.state` });
			}
			locations.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
			return { ok: true, value: locations };
		} catch (error) {
			return adapterUnavailable("v3 session discovery", error);
		}
	}

	public async locate(sessionId: SessionId): Promise<ControlPlaneResult<V3SessionLocation>> {
		if (!isRuntimeId(sessionId, "session")) return controlPlaneFailure("invalid_request", "session id is invalid");
		const listed = await this.list();
		if (!listed.ok) return listed;
		const matches = listed.value.filter((entry) => entry.sessionId === sessionId);
		if (matches.length !== 1 || !matches[0]) {
			return recoveryRequired(matches.length === 0 ? "v3 session was not found" : "v3 session id is ambiguous");
		}
		return { ok: true, value: matches[0] };
	}
}

function corruptedDecision(message: string, details?: SessionKernelError["details"]): RecoveryDecision {
	return {
		kind: "corrupted",
		error: { code: "corrupted_log", message, retryable: false, ...(details ? { details } : {}) },
	};
}

class ReplayOnlyEventStore implements RuntimeEventStore {
	readonly #events: readonly RuntimeEventV3[];
	readonly #verification: EventLogVerification;

	public constructor(events: readonly RuntimeEventV3[], verification: EventLogVerification) {
		this.#events = events;
		this.#verification = verification;
	}

	public streamRef(): RuntimeEventStreamRef {
		return { ...this.#verification.stream };
	}

	public append(
		_stream: RuntimeEventStreamRef,
		_event: RuntimeEventV3,
		_expected: ExpectedRevision | null,
		_fence: WriterFence,
	): Promise<SessionResult<AcceptedEventCursor>> {
		return Promise.resolve({
			ok: false,
			error: { code: "writer_fenced", message: "recovery projection store is read-only", retryable: false },
		});
	}

	public flushThrough(
		_stream: RuntimeEventStreamRef,
		_cursor: AcceptedEventCursor,
		_fence: WriterFence,
	): Promise<SessionResult<DurableEventReceipt>> {
		return Promise.resolve({
			ok: false,
			error: { code: "writer_fenced", message: "recovery projection store is read-only", retryable: false },
		});
	}

	public readPage(stream: RuntimeEventStreamRef, query: EventPageQuery): Promise<SessionResult<EventPage>> {
		if (!sameRuntimeEventStream(stream, this.#verification.stream)) {
			return Promise.resolve({ ok: false, error: { code: "identity_mismatch", message: "read-only stream mismatch", retryable: false } });
		}
		if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
			return Promise.resolve({
				ok: false,
				error: { code: "invalid_event", message: "read-only page limit is invalid", retryable: false },
			});
		}
		const start = query.afterSequence === undefined ? 0 : query.afterSequence + 1;
		if (!Number.isInteger(start) || start < 0) {
			return Promise.resolve({
				ok: false,
				error: { code: "invalid_event", message: "read-only cursor is invalid", retryable: false },
			});
		}
		const events = this.#events.slice(start, start + query.limit);
		const last = events.at(-1);
		return Promise.resolve({
			ok: true,
			value: {
				events,
				hasMore: start + events.length < this.#events.length,
				...(last
					? {
							nextCursor: {
								stream: last.stream,
								sequence: last.sequence,
								eventId: last.eventId,
								eventHash: last.currentEventHash,
							},
						}
					: {}),
			},
		});
	}

	public verify(stream: RuntimeEventStreamRef): Promise<SessionResult<EventLogVerification>> {
		if (!sameRuntimeEventStream(stream, this.#verification.stream)) {
			return Promise.resolve({ ok: false, error: { code: "identity_mismatch", message: "read-only stream mismatch", retryable: false } });
		}
		return Promise.resolve({ ok: true, value: this.#verification });
	}

	public subscribe(stream: RuntimeEventStreamRef, afterSequence = -1): AsyncIterable<RuntimeEventV3> {
		const events = this.#events;
		return (async function* () {
			if (!sameRuntimeEventStream(stream, events[0]?.stream ?? stream)) return;
			for (const event of events) if (event.sequence > afterSequence) yield event;
		})();
	}

	public close(): Promise<SessionResult<void>> {
		return Promise.resolve({ ok: true, value: undefined });
	}
}

interface V3SessionEvidence {
	location: V3SessionLocation;
	events: readonly RuntimeEventV3[];
	projection?: SessionProjection;
	decision: RecoveryDecision;
}

export interface V3SessionEvidenceReaderOptions {
	locator: V3SessionLocatorPort;
	identity: RuntimeIdentityContext;
}

/** daemon restart 的纯读取路径；不获取 writer lease，也不调用 tool/model/child executor。 */
export class V3SessionEvidenceReader {
	readonly #locator: V3SessionLocatorPort;
	readonly #identity: RuntimeIdentityContext;

	public constructor(options: V3SessionEvidenceReaderOptions) {
		this.#locator = options.locator;
		this.#identity = options.identity;
	}

	public locator(): V3SessionLocatorPort {
		return this.#locator;
	}

	public async read(sessionId: SessionId): Promise<ControlPlaneResult<V3SessionEvidence>> {
		const location = await this.#locator.locate(sessionId);
		if (!location.ok) return location;
		let bytes: Buffer;
		try {
			bytes = await readFile(location.value.filePath);
		} catch (error) {
			return adapterUnavailable("v3 session evidence read", error);
		}
		const newline = bytes.indexOf(0x0a);
		if (newline < 0) {
			return { ok: true, value: { location: location.value, events: [], decision: corruptedDecision("v3 session genesis is not LF terminated") } };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown;
		} catch {
			return { ok: true, value: { location: location.value, events: [], decision: corruptedDecision("v3 session genesis is malformed") } };
		}
		const genesis = validateRuntimeEvent(parsed);
			if (
				!genesis.ok ||
				genesis.value.sequence !== 0 ||
				genesis.value.stream.scope !== "session" ||
				genesis.value.stream.sessionId !== sessionId
			) {
			return { ok: true, value: { location: location.value, events: [], decision: corruptedDecision("v3 session genesis correlation is invalid") } };
		}
		if (
			genesis.value.authorityId !== this.#identity.authorityId ||
			genesis.value.tenantId !== this.#identity.tenantId
		) return controlPlaneFailure("unauthorized_peer", "v3 session authority or tenant is not owned by this daemon");

			if (genesis.value.stream.scope !== "session") {
				return { ok: true, value: { location: location.value, events: [], decision: corruptedDecision("v3 session genesis stream is invalid") } };
			}
			const scan = scanJsonlV3EventLog(bytes, {
				authorityId: this.#identity.authorityId,
				tenantId: this.#identity.tenantId,
				stream: genesis.value.stream,
		});
		if (scan.firstError) {
			return {
				ok: true,
				value: {
					location: location.value,
					events: scan.events,
					decision: corruptedDecision("v3 session event log failed strict scanning", {
						firstBadSequence: scan.firstError.line,
						byteOffset: scan.firstError.byteOffset,
						tornTail: scan.tornTail,
					}),
				},
			};
		}
			const verification = verifyRuntimeEventChain(scan.events, {
				authorityId: this.#identity.authorityId,
				tenantId: this.#identity.tenantId,
				stream: genesis.value.stream,
		});
		if (verification.integrity !== "valid") {
			const fallback = corruptedDecision("v3 session verification failed");
			return {
				ok: true,
				value: {
					location: location.value,
					events: scan.events,
					decision: {
						kind: "corrupted",
						error: verification.error ?? (fallback.kind === "corrupted" ? fallback.error : {
							code: "corrupted_log",
							message: "v3 session verification failed",
							retryable: false,
						}),
					},
				},
			};
		}
		const projection = reduceSessionEvents(scan.events);
		if (!projection.ok) {
			return {
				ok: true,
				value: {
					location: location.value,
					events: scan.events,
					decision: { kind: "corrupted", error: projection.error },
				},
			};
		}
		const store = new ReplayOnlyEventStore(scan.events, verification);
		const decision = await recoverSession({
			store,
			sessionDirectory: location.value.stateDirectory,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			sessionId,
			snapshotFilePath: join(location.value.stateDirectory, "snapshot.json"),
		});
		return { ok: true, value: { location: location.value, events: scan.events, projection: projection.value, decision } };
	}
}

function sameIdentity(manager: V3SessionManager, identity: RuntimeIdentityContext): boolean {
	const actual = manager.identity();
	return (
		actual.authorityId === identity.authorityId &&
		actual.tenantId === identity.tenantId &&
		actual.principalId === identity.principalId
	);
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash
	);
}

export class V3ManagedSessionRuntime implements ManagedSessionRuntime {
	public readonly sessionId: SessionId;
	public readonly authorityBinding?: () => CandidateAuthorityBinding;
	readonly #manager: V3SessionManager;
	readonly #onClosed: (runtime: V3ManagedSessionRuntime) => void;
	#closed = false;

	public constructor(
		manager: V3SessionManager,
		onClosed: (runtime: V3ManagedSessionRuntime) => void,
		authorityBinding?: CandidateAuthorityBinding,
	) {
		this.#manager = manager;
		this.sessionId = manager.sessionId();
		this.#onClosed = onClosed;
		if (authorityBinding) {
			const immutable = structuredClone(authorityBinding);
			this.authorityBinding = () => structuredClone(immutable);
		}
	}

	public manager(): V3SessionManager {
		return this.#manager;
	}

	public isClosed(): boolean {
		return this.#closed;
	}

	public head(): EventCursor | null {
		return this.#manager.writer().currentHead() ?? null;
	}

	public async teardown(_reason: "replacement" | "shutdown"): Promise<ControlPlaneResult<void>> {
		if (this.#closed) return { ok: true, value: undefined };
		try {
			await this.#manager.closeAll();
		} catch (error) {
			return adapterUnavailable("v3 session teardown", error, "uncertain");
		}
		this.#closed = true;
		this.#onClosed(this);
		return { ok: true, value: undefined };
	}
}

export interface V3CandidateAuthorityBindingPort {
	bind(manager: V3SessionManager): Promise<ControlPlaneResult<CandidateAuthorityBinding>>;
}

export interface V3SessionRuntimeFactoryAdapterOptions {
	cwd: string;
	sessionDir?: string;
	features: Readonly<RuntimeFeatureFlags>;
	identity: RuntimeIdentityContext;
	locator?: V3SessionLocatorPort;
	candidateAuthority?: V3CandidateAuthorityBindingPort;
	externalReceiptAuditor?: StartupExternalReceiptAuditPort;
	externalReceiptAuditTimeoutMs?: number;
}

/** create/open/fork 始终持有 V3SessionManager 的 writer lease，teardown 后才释放。 */
export class V3SessionRuntimeFactoryAdapter implements SessionRuntimeFactoryPort {
	readonly #cwd: string;
	readonly #sessionDir: string;
	readonly #features: Readonly<RuntimeFeatureFlags>;
	readonly #identity: RuntimeIdentityContext;
	readonly #locator: V3SessionLocatorPort;
	readonly #candidateAuthority: V3CandidateAuthorityBindingPort | undefined;
	readonly #externalReceiptAuditor: StartupExternalReceiptAuditPort;
	readonly #externalReceiptAuditTimeoutMs: number;
	readonly #active = new Map<SessionId, V3ManagedSessionRuntime>();

	public constructor(options: V3SessionRuntimeFactoryAdapterOptions) {
		if (!options.features.sessionV3) throw new Error("V3SessionRuntimeFactoryAdapter requires sessionV3");
		this.#cwd = resolve(options.cwd);
		this.#sessionDir = resolve(options.sessionDir ?? resolveSessionDir(this.#cwd));
		this.#features = options.features;
		this.#identity = options.identity;
		this.#locator = options.locator ?? new DirectoryV3SessionLocator({ cwd: this.#cwd, sessionDir: this.#sessionDir });
		this.#candidateAuthority = options.candidateAuthority;
		this.#externalReceiptAuditor = options.externalReceiptAuditor ?? FAIL_CLOSED_STARTUP_AUDITOR;
		this.#externalReceiptAuditTimeoutMs = options.externalReceiptAuditTimeoutMs ?? 5_000;
	}

	public identity(): RuntimeIdentityContext {
		return this.#identity;
	}

	public locator(): V3SessionLocatorPort {
		return this.#locator;
	}

	public activeRuntime(sessionId: SessionId): V3ManagedSessionRuntime | undefined {
		const runtime = this.#active.get(sessionId);
		return runtime && !runtime.isClosed() ? runtime : undefined;
	}

	async #manage(manager: V3SessionManager): Promise<ControlPlaneResult<V3ManagedSessionRuntime>> {
		if (manager.sessionId() === undefined || !sameIdentity(manager, this.#identity)) {
			return controlPlaneFailure("adapter_contract_violation", "v3 session manager scope is inconsistent");
		}
		if (this.#active.has(manager.sessionId())) {
			return controlPlaneFailure("session_replacing", "a v3 manager for this session is already active", true);
		}
		let authorityBinding: CandidateAuthorityBinding | undefined;
		if (this.#candidateAuthority) {
			const bound = await this.#candidateAuthority.bind(manager);
			if (!bound.ok) return bound;
			authorityBinding = bound.value;
		}
		const runtime = new V3ManagedSessionRuntime(manager, (closed) => {
			if (this.#active.get(closed.sessionId) === closed) this.#active.delete(closed.sessionId);
		}, authorityBinding);
		this.#active.set(runtime.sessionId, runtime);
		return { ok: true, value: runtime };
	}

	async #openResumable(sessionId: SessionId): Promise<ControlPlaneResult<V3ManagedSessionRuntime>> {
		const location = await this.#locator.locate(sessionId);
		if (!location.ok) return location;
		let governed: GovernedV3SessionRuntime;
		try {
			governed = await GovernedV3SessionRuntime.open({
				filePath: location.value.filePath,
				features: this.#features,
				identity: this.#identity,
				runtimeId: createRuntimeId("runtime"),
				externalReceiptAuditor: this.#externalReceiptAuditor,
				externalReceiptAuditTimeoutMs: this.#externalReceiptAuditTimeoutMs,
			});
		} catch (error) {
			return recoveryRequired("v3 session could not establish a trusted writable recovery state", {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
		if (governed.sessionId() !== sessionId) {
			await governed.close().catch(() => undefined);
			return controlPlaneFailure("adapter_contract_violation", "opened v3 session correlation is invalid");
		}
		const admitted = await governed.runIfResumable(async (manager) => {
			if (!sameIdentity(manager, this.#identity)) {
				return controlPlaneFailure<V3ManagedSessionRuntime>(
					"adapter_contract_violation",
					"opened v3 session authority correlation is invalid",
				);
			}
			return this.#manage(manager);
		});
		if (!admitted.ok) {
			const startup = governed.startupReport().sessions[0];
			await governed.close().catch(() => undefined);
			return recoveryRequired("v3 session did not pass governed startup external receipt audit", {
				recoveryState: startup?.disposition === "paused"
					? "pause_for_approval"
					: startup?.disposition ?? "missing",
				startupDisposition: startup?.disposition ?? "missing",
				startupReasons: startup?.reasons.join(",") || "none",
				reasonCount: startup?.reasons.length ?? 0,
			});
		}
		const managed = admitted.value;
		if (!managed.ok) await governed.close().catch(() => undefined);
		return managed;
	}

	public async start(): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		try {
			const runtimeId: RuntimeInstanceId = createRuntimeId("runtime");
			const manager = await V3SessionManager.create({
				cwd: this.#cwd,
				sessionDir: this.#sessionDir,
				features: this.#features,
				identity: this.#identity,
				runtimeId,
			});
			const managed = await this.#manage(manager);
			if (!managed.ok) await manager.closeAll().catch(() => undefined);
			return managed;
		} catch (error) {
			return adapterUnavailable("v3 session start", error, "uncertain");
		}
	}

	public resume(sessionId: SessionId): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		if (!isRuntimeId(sessionId, "session")) {
			return Promise.resolve(controlPlaneFailure("invalid_request", "resume session id is invalid"));
		}
		return this.#openResumable(sessionId);
	}

	async #revalidateActiveForkParent(parent: V3SessionManager): Promise<ControlPlaneResult<void>> {
		try {
			const identity = parent.identity();
			const sessionId = parent.sessionId();
			const references = new CanonicalEventExternalReferenceSource(parent.eventStore(), {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				sessionId,
			});
			const startup = await new StartupRecoveryCoordinator({
				references,
				auditor: this.#externalReceiptAuditor,
				externalOperationTimeoutMs: this.#externalReceiptAuditTimeoutMs,
			}).scan([{
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				sessionId,
				sessionDirectory: parent.stateDirectory(),
				store: parent.eventStore(),
				snapshotFilePath: join(parent.stateDirectory(), "snapshot.json"),
			}]);
			const report = startup.sessions[0];
			if (!report || report.disposition !== "resumable") {
				return recoveryRequired("active fork parent did not pass governed external receipt revalidation", {
					startupDisposition: report?.disposition ?? "missing",
					startupReasons: report?.reasons.join(",") || "none",
				});
			}
			return { ok: true, value: undefined };
		} catch (error) {
			return recoveryRequired("active fork parent external receipt revalidation is unavailable", {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	public async fork(
		parentSessionId: SessionId,
		parentCursor: EventCursor,
		goalMode: "continue_existing_goal" | "create_child_goal",
	): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		if (
			!isRuntimeId(parentSessionId, "session") ||
			parentCursor.stream.scope !== "session" ||
			parentCursor.stream.sessionId !== parentSessionId
		) {
			return controlPlaneFailure("cursor_mismatch", "fork parent cursor correlation is invalid");
		}
		const location = await this.#locator.locate(parentSessionId);
		if (!location.ok) return location;
		let parent: V3SessionManager | undefined;
		let governedParent: GovernedV3SessionRuntime | undefined;
		let child: V3SessionManager | undefined;
		let childHasDurableGenesis = false;
		try {
			const activeParent = this.activeRuntime(parentSessionId);
			if (activeParent) {
				parent = activeParent.manager();
				const revalidated = await this.#revalidateActiveForkParent(parent);
				if (!revalidated.ok) return revalidated;
			} else {
				governedParent = await GovernedV3SessionRuntime.open({
					filePath: location.value.filePath,
					features: this.#features,
					identity: this.#identity,
					runtimeId: createRuntimeId("runtime"),
					externalReceiptAuditor: this.#externalReceiptAuditor,
					externalReceiptAuditTimeoutMs: this.#externalReceiptAuditTimeoutMs,
				});
				const admitted = await governedParent.runIfResumable(async (manager) => manager);
				if (!admitted.ok) {
					const startup = governedParent.startupReport().sessions[0];
					return recoveryRequired("fork parent did not pass governed startup external receipt audit", {
						startupDisposition: startup?.disposition ?? "missing",
						startupReasons: startup?.reasons.join(",") || "none",
					});
				}
				parent = admitted.value;
			}
			if (parent.sessionId() !== parentSessionId || !sameIdentity(parent, this.#identity)) {
				return controlPlaneFailure("adapter_contract_violation", "fork parent manager correlation is invalid");
			}
			const recovered = parent.recoveryDecision();
			if (!recovered || recovered.kind === "corrupted" || recovered.kind === "pause_for_approval") {
				return recoveryRequired("fork parent is not at a trusted stable boundary");
			}
			const events = await readAllRuntimeEvents(parent.eventStore());
			if (!events.ok) return recoveryRequired("fork parent replay failed");
			const projection = reduceSessionEvents(events.value);
			if (!projection.ok) return recoveryRequired("fork parent projection failed");
			const actualCursor: EventCursor = {
				stream: parent.eventStore().streamRef(),
				sequence: projection.value.headSequence,
				eventId: projection.value.headEventId,
				eventHash: projection.value.headEventHash,
			};
			if (!sameCursor(actualCursor, parentCursor)) {
				return controlPlaneFailure("cursor_mismatch", "fork parent cursor is not the current stable head");
			}
			const childSessionId = createRuntimeId("session");
			const initialGoalId = goalMode === "continue_existing_goal"
				? projection.value.genesis.initialGoalId
				: createRuntimeId("goal");
			const rootAgentId = createRuntimeId("agent");
			child = await V3SessionManager.create({
				cwd: this.#cwd,
				sessionDir: this.#sessionDir,
				features: this.#features,
				identity: this.#identity,
				runtimeId: createRuntimeId("runtime"),
				sessionId: childSessionId,
				writeGenesis: false,
				lineage: { goalId: initialGoalId, agentId: rootAgentId },
			});
			const plan = createStableForkPlan(projection.value, {
				newSessionId: childSessionId,
				parentLeafId: projection.value.activeLeafId,
				goalMode,
				initialGoalId,
				rootAgentId,
				idempotencyKey: createRuntimeId("command"),
				principalId: this.#identity.principalId,
				traceId: createRuntimeId("trace"),
			});
			if (!plan.ok || !sameCursor(plan.value.parentCursor, parentCursor)) {
				await child.discardEmptyTarget();
				child = undefined;
				return controlPlaneFailure("cursor_mismatch", "fork plan did not preserve the requested parent cursor");
			}
			const genesis = await child.writer().append(plan.value.genesisDraft);
			if (!genesis.ok) return recoveryRequired("fork genesis was not durably committed");
			childHasDurableGenesis = true;
			const messages = await parent.replayMessages();
			for (const message of messages) await child.sessionEvents().recordMessage(message);
			const copiedHistory = await child.writer().flush();
			if (!copiedHistory.ok) throw new Error("forked session history was not durably copied");
			const managed = await this.#manage(child);
			if (!managed.ok) return managed;
			child = undefined;
			return managed;
		} catch (error) {
			return adapterUnavailable("v3 session fork", error, childHasDurableGenesis ? "uncertain" : "none");
		} finally {
			if (governedParent) await governedParent.close().catch(() => undefined);
			if (child) {
				if (childHasDurableGenesis) await child.closeAll().catch(() => undefined);
				else await child.discardEmptyTarget().catch(() => undefined);
			}
		}
	}
}

/** active V3 writer 上的 queue:list/cancel；不维护第二份 queue 状态。 */
export class V3QueueControlAdapter implements QueueControlPlanePort {
	readonly #sessions: V3SessionRuntimeFactoryAdapter;

	public constructor(sessions: V3SessionRuntimeFactoryAdapter) {
		this.#sessions = sessions;
	}

	#manager(
		request: QueueListQuery | QueueCancelCommand,
		context: ControlPlaneRequestContext,
	): ControlPlaneResult<V3SessionManager> {
		const identity = this.#sessions.identity();
		if (
			request.authorityId !== identity.authorityId ||
			request.tenantId !== identity.tenantId ||
			request.principalId !== identity.principalId ||
			context.peer.principalId !== request.principalId
		) return controlPlaneFailure("unauthorized_peer", "queue control scope does not match the v3 daemon identity");
		const runtime = this.#sessions.activeRuntime(request.payload.sessionId);
		if (!runtime || runtime.isClosed() || runtime.manager().sessionId() !== request.payload.sessionId) {
			return controlPlaneFailure("stale_session_handle", "queue session runtime is not active");
		}
		return { ok: true, value: runtime.manager() };
	}

	public async list(
		query: QueueListQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<QueueListValue>> {
		const manager = this.#manager(query, context);
		if (!manager.ok) return manager;
		try {
			const snapshot = await manager.value.sessionEvents().inspectQueue();
			return {
				ok: true,
				value: {
					type: "queue:list",
					sessionId: query.payload.sessionId,
					queueRevision: snapshot.queueRevision,
					items: snapshot.items.map((item) => ({ ...item })),
				},
			};
		} catch (error) {
			return recoveryRequired("durable queue could not produce a recoverable authoritative snapshot", {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	public async cancel(
		command: QueueCancelCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<import("../runtime/control-plane/types.ts").ControlPlaneCommandEffect, { type: "queue:cancel" }>>> {
		const manager = this.#manager(command, context);
		if (!manager.ok) return manager;
		try {
			const cancelled = await manager.value.sessionEvents().cancelQueueItems(
				command.payload.expectedQueueRevision,
				command.payload.items,
				command.payload.reason,
				command.commandId,
			);
			return {
				ok: true,
				value: {
					type: "queue:cancel",
					sessionId: command.payload.sessionId,
					...cancelled,
				},
			};
		} catch (error) {
			if (error instanceof DurableQueueRevisionConflictError) {
				return controlPlaneFailure("expected_revision_conflict", "expected queue revision is stale", true, {
					expectedQueueRevision: error.expectedQueueRevision,
					actualQueueRevision: error.actualQueueRevision,
				});
			}
			if (error instanceof DurableQueueBindingError) {
				return controlPlaneFailure("invalid_request", error.message);
			}
			if (error instanceof DurableQueueCancellationPartialError) {
				return controlPlaneFailure(
					"recovery_required",
					"queue cancellation batch has a partially confirmed durable prefix",
					false,
					{
						confirmedCount: error.receipts.length,
						queueRevision: error.queueRevision,
						errorName: error.cause instanceof Error ? error.cause.name : "UnknownError",
					},
					"uncertain",
				);
			}
			return controlPlaneFailure(
				"recovery_required",
				"queue cancellation was not confirmed durable",
				false,
				{ errorName: error instanceof Error ? error.name : "UnknownError" },
				"uncertain",
			);
		}
	}
}

async function projectionForManager(manager: V3SessionManager): Promise<ControlPlaneResult<SessionProjection>> {
	const events = await readAllRuntimeEvents(manager.eventStore());
	if (!events.ok) return recoveryRequired("v3 session replay could not establish a trusted projection");
	const projection = reduceSessionEvents(events.value);
	if (!projection.ok) return recoveryRequired("v3 session reducer rejected the durable event chain");
	const head = manager.writer().currentHead();
	if (
		!head ||
		head.stream.scope !== "session" ||
		head.stream.sessionId !== projection.value.sessionId ||
		head.sequence !== projection.value.headSequence ||
		head.eventId !== projection.value.headEventId ||
		head.eventHash !== projection.value.headEventHash
	) return recoveryRequired("v3 writer head and reducer projection diverged");
	return { ok: true, value: projection.value };
}

export interface V3SessionInspectionPort {
	inspectForQuery(sessionId: SessionId): Promise<ControlPlaneResult<SessionInspection>>;
}

export interface V3SessionControlStateAdapterOptions {
	sessions: V3SessionRuntimeFactoryAdapter;
	evidence: V3SessionEvidenceReader;
}

function inspectionLifecycle(decision: RecoveryDecision, projection?: SessionProjection): SessionInspection["lifecycle"] {
	if (decision.kind === "corrupted") return "corrupted";
	if (decision.kind === "pause_for_approval") return "paused";
	if (decision.kind === "stopped") return projection?.lifecycle === "closed" ? "closed" : "stopped";
	if (projection?.lifecycle === "closed") return "closed";
	if (projection?.lifecycle === "stopped" || projection?.lifecycle === "stop_requested") return "stopped";
	return "active";
}

/** mutation state 只接受当前 active runtime；query inspection 可读取 inactive/paused/corrupted evidence。 */
export class V3SessionControlStateAdapter implements SessionControlStatePort, V3SessionInspectionPort {
	readonly #sessions: V3SessionRuntimeFactoryAdapter;
	readonly #evidence: V3SessionEvidenceReader;

	public constructor(options: V3SessionControlStateAdapterOptions) {
		this.#sessions = options.sessions;
		this.#evidence = options.evidence;
	}

	public async inspect(sessionId: SessionId): Promise<ControlPlaneResult<SessionControlState>> {
		const runtime = this.#sessions.activeRuntime(sessionId);
		if (!runtime) return controlPlaneFailure("stale_session_handle", "session runtime is not active");
		if (runtime.manager().sessionId() !== sessionId || !sameIdentity(runtime.manager(), this.#sessions.identity())) {
			return controlPlaneFailure("adapter_contract_violation", "active v3 runtime scope is inconsistent");
		}
		const projection = await projectionForManager(runtime.manager());
		if (!projection.ok) return projection;
		if (projection.value.lifecycle !== "active") {
			return recoveryRequired("session mutation is blocked outside the active lifecycle");
		}
		return {
			ok: true,
			value: {
				sessionId,
				revision: {
					stream: runtime.manager().eventStore().streamRef(),
					sequence: projection.value.headSequence,
					eventId: projection.value.headEventId,
					eventHash: projection.value.headEventHash,
				},
				activeTurnId: projection.value.activeTurnId,
			},
		};
	}

	public async inspectForQuery(sessionId: SessionId): Promise<ControlPlaneResult<SessionInspection>> {
		const runtime = this.#sessions.activeRuntime(sessionId);
		if (runtime) {
			const projection = await projectionForManager(runtime.manager());
			if (!projection.ok) return projection;
			return {
				ok: true,
				value: {
					type: "session:inspect",
					sessionId,
					lifecycle: projection.value.lifecycle === "active" ? "active" : inspectionLifecycle(
						{ kind: "resume", projection: projection.value, cursor: runtime.head()!, snapshotSource: "full" },
						projection.value,
					),
					revision: runtime.head(),
					activeTurnId: projection.value.activeTurnId,
					projectionDigest: projection.value.projectionDigest,
				},
			};
		}
		const evidence = await this.#evidence.read(sessionId);
		if (!evidence.ok) return evidence;
		const projection = evidence.value.projection;
		const cursor = evidence.value.decision.kind === "corrupted" ? null : evidence.value.decision.cursor;
		return {
			ok: true,
			value: {
				type: "session:inspect",
				sessionId,
				lifecycle: inspectionLifecycle(evidence.value.decision, projection),
				revision: cursor,
				activeTurnId: projection?.activeTurnId ?? null,
				projectionDigest: projection?.projectionDigest ?? canonicalDigest({
					sessionId,
					integrity: "corrupted",
					errorCode: evidence.value.decision.kind === "corrupted" ? evidence.value.decision.error.code : "unknown",
				}),
			},
		};
	}
}

export interface V3ArtifactAuthorizationRequest {
	authorityId: ArtifactMetadataQuery["authorityId"];
	tenantId: ArtifactMetadataQuery["tenantId"];
	principalId: ArtifactMetadataQuery["principalId"];
	sessionId: SessionId;
	artifactId: ArtifactId;
	operation: "metadata" | "read";
	requestDigest: string;
}

export interface V3ArtifactAuthorizationPort {
	authorize(request: V3ArtifactAuthorizationRequest): Promise<ControlPlaneResult<void>>;
}

export interface V3ArtifactQueryResult {
	metadata: ArtifactMetadata;
	content?: Uint8Array;
}

export interface V3ArtifactQueryPort {
	metadata(
		manager: V3SessionManager,
		query: ArtifactMetadataQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<V3ArtifactQueryResult>>;
	read(
		manager: V3SessionManager,
		query: ArtifactReadQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<V3ArtifactQueryResult>>;
}

function artifactFailure<T>(operation: string, code: string, retryable: boolean): ControlPlaneResult<T> {
	if (code === "authorization_denied" || code === "authorization_unavailable") {
		return controlPlaneFailure("unauthorized_peer", `${operation} authorization was denied`, retryable);
	}
	if (code === "digest_mismatch" || code === "corrupted_metadata" || code === "not_committed") {
		return recoveryRequired(`${operation} integrity could not be established`);
	}
	if (code === "not_found" || code === "invalid_request") {
		return controlPlaneFailure("invalid_request", `${operation} target is unavailable`);
	}
	return controlPlaneFailure("adapter_unavailable", `${operation} storage is unavailable`, retryable);
}

/** 显式 authorization 成功后才读取 manager 自己的 committed metadata/CAS。 */
export class V3ArtifactStoreQueryAdapter implements V3ArtifactQueryPort {
	readonly #authorization: V3ArtifactAuthorizationPort;

	public constructor(authorization: V3ArtifactAuthorizationPort) {
		this.#authorization = authorization;
	}

	async #load(
		manager: V3SessionManager,
		query: ArtifactMetadataQuery | ArtifactReadQuery,
		operation: "metadata" | "read",
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<V3ArtifactQueryResult>> {
		const identity = manager.identity();
		if (
			query.authorityId !== identity.authorityId ||
			query.tenantId !== identity.tenantId ||
			query.principalId !== identity.principalId ||
			context.peer.principalId !== query.principalId ||
			query.payload.sessionId !== manager.sessionId()
		) return controlPlaneFailure("unauthorized_peer", "artifact query scope does not match the active v3 session");
		const authorized = await this.#authorization.authorize({
			authorityId: query.authorityId,
			tenantId: query.tenantId,
			principalId: query.principalId,
			sessionId: query.payload.sessionId,
			artifactId: query.payload.artifactId,
			operation,
			requestDigest: canonicalDigest({
				type: query.type,
				authorityId: query.authorityId,
				tenantId: query.tenantId,
				principalId: query.principalId,
				sessionId: query.payload.sessionId,
				artifactId: query.payload.artifactId,
				...(query.type === "artifact:read"
					? { expectedDigest: query.payload.expectedDigest, maxBytes: query.payload.maxBytes }
					: {}),
			}),
		});
		if (!authorized.ok) return authorized;
		const rootDir = join(manager.stateDirectory(), "artifacts");
		const metadata = await new ArtifactMetadataStore({ rootDir }).readCommitted(
			query.authorityId,
			query.tenantId,
			query.payload.artifactId,
		);
		if (!metadata.ok) return artifactFailure("artifact metadata read", metadata.error.code, metadata.error.retryable);
		if (
			metadata.value.state !== "committed" ||
			metadata.value.authorityId !== query.authorityId ||
			metadata.value.tenantId !== query.tenantId ||
			metadata.value.artifactId !== query.payload.artifactId ||
			metadata.value.source.sessionId !== query.payload.sessionId
		) return recoveryRequired("artifact metadata correlation is invalid");
		if (operation === "metadata") return { ok: true, value: { metadata: metadata.value } };
		if (query.type !== "artifact:read") {
			return controlPlaneFailure("adapter_contract_violation", "artifact read operation received a metadata query");
		}
		if (
			metadata.value.storedDigest !== query.payload.expectedDigest ||
			metadata.value.storedSize > query.payload.maxBytes
		) return recoveryRequired("artifact read request does not match committed digest or size bounds");
		const content = await new ArtifactCasStore({ rootDir }).read(metadata.value.storedDigest);
		if (!content.ok) return artifactFailure("artifact content read", content.error.code, content.error.retryable);
		return { ok: true, value: { metadata: metadata.value, content: content.value } };
	}

	public metadata(
		manager: V3SessionManager,
		query: ArtifactMetadataQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<V3ArtifactQueryResult>> {
		return this.#load(manager, query, "metadata", context);
	}

	public read(
		manager: V3SessionManager,
		query: ArtifactReadQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<V3ArtifactQueryResult>> {
		return this.#load(manager, query, "read", context);
	}
}

export interface V3QueryExecutorAdapterOptions {
	sessions: V3SessionRuntimeFactoryAdapter;
	inspections: V3SessionInspectionPort;
	handles: SessionHandleValidationPort;
	artifacts: V3ArtifactQueryPort;
	/** activity:get 与 health 的真实状态由 daemon lifecycle/activity owner 注入。 */
	operationalQueries: QueryExecutorPort;
}

export class V3QueryExecutorAdapter implements QueryExecutorPort {
	readonly #sessions: V3SessionRuntimeFactoryAdapter;
	readonly #inspections: V3SessionInspectionPort;
	readonly #handles: SessionHandleValidationPort;
	readonly #artifacts: V3ArtifactQueryPort;
	readonly #operational: QueryExecutorPort;

	public constructor(options: V3QueryExecutorAdapterOptions) {
		this.#sessions = options.sessions;
		this.#inspections = options.inspections;
		this.#handles = options.handles;
		this.#artifacts = options.artifacts;
		this.#operational = options.operationalQueries;
	}

	#validateScope(query: ControlPlaneQuery, context: ControlPlaneRequestContext): ControlPlaneResult<void> {
		const identity = this.#sessions.identity();
		if (
			query.authorityId !== identity.authorityId ||
			query.tenantId !== identity.tenantId ||
			query.principalId !== identity.principalId ||
			context.peer.principalId !== query.principalId
		) return controlPlaneFailure("unauthorized_peer", "query scope does not match the v3 daemon identity");
		return { ok: true, value: undefined };
	}

	#activeManager(query: ArtifactMetadataQuery | ArtifactReadQuery): ControlPlaneResult<V3SessionManager> {
		const handle = this.#handles.validate(query.payload.sessionHandle);
		if (!handle.ok) return handle;
		if (query.payload.sessionHandle.sessionId !== query.payload.sessionId) {
			return controlPlaneFailure("stale_session_handle", "artifact handle does not match the requested session");
		}
		const runtime = this.#sessions.activeRuntime(query.payload.sessionId);
		if (!runtime || runtime.sessionId !== query.payload.sessionId || runtime.isClosed()) {
			return controlPlaneFailure("stale_session_handle", "artifact session runtime is no longer active");
		}
		return { ok: true, value: runtime.manager() };
	}

	#metadataMatchesQuery(
		metadata: ArtifactMetadata,
		query: ArtifactMetadataQuery | ArtifactReadQuery,
	): boolean {
		return (
			metadata.state === "committed" &&
			metadata.authorityId === query.authorityId &&
			metadata.tenantId === query.tenantId &&
			metadata.artifactId === query.payload.artifactId &&
			metadata.source.sessionId === query.payload.sessionId &&
			/^[a-f0-9]{64}$/.test(metadata.storedDigest) &&
			Number.isSafeInteger(metadata.storedSize) &&
			metadata.storedSize >= 0 &&
			metadata.mediaType.length > 0 &&
			metadata.mediaType.length <= 256 &&
			["metadata_only", "redacted", "encrypted_forensic"].includes(metadata.redaction)
		);
	}

	async #activity(query: ActivityGetQuery): Promise<ControlPlaneResult<ControlPlaneQueryValue>> {
		if (!query.payload.sessionId || !query.payload.sessionHandle) {
			return controlPlaneFailure("adapter_contract_violation", "session activity requires an exact session handle");
		}
		const current = this.#handles.validate(query.payload.sessionHandle);
		if (!current.ok) return current;
		if (query.payload.sessionHandle.sessionId !== query.payload.sessionId) {
			return controlPlaneFailure("stale_session_handle", "activity handle does not match the requested session");
		}
		const runtime = this.#sessions.activeRuntime(query.payload.sessionId);
		if (!runtime || runtime.isClosed() || runtime.manager().sessionId() !== query.payload.sessionId) {
			return controlPlaneFailure("stale_session_handle", "activity session runtime is no longer active");
		}
		const manager = runtime.manager();
		if (!sameIdentity(manager, this.#sessions.identity())) {
			return controlPlaneFailure("unauthorized_peer", "activity session scope does not match the daemon identity");
		}
		const flushed = await manager.writer().flush();
		if (!flushed.ok) {
			return controlPlaneFailure(
				"recovery_required",
					"activity durable read barrier failed",
					false,
					{ storeCode: flushed.error.code, storeEffect: flushed.error.effect ?? "unspecified" },
					activityQueryFailureEffect(flushed.error.effect),
				);
		}
		const events = await readAllRuntimeEvents(manager.eventStore());
		if (!events.ok) return recoveryRequired("activity event replay failed after its durable read barrier");
		const projected = projectRuntimeActivityEvents(events.value);
		if (!projected.ok) {
			return recoveryRequired("activity canonical projection failed", {
				projectionCode: projected.error.code,
			});
		}
		const head = manager.writer().currentHead();
		if (
			!head ||
			!sameRuntimeEventStream(head.stream, projected.value.heartbeat.cursor.stream) ||
			head.sequence !== projected.value.heartbeat.cursor.sequence ||
			head.eventId !== projected.value.heartbeat.cursor.eventId ||
			head.eventHash !== projected.value.heartbeat.cursor.eventHash
		) return recoveryRequired("activity projection and durable writer head diverged");
		const state = projected.value.status === "active"
			? "running" as const
			: projected.value.status === "waiting_permission"
				? "waiting_approval" as const
				: projected.value.status;
		return {
			ok: true,
			value: {
				type: "activity:get",
				state,
				sessionId: projected.value.sessionId,
				activeTurnId: projected.value.activeTurnId,
				updatedAt: projected.value.heartbeat.observedAt,
				snapshot: projected.value,
			},
		};
	}

	public async execute(
		query: ControlPlaneQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneQueryValue>> {
		const scope = this.#validateScope(query, context);
		if (!scope.ok) return scope;
			switch (query.type) {
				case "queue:list":
				case "changeProposal:inspect":
					return controlPlaneFailure("unsupported_feature", `${query.type} requires its dedicated injected adapter`);
				case "session:inspect": {
				if (query.payload.sessionHandle) {
					const current = this.#handles.validate(query.payload.sessionHandle);
					if (!current.ok) return current;
					if (query.payload.sessionHandle.sessionId !== query.payload.sessionId) {
						return controlPlaneFailure("stale_session_handle", "inspection handle does not match the requested session");
					}
				}
				return this.#inspections.inspectForQuery(query.payload.sessionId);
			}
			case "artifact:metadata": {
				const manager = this.#activeManager(query);
				if (!manager.ok) return manager;
				const result = await this.#artifacts.metadata(manager.value, query, context);
				if (!result.ok) return result;
				const metadata = result.value.metadata;
				if (!this.#metadataMatchesQuery(metadata, query)) {
					return recoveryRequired("artifact metadata result correlation is invalid");
				}
				return {
					ok: true,
					value: {
						type: "artifact:metadata",
						artifactId: metadata.artifactId,
						storedDigest: metadata.storedDigest,
						mediaType: metadata.mediaType,
						storedSize: metadata.storedSize,
						redaction: metadata.redaction,
					},
				};
			}
			case "artifact:read": {
				if (
					!Number.isSafeInteger(query.payload.maxBytes) ||
					query.payload.maxBytes < 1 ||
					query.payload.maxBytes > MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES ||
					!/^[a-f0-9]{64}$/.test(query.payload.expectedDigest)
				) return controlPlaneFailure("invalid_request", "artifact read bounds are invalid");
				const manager = this.#activeManager(query);
				if (!manager.ok) return manager;
				const result = await this.#artifacts.read(manager.value, query, context);
				if (!result.ok) return result;
				const metadata = result.value.metadata;
				const content = result.value.content;
				if (!content) return controlPlaneFailure("adapter_contract_violation", "artifact read adapter omitted content");
				const digest = createHash("sha256").update(content).digest("hex");
				if (
					!this.#metadataMatchesQuery(metadata, query) ||
					metadata.storedDigest !== query.payload.expectedDigest ||
					digest !== query.payload.expectedDigest ||
					metadata.storedSize !== content.byteLength ||
					content.byteLength > query.payload.maxBytes
				) return recoveryRequired("artifact content failed digest, size, or session correlation");
				return {
					ok: true,
					value: {
						type: "artifact:read",
						artifactId: metadata.artifactId,
						storedDigest: metadata.storedDigest,
						mediaType: metadata.mediaType,
						encoding: "base64",
						content: Buffer.from(content).toString("base64"),
						byteLength: content.byteLength,
					},
				};
			}
			case "activity:get":
				return query.payload.sessionId === null
					? this.#operational.execute(query, context)
					: this.#activity(query);
			case "health":
				return this.#operational.execute(query, context);
		}
	}
}

function failingEventIterable(error: ControlPlaneResult<never>): AsyncIterable<EventSourceRecord> {
	return (async function* () {
		if (!error.ok) throw new ControlPlaneError(error.error);
	})();
}

/** subscribe 调用时捕获 runtime 实例；replacement 后旧流结束，不跨 generation rebind。 */
export class V3EventSubscriptionSourceAdapter implements EventSubscriptionSourcePort {
	readonly #sessions: V3SessionRuntimeFactoryAdapter;

	public constructor(sessions: V3SessionRuntimeFactoryAdapter) {
		this.#sessions = sessions;
	}

	public subscribe(sessionId: SessionId, afterSequence: number, signal: AbortSignal): AsyncIterable<EventSourceRecord> {
		if (!isRuntimeId(sessionId, "session") || !Number.isInteger(afterSequence) || afterSequence < -1) {
			return failingEventIterable(controlPlaneFailure("invalid_request", "event subscription cursor is invalid"));
		}
		const runtime = this.#sessions.activeRuntime(sessionId);
		if (!runtime || runtime.isClosed() || runtime.manager().sessionId() !== sessionId) {
			return failingEventIterable(controlPlaneFailure("stale_session_handle", "event subscription runtime is not active"));
		}
		const manager = runtime.manager();
		if (!sameIdentity(manager, this.#sessions.identity())) {
			return failingEventIterable(controlPlaneFailure("unauthorized_peer", "event source runtime scope is invalid"));
		}
		const replayThrough = manager.writer().currentHead()?.sequence ?? -1;
		const eventStore = manager.eventStore();
		const iterator = eventStore.subscribe(eventStore.streamRef(), afterSequence)[Symbol.asyncIterator]();
		return (async function* () {
			const close = () => { void iterator.return?.(); };
			if (signal.aborted) {
				close();
				return;
			}
			signal.addEventListener("abort", close, { once: true });
			try {
				for (;;) {
					const next = await iterator.next();
					if (next.done) return;
					const event = next.value;
					if (
						event.stream.scope !== "session" ||
						event.stream.sessionId !== sessionId ||
						event.authorityId !== manager.identity().authorityId ||
						event.tenantId !== manager.identity().tenantId
					) {
						throw new ControlPlaneError({
							code: "cursor_mismatch",
							message: "v3 event source crossed a session boundary",
							retryable: false,
						});
					}
					yield { event, origin: event.sequence <= replayThrough ? "replay" : "live" };
				}
			} finally {
				signal.removeEventListener("abort", close);
				await iterator.return?.();
			}
		})();
	}
}

function recoveredSideEffects(events: readonly RuntimeEventV3[]): ControlPlaneResult<readonly RecoveredSideEffectState[]> {
	const states = new Map<string, RecoveredSideEffectState>();
	const sandboxRequestByToolCall = new Map<string, CommandId>();
	const sandboxResolutionByRequest = new Map<CommandId, { profileId: string; policyDigest: string }>();
	const workspaceBindingByLease = new Map<string, {
		workspaceId: string;
		leaseRevision: number;
		bindingDigest: string;
	}>();
	const activeLeaseByWorkspace = new Map<string, string>();
	const remoteInvocationByRequest = new Map<CommandId, {
		idempotencyKey: string;
		executorId: string;
		executorKind: "ci" | "ssh" | "relay";
		invocationDigest: string;
	}>();
	const childAgentIds = new Set<string>();
	const terminalChildAgentStates: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);
	const record = (
		kind: RecoveredSideEffectKind,
		operationId: RecoveredSideEffectState["operationId"],
		state: RecoveredSideEffectState["state"],
	): void => {
		const key = `${kind}:${operationId}`;
		const previous = states.get(key)?.state;
		const next = state === "terminal"
			? "terminal"
			: previous === "terminal" || previous === "uncertain" || state === "uncertain"
				? "uncertain"
				: "not_started";
		states.set(key, { kind, operationId, state: next });
	};
	const correlateSandbox = (toolCallId: string, requestId: CommandId): ControlPlaneResult<void> => {
		const previous = sandboxRequestByToolCall.get(toolCallId);
		if (previous && previous !== requestId) {
			return recoveryRequired("tool call is correlated to conflicting sandbox request ids");
		}
		sandboxRequestByToolCall.set(toolCallId, requestId);
		return { ok: true, value: undefined };
	};
	for (const event of events) {
		switch (event.type) {
			case "artifact.intent_recorded":
			case "artifact.created": {
				const operationId = parseRuntimeId("command", event.payload.operationId);
				if (!operationId) return recoveryRequired("artifact side-effect operation id is invalid");
				record("artifact", operationId, "uncertain");
				break;
			}
			case "artifact.aborted":
			case "artifact.committed": {
				const operationId = parseRuntimeId("command", event.payload.operationId);
				if (!operationId) return recoveryRequired("artifact side-effect operation id is invalid");
				record("artifact", operationId, "terminal");
				break;
			}
			case "tool.requested": {
				const operationId = parseRuntimeId("toolCall", event.payload.toolCallId);
				if (!operationId) return recoveryRequired("tool side-effect operation id is invalid");
				record("tool", operationId, "not_started");
				break;
			}
			case "tool.authorized": {
				const operationId = parseRuntimeId("toolCall", event.payload.toolCallId);
				const requestId = parseRuntimeId("command", event.payload.requestId);
				if (!operationId || !requestId) return recoveryRequired("tool sandbox correlation is invalid");
				record("tool", operationId, "not_started");
				record("sandbox", requestId, "not_started");
				const correlated = correlateSandbox(operationId, requestId);
				if (!correlated.ok) return correlated;
				break;
			}
			case "tool.started": {
				const operationId = parseRuntimeId("toolCall", event.payload.toolCallId);
				if (!operationId) return recoveryRequired("tool side-effect operation id is invalid");
				record("tool", operationId, "uncertain");
				const requestId = sandboxRequestByToolCall.get(operationId);
				if (requestId) record("sandbox", requestId, "uncertain");
				break;
			}
			case "tool.finished": {
				const operationId = parseRuntimeId("toolCall", event.payload.toolCallId);
				if (!operationId) return recoveryRequired("tool side-effect operation id is invalid");
				record("tool", operationId, "terminal");
				break;
			}
			case "tool.interrupted":
			case "tool.failed": {
				const operationId = parseRuntimeId("toolCall", event.payload.toolCallId);
				if (!operationId) return recoveryRequired("tool side-effect operation id is invalid");
				record("tool", operationId, event.payload.outcomeCertain ? "terminal" : "uncertain");
				break;
			}
			case "sandbox.resolved": {
				const operationId = parseRuntimeId("command", event.payload.requestId);
				if (!operationId) return recoveryRequired("sandbox side-effect operation id is invalid");
				const previous = sandboxResolutionByRequest.get(operationId);
				if (
					previous &&
					(previous.profileId !== event.payload.profileId || previous.policyDigest !== event.payload.policyDigest)
				) return recoveryRequired("sandbox request is correlated to conflicting resolutions");
				sandboxResolutionByRequest.set(operationId, {
					profileId: event.payload.profileId,
					policyDigest: event.payload.policyDigest,
				});
				record("sandbox", operationId, "not_started");
				break;
			}
			case "sandbox.execution_recorded": {
				const operationId = parseRuntimeId("command", event.payload.requestId);
				if (!operationId) return recoveryRequired("sandbox side-effect operation id is invalid");
				const resolution = sandboxResolutionByRequest.get(operationId);
				if (
					!resolution ||
					event.payload.receipt.requestId !== operationId ||
					event.payload.receipt.profileId !== resolution.profileId ||
					event.payload.receipt.policyDigest !== resolution.policyDigest ||
					event.payload.receipt.invocationDigest !== event.payload.invocationDigest ||
					event.payload.receipt.authorityId !== event.authorityId ||
					event.payload.receipt.tenantId !== event.tenantId ||
					event.payload.receipt.principalId !== event.principalId
				) return recoveryRequired("sandbox execution receipt is not correlated to its durable resolution");
				record("sandbox", operationId, "terminal");
				if (event.payload.toolCallId) {
					const toolCallId = parseRuntimeId("toolCall", event.payload.toolCallId);
					if (!toolCallId) return recoveryRequired("sandbox tool correlation id is invalid");
					const correlated = correlateSandbox(toolCallId, operationId);
					if (!correlated.ok) return correlated;
				}
				break;
			}
			case "workspace.bound": {
				const workspaceId = parseRuntimeId("workspace", event.payload.binding.workspaceId);
				const operationId = parseRuntimeId("lease", event.payload.lease.leaseId);
				if (
					!workspaceId ||
					!operationId ||
					event.payload.lease.workspaceId !== workspaceId ||
					event.payload.binding.authorityId !== event.authorityId ||
					event.payload.binding.tenantId !== event.tenantId ||
					event.payload.lease.authorityId !== event.authorityId ||
					event.payload.lease.tenantId !== event.tenantId ||
					event.payload.lease.principalId !== event.principalId ||
					event.payload.bindingDigest !== canonicalDigest(event.payload.binding)
				) return recoveryRequired("workspace binding and lease correlation is invalid");
				workspaceBindingByLease.set(operationId, {
					workspaceId,
					leaseRevision: event.payload.lease.leaseRevision,
					bindingDigest: event.payload.bindingDigest,
				});
				activeLeaseByWorkspace.set(workspaceId, operationId);
				record("workspace", operationId, "uncertain");
				break;
			}
			case "workspace.validation_recorded": {
				const workspaceId = parseRuntimeId("workspace", event.payload.validation.workspaceId);
				const leaseId = workspaceId ? activeLeaseByWorkspace.get(workspaceId) : undefined;
				const operationId = leaseId ? parseRuntimeId("lease", leaseId) : undefined;
				if (
					!workspaceId ||
					!operationId ||
					event.payload.validation.authorityId !== event.authorityId ||
					event.payload.validation.tenantId !== event.tenantId ||
					event.payload.validation.principalId !== event.principalId
				) return recoveryRequired("workspace validation has no active scoped lease correlation");
				record("workspace", operationId, "uncertain");
				break;
			}
			case "workspace.released": {
				const workspaceId = parseRuntimeId("workspace", event.payload.workspaceId);
				const operationId = parseRuntimeId("lease", event.payload.leaseId);
				const binding = operationId ? workspaceBindingByLease.get(operationId) : undefined;
				if (
					!workspaceId ||
					!operationId ||
					!binding ||
					binding.workspaceId !== workspaceId ||
					binding.leaseRevision !== event.payload.leaseRevision ||
					binding.bindingDigest !== event.payload.bindingDigest
				) return recoveryRequired("workspace release is not correlated to its durable binding lease");
				record("workspace", operationId, "terminal");
				if (activeLeaseByWorkspace.get(workspaceId) === operationId) activeLeaseByWorkspace.delete(workspaceId);
				break;
			}
			case "executor.requested": {
				const operationId = parseRuntimeId("command", event.payload.requestId);
				const executorId = parseRuntimeId("resource", event.payload.executorId);
				if (!operationId || !executorId) return recoveryRequired("remote executor operation correlation is invalid");
				const previous = remoteInvocationByRequest.get(operationId);
				if (
					previous &&
					(previous.idempotencyKey !== event.payload.idempotencyKey ||
						previous.executorId !== executorId ||
						previous.executorKind !== event.payload.executorKind ||
						previous.invocationDigest !== event.payload.invocationDigest)
				) return recoveryRequired("remote executor request id is correlated to conflicting invocations");
				remoteInvocationByRequest.set(operationId, {
					idempotencyKey: event.payload.idempotencyKey,
					executorId,
					executorKind: event.payload.executorKind,
					invocationDigest: event.payload.invocationDigest,
				});
				record("remote_executor", operationId, "uncertain");
				break;
			}
			case "executor.execution_recorded": {
				const operationId = parseRuntimeId("command", event.payload.requestId);
				const invocation = operationId ? remoteInvocationByRequest.get(operationId) : undefined;
				if (
					!operationId ||
					!invocation ||
					invocation.executorId !== event.payload.executorId ||
					invocation.executorKind !== event.payload.executorKind ||
					invocation.invocationDigest !== event.payload.invocationDigest
				) return recoveryRequired("remote executor receipt is not correlated to its durable invocation");
				record(
					"remote_executor",
					operationId,
					event.payload.status === "uncertain" ? "uncertain" : "terminal",
				);
				break;
			}
			case "agent.spawned": {
				if (!event.payload.node.parentAgentId) break;
				const operationId = parseRuntimeId("agent", event.payload.node.agentId);
				if (!operationId) return recoveryRequired("child agent side-effect operation id is invalid");
				childAgentIds.add(operationId);
				record("child_agent", operationId, "uncertain");
				break;
			}
			case "agent.transitioned": {
				const operationId = parseRuntimeId("agent", event.payload.agentId);
				if (!operationId) return recoveryRequired("child agent transition correlation id is invalid");
				if (childAgentIds.has(operationId)) {
					record(
						"child_agent",
						operationId,
						terminalChildAgentStates.has(event.payload.to) ? "terminal" : "uncertain",
					);
				}
				break;
			}
			case "agent.stopped":
			case "agent.partial_committed":
			case "agent.finished":
			case "agent.failed": {
				const operationId = parseRuntimeId("agent", event.payload.agentId);
				if (!operationId) return recoveryRequired("child agent terminal correlation id is invalid");
				if (childAgentIds.has(operationId)) record("child_agent", operationId, "terminal");
				break;
			}
			default:
				break;
		}
	}
	return {
		ok: true,
		value: [...states.values()].sort((left, right) =>
			left.kind.localeCompare(right.kind) || left.operationId.localeCompare(right.operationId)
		),
	};
}

function recoveryState(evidence: V3SessionEvidence): DaemonSessionRecoveryState {
	if (evidence.decision.kind === "corrupted") return "corrupted";
	if (evidence.decision.kind === "pause_for_approval") return "pause_for_approval";
	if (evidence.decision.kind === "stopped") {
		return evidence.projection?.lifecycle === "closed" ? "closed" : "stopped";
	}
	return "resume";
}

export interface V3RecoveryActivationPort {
	activate(restored: RestoredDaemonSession): Promise<ControlPlaneResult<void>>;
}

export interface V3DaemonRuntimeRecoveryPortAdapterOptions {
	evidence: V3SessionEvidenceReader;
	activation: V3RecoveryActivationPort;
}

/** restoreProjection 只做 strict scan + reducer；真正激活必须由显式 lifecycle owner 注入。 */
export class V3DaemonRuntimeRecoveryPortAdapter implements DaemonRuntimeRecoveryPort {
	readonly #evidence: V3SessionEvidenceReader;
	readonly #activation: V3RecoveryActivationPort;

	public constructor(options: V3DaemonRuntimeRecoveryPortAdapterOptions) {
		this.#evidence = options.evidence;
		this.#activation = options.activation;
	}

	public async discover(): Promise<ControlPlaneResult<readonly DaemonSessionRecoveryDescriptor[]>> {
		const locations = await this.#evidence.locator().list();
		if (!locations.ok) return locations;
		const descriptors: DaemonSessionRecoveryDescriptor[] = [];
		for (const location of locations.value) {
			const evidence = await this.#evidence.read(location.sessionId);
			if (!evidence.ok) return evidence;
			const sideEffects = recoveredSideEffects(evidence.value.events);
			if (!sideEffects.ok) return sideEffects;
			descriptors.push({
				sessionId: location.sessionId,
				state: recoveryState(evidence.value),
				sideEffects: sideEffects.value,
			});
		}
		return { ok: true, value: descriptors };
	}

	public async restoreProjection(
		descriptor: DaemonSessionRecoveryDescriptor,
		mode: RestoredDaemonSession["mode"],
	): Promise<ControlPlaneResult<RestoredDaemonSession>> {
		if (!isRuntimeId(descriptor.sessionId, "session")) {
			return controlPlaneFailure("invalid_request", "recovery descriptor session id is invalid");
		}
		const evidence = await this.#evidence.read(descriptor.sessionId);
		if (!evidence.ok) return evidence;
		const actualState = recoveryState(evidence.value);
		const actualSideEffects = recoveredSideEffects(evidence.value.events);
		if (!actualSideEffects.ok) return actualSideEffects;
		if (
			actualState !== descriptor.state ||
			canonicalDigest(actualSideEffects.value) !== canonicalDigest(descriptor.sideEffects)
		) return recoveryRequired("recovery descriptor is stale relative to the durable v3 event log");
		const hasNonTerminalSideEffects = actualSideEffects.value.some((effect) => effect.state !== "terminal");
		let expectedMode: RestoredDaemonSession["mode"] = "read_only";
		if (actualState === "resume") expectedMode = hasNonTerminalSideEffects ? "paused" : "active_candidate";
		else if (actualState === "pause_for_approval") expectedMode = "paused";
		if (mode !== expectedMode) return recoveryRequired("requested recovery mode is unsafe for the durable session state");
		return {
			ok: true,
			value: {
				sessionId: descriptor.sessionId,
				projectionDigest: evidence.value.projection?.projectionDigest ?? canonicalDigest({
					sessionId: descriptor.sessionId,
					state: "corrupted",
					eventCount: evidence.value.events.length,
				}),
				mode,
			},
		};
	}

	public activate(restored: RestoredDaemonSession): Promise<ControlPlaneResult<void>> {
		if (
			!isRuntimeId(restored.sessionId, "session") ||
			restored.mode !== "active_candidate" ||
			!/^[a-f0-9]{64}$/.test(restored.projectionDigest)
		) return Promise.resolve(recoveryRequired("only a validated active recovery candidate may be activated"));
		return this.#activation.activate(restored);
	}
}
