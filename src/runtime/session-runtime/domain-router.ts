import { createRuntimeId, type SessionId } from "../protocol/ids.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { OwnerFence } from "../session-owner/types.ts";

export const SESSION_DOMAIN_RESULT_STATUSES = [
	"ok",
	"unavailable",
	"denied",
	"stale",
	"failed",
	"recovery_required",
] as const;
export type SessionDomainResultStatus = (typeof SESSION_DOMAIN_RESULT_STATUSES)[number];

export interface SessionDomainEnvelope {
	readonly sessionId: SessionId;
	readonly generation: number;
	readonly correlationId: string;
	readonly effectId: string;
	readonly operation: string;
	readonly payload: Record<string, unknown>;
}

export interface SessionDomainRequestContext {
	readonly correlationId: string;
	readonly effectId: string;
}

export interface SessionDomainMutationContext extends SessionDomainRequestContext {
	readonly expectedRevision: number;
}

export interface SessionDomainRouterOptions {
	/** The owner fence is required for durable title mutation; tests without it cannot write titles. */
	readonly ownerFence?: OwnerFence;
	/** 只由真实 Session domain composition 注入的安全投影。 */
	readonly securityInspection?: () => Record<string, unknown>;
	/** 只由 Session-owned Plan projection 注入的只读状态。 */
	readonly planInspection?: () => SessionPlanInspection;
	/** Async domain consumers register their exact manifest here; execution is routed by SessionRuntime. */
	readonly additionalOperations?: readonly SessionProtocolOperationDescriptor[];
}

export type SessionDomainResult =
	| {
			readonly ok: true;
			readonly status: "ok";
			readonly operation: string;
			readonly domainRevision: number;
			readonly value: Record<string, unknown>;
			readonly receipt?: {
				readonly attemptId: string;
				readonly commandId: string;
				readonly outcome: "committed";
			};
	  }
	| {
			readonly ok: false;
			readonly status: Exclude<SessionDomainResultStatus, "ok">;
			readonly code: string;
			readonly operation: string;
			readonly currentRevision?: number;
	  };

/** S1:Session-scoped domain operation 的唯一命名路由入口。 */
export class SessionDomainRouter {
	private readonly sessionId: SessionId;
	private readonly generation: number;
	private readonly store: SessionStore;
	private readonly attempts: AttemptPort;
	private readonly securityInspection: SessionDomainRouterOptions["securityInspection"];
	private readonly planInspection: SessionDomainRouterOptions["planInspection"];
	private readonly ownerFence: OwnerFence | undefined;

	public readonly operationManifest: readonly SessionProtocolOperationDescriptor[];

	public constructor(sessionId: SessionId, generation: number, store: SessionStore, attempts: AttemptPort, options: SessionDomainRouterOptions = {}) {
		this.sessionId = sessionId;
		this.generation = generation;
		this.store = store;
		this.attempts = attempts;
		this.securityInspection = options.securityInspection;
		this.planInspection = options.planInspection;
		this.ownerFence = options.ownerFence;
		this.operationManifest = Object.freeze([
			Object.freeze({ operation: "session.catalog.list", capability: "session.catalog", access: "read" }),
			Object.freeze({ operation: "session.create", capability: "session.catalog", access: "mutate" }),
			Object.freeze({ operation: "session.resume", capability: "session.catalog", access: "mutate" }),
			Object.freeze({ operation: "session.fork", capability: "session.catalog", access: "mutate" }),
			Object.freeze({ operation: "session.title.set", capability: "session.catalog", access: "mutate" }),
			...(this.securityInspection === undefined
				? []
				: [Object.freeze({ operation: "session.security.inspect", capability: "session.security.inspect", access: "read" })]),
			...(this.planInspection === undefined
				? []
				: [Object.freeze({ operation: "plan.inspect", capability: "session.plan", access: "read" })]),
			...(options.additionalOperations ?? []).map((entry) => Object.freeze({ ...entry })),
		]);
	}

