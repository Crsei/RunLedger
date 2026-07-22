/** V3SessionManager 与 Phase 11 lifecycle/telemetry/GC 的生产 composition adapter。 */

import { readFile, rm } from "node:fs/promises";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	type ArtifactId,
	type AuthorityId,
	type RuntimeInstanceId,
	type SessionId,
	type TenantId,
} from "../runtime/protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../runtime/protocol/v3/schemas.ts";
import { CanonicalEventExternalReferenceSource } from "../runtime/lifecycle/canonical-references.ts";
import {
	ContinuousExternalReceiptMutationGate,
	type SessionMutationAdmissionGatePort,
} from "../runtime/lifecycle/mutation-gate.ts";
import {
	RuntimeGcCoordinator,
	type RuntimeGcMutationPort,
	type RuntimeGcMutationReceipt,
} from "../runtime/lifecycle/gc.ts";
import type { LifecycleResult, StartupExternalReceiptAuditPort } from "../runtime/lifecycle/recovery.ts";
import {
	RuntimeShutdownCoordinator,
	type RuntimeDrainParticipant,
	type RuntimeShutdownReceipt,
	type RuntimeShutdownTrigger,
} from "../runtime/lifecycle/shutdown.ts";
import {
	StartupRecoveryCoordinator,
	type StartupRecoveryReport,
	type StartupSessionReport,
} from "../runtime/lifecycle/startup.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import {
	projectCostTraceFromCanonicalEvents,
	projectRuntimeActivityFromCanonicalEvents,
} from "../runtime/telemetry/canonical-events.ts";
import type { RuntimeActivityState } from "../runtime/telemetry/activity.ts";
import type { CostTrace } from "../runtime/telemetry/cost.ts";
import type { TelemetryResult } from "../runtime/telemetry/types.ts";
import type { RuntimeIdentityContext } from "../runtime/identity/types.ts";
import type { RuntimeFeatureFlags } from "../runtime/runtime-features.ts";
import { V3SessionManager } from "./v3-session-manager.ts";

export interface GovernedV3SessionOpenOptions {
	filePath: string;
	features: Readonly<RuntimeFeatureFlags>;
	identity?: RuntimeIdentityContext;
	runtimeId?: RuntimeInstanceId;
	externalReceiptAuditor: StartupExternalReceiptAuditPort;
	externalReceiptAuditTimeoutMs?: number;
	signal?: AbortSignal;
	clock?: () => Date;
}

export function createV3SessionMutationAdmissionGate(
	manager: V3SessionManager,
	auditor: StartupExternalReceiptAuditPort,
	options: {
		clock?: () => Date;
		externalReceiptAuditTimeoutMs?: number;
		externalReceiptScanTimeoutMs?: number;
	} = {},
): ContinuousExternalReceiptMutationGate {
	const identity = manager.identity();
	return new ContinuousExternalReceiptMutationGate({
		references: new CanonicalEventExternalReferenceSource(manager.eventStore(), {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: manager.sessionId(),
		}),
		auditor,
		scope: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sessionId: manager.sessionId(),
		},
		currentHead: () => manager.writer().currentHead(),
		...(options.clock === undefined ? {} : { clock: options.clock }),
		...(options.externalReceiptAuditTimeoutMs === undefined
			? {}
			: { externalOperationTimeoutMs: options.externalReceiptAuditTimeoutMs }),
		...(options.externalReceiptScanTimeoutMs === undefined
			? {}
			: { externalScanTimeoutMs: options.externalReceiptScanTimeoutMs }),
	});
}

export interface V3SessionTelemetryProjection {
	activity: RuntimeActivityState;
	cost: CostTrace;
	projectedThroughSequence: number;
	projectedEventHash: string;
}

export interface SessionReferenceInspection {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	referenceCount: number;
	activity: "inactive" | "active" | "unknown";
	inspectedAt: string;
	receiptDigest: string;
}