	public query(input: Record<string, unknown>): SessionDomainResult {
		const operation = typeof input.operation === "string" ? input.operation : "unknown";
		if (input.sessionId !== this.sessionId || input.generation !== this.generation) {
			return {
				ok: false,
				status: "stale",
				code: "generation_mismatch",
				operation,
			};
		}
		if (!validEnvelope(input)) {
			return { ok: false, status: "failed", code: "invalid_domain_envelope", operation };
		}
			if (operation === "session.catalog.list") {
				const sessions = this.store.listSessions();
				return {
				ok: true,
				status: "ok",
				operation,
					domainRevision: this.store.catalogRevision(),
				value: {
					items: sessions.map((session) => ({
						sessionId: session.sessionId,
						workspaceId: session.workspaceId,
						repositoryId: session.repositoryId,
						status: session.status,
						createdAtMs: session.createdAtMs,
						updatedAtMs: session.updatedAtMs,
						headSequence: session.headSequence,
							driverRevision: session.driverRevision,
						title: session.title,
						titleSource: session.titleSource,
						titleUpdatedAtMs: session.titleUpdatedAtMs,
						firstUserMessagePreview: session.firstUserMessagePreview,
						current: session.sessionId === this.sessionId,
					})),
				},
			};
		}
		if (operation === "session.security.inspect" && this.securityInspection !== undefined) {
			return {
				ok: true,
				status: "ok",
				operation,
				domainRevision: this.generation,
				value: this.securityInspection(),
			};
		}
		if (operation === "plan.inspect" && this.planInspection !== undefined) {
			const value = this.planInspection();
			return {
				ok: true,
				status: "ok",
				operation,
				domainRevision: value.state.revision,
				value,
			};
		}
		return {
			ok: false,
			status: "unavailable",
			code: "operation_unavailable",
			operation,
		};
	}

	public mutate(input: Record<string, unknown>, isDriver: boolean): SessionDomainResult {
		const operation = typeof input.operation === "string" ? input.operation : "unknown";
		if (input.sessionId !== this.sessionId || input.generation !== this.generation) {
			return { ok: false, status: "stale", code: "generation_mismatch", operation };
		}
		if (!isDriver) {
			return { ok: false, status: "denied", code: "driver_required", operation };
		}
		if (!validEnvelope(input)) {
			return { ok: false, status: "failed", code: "invalid_domain_envelope", operation };
		}
		if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
			return { ok: false, status: "failed", code: "invalid_expected_revision", operation };
		}
		if (operation === "session.title.set") {
				const currentRevision = this.store.catalogRevision();
			if (input.expectedRevision !== currentRevision) {
				return { ok: false, status: "stale", code: "domain_revision_conflict", operation, currentRevision };
			}
			if (this.ownerFence === undefined) {
				return { ok: false, status: "failed", code: "owner_fence_unavailable", operation, currentRevision };
			}
			const payload = recordValue(input.payload);
			const title = typeof payload.title === "string" ? payload.title : undefined;
			if (title === undefined || title.length === 0) {
				return { ok: false, status: "failed", code: "title_required", operation, currentRevision };
			}
			if (payload.source !== undefined && payload.source !== "user") {
				return { ok: false, status: "denied", code: "auto_title_internal_only", operation, currentRevision };
			}
			const expectedTitle = payload.expectedTitle === null || typeof payload.expectedTitle === "string" ? payload.expectedTitle : undefined;
			const begun = this.attempts.beginAttempt("workspace_mutation", runtimeDigest({
				operation,
				correlationId: input.correlationId,
				effectId: input.effectId,
				titleDigest: runtimeDigest(title).digest,
				expectedRevision: input.expectedRevision,
			}));
			if ("error" in begun) {
				return {
					ok: false,
					status: begun.error === "recovery_barrier_active" ? "recovery_required" : "failed",
					code: begun.error,
					operation,
					currentRevision,
				};
			}
			try {
					const titled = this.store.setTitle(this.ownerFence, {
						title,
						source: "user",
						trigger: "manual-rename",
						...(expectedTitle === undefined ? {} : { expectedTitle }),
						expectedCatalogRevision: input.expectedRevision,
					});
					const nextRevision = this.store.catalogRevision();
				const settled = this.attempts.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, sessionId: titled.sessionId, titleDigest: runtimeDigest(titled.title ?? "").digest }));
				if (!settled.ok) return { ok: false, status: "failed", code: settled.code, operation, currentRevision };
				return {
					ok: true,
					status: "ok",
					operation,
						domainRevision: nextRevision,
					value: {
						sessionId: titled.sessionId,
						title: titled.title,
						titleSource: titled.titleSource,
						titleUpdatedAtMs: titled.titleUpdatedAtMs,
					},
					receipt: { attemptId: begun.attemptId, commandId: begun.commandId, outcome: "committed" },
				};
			} catch (error) {
				const code = error instanceof Error && "code" in error ? String((error as { readonly code?: unknown }).code) : "session_title_failed";
				const settled = this.attempts.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ operation, code }));
					return {
						ok: false,
						status: code === "title_conflict" || code === "catalog_revision_conflict" ? "stale" : "failed",
						code: settled.ok ? code : settled.code,
						operation,
						currentRevision: this.store.catalogRevision(),
					};
				}
			}
		if (operation === "session.create") {
			const currentRevision = this.store.catalogRevision();
			if (input.expectedRevision !== currentRevision) {
				return {
					ok: false,
					status: "stale",
					code: "domain_revision_conflict",
					operation,
					currentRevision,
				};
			}
			const source = this.store.getSession(this.sessionId);
			if (source === undefined) {
				return { ok: false, status: "failed", code: "session_not_found", operation };
			}
			const begun = this.attempts.beginAttempt("workspace_mutation", runtimeDigest({
				operation,
				correlationId: input.correlationId,
				effectId: input.effectId,
				expectedRevision: input.expectedRevision,
			}));
			if ("error" in begun) {
				return {
					ok: false,
					status: begun.error === "recovery_barrier_active" ? "recovery_required" : "failed",
					code: begun.error,
					operation,
					currentRevision,
				};
			}
			try {
				const targetSessionId = createRuntimeId("session", `new-${Date.now().toString(36)}-${String(input.effectId).slice(-24)}`);
				this.store.createSession({
					sessionId: targetSessionId,
					workspaceId: source.workspaceId,
					repositoryId: source.repositoryId,
					settingsDigest: source.settingsDigest,
					expectedCatalogRevision: currentRevision,
				});
				const settled = this.attempts.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, targetSessionId }));
				if (!settled.ok) return { ok: false, status: "failed", code: settled.code, operation };
				return {
					ok: true,
					status: "ok",
					operation,
						domainRevision: this.store.catalogRevision(),
					value: { targetSessionId },
					receipt: { attemptId: begun.attemptId, commandId: begun.commandId, outcome: "committed" },
				};
			} catch (error) {
				const settled = this.attempts.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ operation, error: error instanceof Error ? error.message : String(error) }));
				return { ok: false, status: "failed", code: settled.ok ? "session_create_failed" : settled.code, operation };
			}
		}
		if (operation === "session.resume") {
			const currentRevision = this.store.catalogRevision();
			if (input.expectedRevision !== currentRevision) {
				return { ok: false, status: "stale", code: "domain_revision_conflict", operation, currentRevision };
			}
			const payload = recordValue(input.payload);
			const targetSessionId = typeof payload.targetSessionId === "string" ? payload.targetSessionId : undefined;
			if (targetSessionId === undefined) {
				return { ok: false, status: "failed", code: "target_session_required", operation, currentRevision };
			}
			const target = this.store.getSession(targetSessionId);
			if (target === undefined) {
				return { ok: false, status: "unavailable", code: "session_not_found", operation, currentRevision };
			}
			if (!new Set(["active", "paused", "recovery_required"]).has(target.status)) {
				return { ok: false, status: "denied", code: "session_not_resumable", operation, currentRevision };
			}
			return { ok: true, status: "ok", operation, domainRevision: currentRevision, value: { targetSessionId } };
		}
		if (operation === "session.fork") {
			const catalogRevision = this.store.catalogRevision();
			if (input.expectedRevision !== catalogRevision) {
				return { ok: false, status: "stale", code: "domain_revision_conflict", operation, currentRevision: catalogRevision };
			}
			const payload = recordValue(input.payload);
			const sourceSessionId = typeof payload.sourceSessionId === "string" ? payload.sourceSessionId : undefined;
			const expectedSourceHeadSequence = typeof payload.expectedSourceHeadSequence === "number" && Number.isSafeInteger(payload.expectedSourceHeadSequence)
				? payload.expectedSourceHeadSequence
				: undefined;
			if (sourceSessionId === undefined || expectedSourceHeadSequence === undefined) {
				return { ok: false, status: "failed", code: "fork_source_required", operation, currentRevision: catalogRevision };
			}
			if (sourceSessionId !== this.sessionId) {
				return { ok: false, status: "denied", code: "fork_source_not_current", operation, currentRevision: catalogRevision };
			}
			const source = this.store.getSession(sourceSessionId);
			if (source === undefined) {
				return { ok: false, status: "unavailable", code: "session_not_found", operation, currentRevision: catalogRevision };
			}
			if (source.headSequence !== expectedSourceHeadSequence) {
				return { ok: false, status: "stale", code: "fork_source_head_conflict", operation, currentRevision: source.headSequence };
			}
			const begun = this.attempts.beginAttempt("workspace_mutation", runtimeDigest({
				operation,
				correlationId: input.correlationId,
				effectId: input.effectId,
				expectedRevision: input.expectedRevision,
				sourceSessionId,
				expectedSourceHeadSequence,
			}));
			if ("error" in begun) {
				return {
					ok: false,
					status: begun.error === "recovery_barrier_active" ? "recovery_required" : "failed",
					code: begun.error,
					operation,
					currentRevision: source.headSequence,
				};
			}
			try {
				const targetSessionId = createRuntimeId("session", `fork-${Date.now().toString(36)}-${String(input.effectId).slice(-24)}`);
				this.store.forkSession({
					sessionId: targetSessionId,
					sourceSessionId,
					expectedSourceHeadSequence,
					expectedCatalogRevision: catalogRevision,
					workspaceId: source.workspaceId,
					repositoryId: source.repositoryId,
					settingsDigest: source.settingsDigest,
				});
				const settled = this.attempts.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, targetSessionId, sourceSessionId, sourceHeadSequence: expectedSourceHeadSequence }));
				if (!settled.ok) return { ok: false, status: "failed", code: settled.code, operation };
				return {
					ok: true,
					status: "ok",
					operation,
					domainRevision: this.store.catalogRevision(),
					value: { targetSessionId, sourceSessionId, sourceHeadSequence: expectedSourceHeadSequence },
					receipt: { attemptId: begun.attemptId, commandId: begun.commandId, outcome: "committed" },
				};
			} catch (error) {
				const settled = this.attempts.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ operation, error: error instanceof Error ? error.message : String(error) }));
				return { ok: false, status: "failed", code: settled.ok ? "session_fork_failed" : settled.code, operation };
			}
		}
		return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
	}
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validEnvelope(input: Record<string, unknown>): boolean {
	return boundedIdentifier(input.correlationId)
		&& boundedIdentifier(input.effectId)
		&& boundedIdentifier(input.operation)
		&& isPlainRecord(input.payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value)
		&& Object.getPrototypeOf(value) === Object.prototype;
}

function boundedIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}