export interface SessionReferenceProjectionPort {
	inspect(
		authorityId: AuthorityId,
		tenantId: TenantId,
		sessionId: SessionId,
	): Promise<LifecycleResult<SessionReferenceInspection>>;
}

function lifecycleFailure(
	code: "invalid_request" | "integrity_failed" | "external_unavailable" | "mutation_failed",
	message: string,
	retryable = false,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function telemetryFailure(message: string): TelemetryResult<never> {
	return { ok: false, error: { code: "invalid_schema", message, retryable: false } };
}

function validReferenceInspection(
	value: SessionReferenceInspection,
	scope: { authorityId: AuthorityId; tenantId: TenantId; sessionId: SessionId },
): boolean {
	if (
		value.authorityId !== scope.authorityId ||
		value.tenantId !== scope.tenantId ||
		value.sessionId !== scope.sessionId ||
		!Number.isSafeInteger(value.referenceCount) ||
		value.referenceCount < 0 ||
		!Number.isFinite(Date.parse(value.inspectedAt)) ||
		!/^[a-f0-9]{64}$/.test(value.receiptDigest)
	) return false;
	const { receiptDigest, ...body } = value;
	return canonicalDigest(body) === receiptDigest;
}

function startupCandidate(manager: V3SessionManager) {
	const identity = manager.identity();
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: manager.sessionId(),
		sessionDirectory: manager.stateDirectory(),
		store: manager.eventStore(),
		snapshotFilePath: `${manager.stateDirectory()}/snapshot.json`,
	};
}

function reconciliationIsSafe(report: StartupRecoveryReport): boolean {
	const session = report.sessions[0];
	if (!session || session.disposition === "corrupted" || session.disposition === "stopped") return false;
	return session.disposition === "resumable" ||
		session.reasons.every((reason) => reason === "pending_artifact_intent");
}

function withArtifactFailure(report: StartupRecoveryReport): StartupRecoveryReport {
	const sessions = report.sessions.map((session): StartupSessionReport => session.disposition === "corrupted" || session.disposition === "stopped"
		? session
		: {
			...session,
			disposition: "paused",
			reasons: [...new Set([...session.reasons, "artifact_reconciliation_failed" as const])].sort(),
		});
	return {
		...report,
		sessions,
		resumableSessionIds: [],
		pausedSessionIds: sessions.filter((session) => session.disposition === "paused").map((session) => session.sessionId),
	};
}

function withArtifactReconciliationSuccess(report: StartupRecoveryReport): StartupRecoveryReport {
	const sessions = report.sessions.map((session): StartupSessionReport => {
		if (session.disposition === "corrupted" || session.disposition === "stopped") return session;
		const reasons = session.reasons.filter((reason) => reason !== "pending_artifact_intent");
		return {
			...session,
			disposition: reasons.length === 0 ? "resumable" : "paused",
			reasons,
		};
	});
	return {
		...report,
		sessions,
		resumableSessionIds: sessions.filter((session) => session.disposition === "resumable").map((session) => session.sessionId),
		pausedSessionIds: sessions.filter((session) => session.disposition === "paused").map((session) => session.sessionId),
	};
}

function cloneStartupReport(report: StartupRecoveryReport): StartupRecoveryReport {
	return structuredClone(report);
}

function auditReceiptsRemainValid(report: StartupSessionReport, now: Date): boolean {
	const nowMs = now.getTime();
	return report.auditReceipts.every((receipt) =>
		receipt.status !== "valid" || receipt.validThrough === null || Date.parse(receipt.validThrough) > nowMs);
}

/**
 * Governed open 不直接返回裸 manager：只有 startup report 为 resumable 时才调用 runIfResumable。
 * paused/stopped/corrupted 会保留 canonical state，但不会重放 tool/child 等副作用。
 */
export class GovernedV3SessionRuntime {
	readonly #manager: V3SessionManager;
	readonly #startup: StartupRecoveryReport;
	readonly #clock: () => Date;
	readonly #mutationGate: SessionMutationAdmissionGatePort;
	#shutdown: RuntimeShutdownCoordinator | undefined;
	#admissionConsumed = false;

	private constructor(
		manager: V3SessionManager,
		startup: StartupRecoveryReport,
		clock: () => Date,
		mutationGate: SessionMutationAdmissionGatePort,
	) {
		this.#manager = manager;
		this.#startup = cloneStartupReport(startup);
		this.#clock = clock;
		this.#mutationGate = mutationGate;
	}

	public static async open(options: GovernedV3SessionOpenOptions): Promise<GovernedV3SessionRuntime> {
		const clock = options.clock ?? (() => new Date());
		const manager = await V3SessionManager.open(
			options.filePath,
			options.features,
			options.identity,
			{
				reconcileArtifacts: false,
				...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
			},
		);
		try {
			const identity = manager.identity();
			const references = new CanonicalEventExternalReferenceSource(manager.eventStore(), {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				sessionId: manager.sessionId(),
			});
			const coordinator = new StartupRecoveryCoordinator({
				references,
				auditor: options.externalReceiptAuditor,
				clock,
				...(options.externalReceiptAuditTimeoutMs === undefined
					? {}
					: { externalOperationTimeoutMs: options.externalReceiptAuditTimeoutMs }),
			});
			let startup = await coordinator.scan([startupCandidate(manager)], options.signal);
			if (reconciliationIsSafe(startup)) {
				const reconciliation = await manager.reconcileArtifacts();
				startup = reconciliation.ok && reconciliation.value.failed.length === 0
					? withArtifactReconciliationSuccess(startup)
					: withArtifactFailure(startup);
			}
			return new GovernedV3SessionRuntime(
				manager,
				startup,
				clock,
				createV3SessionMutationAdmissionGate(manager, options.externalReceiptAuditor, {
					clock,
					...(options.externalReceiptAuditTimeoutMs === undefined
						? {}
						: { externalReceiptAuditTimeoutMs: options.externalReceiptAuditTimeoutMs }),
				}),
			);
		} catch (cause) {
			try {
				await manager.closeAll();
			} catch (cleanupError) {
				throw new AggregateError(
					[cause, cleanupError],
					"governed V3 session startup failed and cleanup was incomplete",
				);
			}
			throw cause;
		}
	}

	public sessionId(): SessionId { return this.#manager.sessionId(); }
	public filePath(): string { return this.#manager.filePath(); }
	public startupReport(): StartupRecoveryReport { return cloneStartupReport(this.#startup); }
	public mutationGate(): SessionMutationAdmissionGatePort { return this.#mutationGate; }
	public isClosed(): boolean { return this.#manager.isClosed(); }
	public close(): Promise<void> { return this.#manager.closeAll(); }

	#claimAdmission(): boolean {
		if (this.#admissionConsumed) return false;
		this.#admissionConsumed = true;
		return true;
	}

	public async runIfResumable<T>(operation: (manager: V3SessionManager) => Promise<T>): Promise<LifecycleResult<T>> {
		const report = this.#startup.sessions[0];
		if (
			!report ||
			report.disposition !== "resumable" ||
			!auditReceiptsRemainValid(report, this.#clock()) ||
			this.#manager.isClosed() ||
			!this.#claimAdmission()
		) {
			return lifecycleFailure("external_unavailable", "v3 session is not approved for side-effect replay");
		}
		try {
			return { ok: true, value: await operation(this.#manager) };
		} catch (cause) {
			return lifecycleFailure("mutation_failed", cause instanceof Error ? cause.message : "v3 session operation failed", true);
		}
	}

	/** partial legacy migration 只能在外部审计通过且唯一 pause 原因为该 migration 自身时显式续跑。 */
	public async runIfMigrationRecoveryApproved<T>(
		operation: (manager: V3SessionManager) => Promise<T>,
	): Promise<LifecycleResult<T>> {
		const report = this.#startup.sessions[0];
		const recovery = this.#manager.recoveryDecision();
		if (
			!report ||
			report.disposition !== "paused" ||
			report.reasons.length !== 1 ||
			report.reasons[0] !== "uncertain_operation" ||
			!report.checks.includes("external_receipts") ||
			!auditReceiptsRemainValid(report, this.#clock()) ||
			!recovery ||
			recovery.kind !== "pause_for_approval" ||
			recovery.projection.migration?.status !== "in_progress" ||
			this.#manager.isClosed() ||
			!this.#claimAdmission()
		) {
			return lifecycleFailure("external_unavailable", "v3 migration recovery is not approved by governed startup");
		}
		try {
			return { ok: true, value: await operation(this.#manager) };
		} catch (cause) {
			return lifecycleFailure("mutation_failed", cause instanceof Error ? cause.message : "v3 migration recovery failed", true);
		}
	}

	public async telemetryProjection(): Promise<TelemetryResult<V3SessionTelemetryProjection>> {
		const replay = await readAllRuntimeEvents(this.#manager.eventStore());
		if (!replay.ok) return telemetryFailure("v3 telemetry replay failed");
		const activity = projectRuntimeActivityFromCanonicalEvents(replay.value);
		if (!activity.ok) return telemetryFailure(activity.error.message);
		const cost = projectCostTraceFromCanonicalEvents(replay.value);
		if (!cost.ok) return cost;
		const head = replay.value.at(-1);
		if (!head) return telemetryFailure("v3 telemetry replay is empty");
		return {
			ok: true,
			value: {
				activity: activity.value,
				cost: cost.value,
				projectedThroughSequence: head.sequence,
				projectedEventHash: head.currentEventHash,
			},
		};
	}

	public shutdown(
		trigger: RuntimeShutdownTrigger,
		timeoutMs: number,
		participants: readonly RuntimeDrainParticipant[] = [],
	): Promise<LifecycleResult<RuntimeShutdownReceipt>> {
		if (!this.#shutdown) {
			const identity = this.#manager.identity();
			this.#shutdown = new RuntimeShutdownCoordinator({
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				runtimeId: this.#manager.runtimeId(),
			}, this.#clock);
			for (const participant of participants) {
				const registered = this.#shutdown.register(participant);
				if (!registered.ok) return Promise.resolve(registered);
			}
			const writer = this.#shutdown.register({
				id: "v3-session-writer",
				kind: "writer",
				drain: async () => this.#manager.closeAll(),
			});
			if (!writer.ok) return Promise.resolve(writer);
		}
		return this.#shutdown.shutdown(trigger, timeoutMs);
	}

	public gcMutations(references: SessionReferenceProjectionPort): V3SessionRuntimeGcMutationAdapter {
		return new V3SessionRuntimeGcMutationAdapter(this.#manager, references, this.#clock);
	}
}

/** mutation adapter 在真正删除前再次读取 manager scope、Artifact metadata 与 session refs。 */
export class V3SessionRuntimeGcMutationAdapter implements RuntimeGcMutationPort {
	readonly #manager: V3SessionManager;
	readonly #references: SessionReferenceProjectionPort;
	readonly #clock: () => Date;

	public constructor(manager: V3SessionManager, references: SessionReferenceProjectionPort, clock: () => Date = () => new Date()) {
		this.#manager = manager;
		this.#references = references;
		this.#clock = clock;
	}

	#scopeMatches(authorityId: AuthorityId, tenantId: TenantId): boolean {
		const identity = this.#manager.identity();
		return identity.authorityId === authorityId && identity.tenantId === tenantId;
	}

	#receipt(targetKind: RuntimeGcMutationReceipt["targetKind"], targetId: string): RuntimeGcMutationReceipt {
		const deletedAt = this.#clock().toISOString();
		const mutationDigest = canonicalDigest({
			authorityId: this.#manager.identity().authorityId,
			tenantId: this.#manager.identity().tenantId,
			targetKind,
			targetId,
			deletedAt,
		});
		return {
			receiptId: createRuntimeId("receipt", `gc-${mutationDigest.slice(0, 32)}`),
			targetKind,
			targetId,
			mutationDigest,
			deletedAt,
		};
	}

	public async deleteArtifactRef(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>> {
		if (!this.#scopeMatches(authorityId, tenantId)) {
			return lifecycleFailure("invalid_request", "artifact GC scope does not match the v3 session");
		}
		const collected = await this.#manager.collectArtifactGarbage({
			dryRun: false,
			now: this.#clock(),
			artifactIds: [artifactId],
		});
		if (!collected.ok) return lifecycleFailure("mutation_failed", collected.error.message, collected.error.retryable);
		if (!collected.value.deletedArtifactIds.includes(artifactId)) {
			return lifecycleFailure("mutation_failed", "artifact metadata retained the requested reference");
		}
		return { ok: true, value: this.#receipt("artifact_ref", artifactId) };
	}

	public async deleteSessionRef(
		authorityId: AuthorityId,
		tenantId: TenantId,
		sessionId: SessionId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>> {
		if (!this.#scopeMatches(authorityId, tenantId) || sessionId !== this.#manager.sessionId()) {
			return lifecycleFailure("invalid_request", "session GC scope does not match the v3 session");
		}
		if (!this.#manager.isClosed()) {
			return lifecycleFailure("external_unavailable", "session writer activity is not inactive", true);
		}
		let inspected: LifecycleResult<SessionReferenceInspection>;
		try {
			inspected = await this.#references.inspect(authorityId, tenantId, sessionId);
		} catch {
			return lifecycleFailure("external_unavailable", "session reference projection is unavailable", true);
		}
		if (!inspected.ok || !validReferenceInspection(inspected.value, { authorityId, tenantId, sessionId })) {
			return lifecycleFailure("external_unavailable", "session reference receipt is invalid or unavailable", true);
		}
		if (inspected.value.activity !== "inactive" || inspected.value.referenceCount > 0) {
			return lifecycleFailure("mutation_failed", "session is active, unknown, or still referenced");
		}
		const artifacts = await this.#manager.listCommittedArtifacts();
		if (!artifacts.ok) return lifecycleFailure("mutation_failed", artifacts.error.message, artifacts.error.retryable);
		if (artifacts.value.length > 0) {
			return lifecycleFailure("mutation_failed", "session retains Artifact refs and must run Artifact GC first");
		}
		try {
			const firstLine = (await readFile(this.#manager.filePath(), "utf8")).split("\n", 1)[0];
			const parsed: unknown = firstLine ? JSON.parse(firstLine) as unknown : undefined;
			const genesis = validateRuntimeEvent(parsed);
			if (!genesis.ok || genesis.value.sequence !== 0 || genesis.value.authorityId !== authorityId ||
				genesis.value.tenantId !== tenantId || genesis.value.stream.scope !== "session" ||
				genesis.value.stream.sessionId !== sessionId) {
				return lifecycleFailure("integrity_failed", "session GC genesis scope validation failed");
			}
			await rm(this.#manager.filePath(), { force: false });
			await rm(this.#manager.stateDirectory(), { recursive: true, force: true });
			return { ok: true, value: this.#receipt("session_ref", sessionId) };
		} catch (cause) {
			return lifecycleFailure("mutation_failed", cause instanceof Error ? cause.message : "session ref deletion failed", true);
		}
	}
}

export function composeV3RuntimeGc(
	manager: V3SessionManager,
	references: SessionReferenceProjectionPort,
	clock: () => Date = () => new Date(),
): RuntimeGcCoordinator {
	return new RuntimeGcCoordinator(new V3SessionRuntimeGcMutationAdapter(manager, references, clock), clock);
}
