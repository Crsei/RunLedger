/** Startup 顺序：tombstone/integrity recovery -> 外部 receipt 审计 -> fail-closed disposition。 */

import type { EventCursor } from "../protocol/v3/events.ts";
import type { AuthorityId, SessionId, TenantId } from "../protocol/v3/ids.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import { recoverSession, type RecoveryDecision } from "../session/recovery.ts";
import {
	auditReceiptMatchesApproval,
	auditReceiptMatchesWorkspaceLease,
	isExternalReceiptReferenceSet,
	type ExternalReceiptAuditReceipt,
	type StartupExternalReceiptAuditPort,
	type StartupExternalReferenceSourcePort,
} from "./recovery.ts";

export interface StartupSessionCandidate {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	sessionDirectory: string;
	store: RuntimeEventStore;
	snapshotFilePath?: string;
}

export type StartupPauseReason =
	| "active_turn" | "active_model_request" | "uncertain_operation" | "pending_permission"
	| "pending_artifact_intent" | "artifact_reconciliation_failed" | "pending_verification" | "pending_queue_unrecoverable"
	| "pending_queue_artifact_unavailable"
	| "external_reference_unknown"
	| "external_reference_unavailable" | "external_receipt_invalid" | "external_receipt_unavailable";

export interface StartupSessionReport {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	disposition: "resumable" | "paused" | "stopped" | "corrupted";
	checks: readonly ("tombstone" | "event_integrity" | "external_receipts")[];
	reasons: readonly StartupPauseReason[];
	cursor?: EventCursor;
	auditReceipts: readonly ExternalReceiptAuditReceipt[];
}

export interface StartupRecoveryReport {
	startedAt: string;
	finishedAt: string;
	sessions: readonly StartupSessionReport[];
	resumableSessionIds: readonly SessionId[];
	pausedSessionIds: readonly SessionId[];
}

export interface StartupRecoveryCoordinatorOptions {
	references: StartupExternalReferenceSourcePort;
	auditor: StartupExternalReceiptAuditPort;
	clock?: () => Date;
	/** 单个外部读取/审计的硬上限；adapter 忽略 AbortSignal 也不能卡住 startup。 */
	externalOperationTimeoutMs?: number;
	/** 整次 scan 的外部调用总时限；耗尽后不再启动新的 reference/audit 调用。 */
	externalScanTimeoutMs?: number;
}

type ExternalCallResult<T> =
	| { kind: "value"; value: T }
	| { kind: "unavailable"; cause: "aborted" | "throw" | "timeout" };

async function boundedExternalCall<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ExternalCallResult<T>> {
	if (parentSignal?.aborted) return { kind: "unavailable", cause: "aborted" };
	const controller = new AbortController();
	let resolveParentAbort: ((result: ExternalCallResult<T>) => void) | undefined;
	const parentAbort = new Promise<ExternalCallResult<T>>((resolve) => {
		resolveParentAbort = resolve;
	});
	const onParentAbort = () => {
		resolveParentAbort?.({ kind: "unavailable", cause: "aborted" });
		controller.abort(parentSignal?.reason);
	};
	parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const work = Promise.resolve()
		.then(() => operation(controller.signal))
		.then(
			(value): ExternalCallResult<T> => ({ kind: "value", value }),
			(): ExternalCallResult<T> => ({ kind: "unavailable", cause: "throw" }),
		);
	const deadline = new Promise<ExternalCallResult<T>>((resolve) => {
		timer = setTimeout(() => {
			resolve({ kind: "unavailable", cause: "timeout" });
			controller.abort("startup_external_operation_timeout");
		}, timeoutMs);
	});
	try {
		return await Promise.race([work, deadline, parentAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
	}
}

export class StartupRecoveryCoordinator {
	readonly #references: StartupExternalReferenceSourcePort;
	readonly #auditor: StartupExternalReceiptAuditPort;
	readonly #clock: () => Date;
	readonly #externalOperationTimeoutMs: number;
	readonly #externalScanTimeoutMs: number;

	public constructor(options: StartupRecoveryCoordinatorOptions) {
		this.#references = options.references;
		this.#auditor = options.auditor;
		this.#clock = options.clock ?? (() => new Date());
		this.#externalOperationTimeoutMs = options.externalOperationTimeoutMs ?? 5_000;
		this.#externalScanTimeoutMs = options.externalScanTimeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#externalOperationTimeoutMs) ||
			this.#externalOperationTimeoutMs < 1 || this.#externalOperationTimeoutMs > 300_000) {
			throw new TypeError("startup external operation timeout is outside the supported range");
		}
		if (!Number.isSafeInteger(this.#externalScanTimeoutMs) ||
			this.#externalScanTimeoutMs < 1 || this.#externalScanTimeoutMs > 300_000) {
			throw new TypeError("startup external scan timeout is outside the supported range");
		}
	}

	public async scan(candidates: readonly StartupSessionCandidate[], signal?: AbortSignal): Promise<StartupRecoveryReport> {
		const startedAt = this.#clock().toISOString();
		const externalDeadlineMs = Date.now() + this.#externalScanTimeoutMs;
		const sessions: StartupSessionReport[] = [];
		for (const candidate of [...candidates].sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
			sessions.push(await this.#scanOne(candidate, externalDeadlineMs, signal));
		}
		return {
			startedAt,
			finishedAt: this.#clock().toISOString(),
			sessions,
			resumableSessionIds: sessions.filter((entry) => entry.disposition === "resumable").map((entry) => entry.sessionId),
			pausedSessionIds: sessions.filter((entry) => entry.disposition === "paused").map((entry) => entry.sessionId),
		};
	}

	#remainingExternalScanMs(externalDeadlineMs: number): number {
		return Math.max(0, externalDeadlineMs - Date.now());
	}

	async #scanOne(
		candidate: StartupSessionCandidate,
		externalDeadlineMs: number,
		signal?: AbortSignal,
	): Promise<StartupSessionReport> {
		const recoveryBase = {
			authorityId: candidate.authorityId,
			tenantId: candidate.tenantId,
			sessionId: candidate.sessionId,
			checks: ["tombstone", "event_integrity"] as const,
		};
		let recovery: RecoveryDecision;
		try {
			recovery = await recoverSession({
				store: candidate.store, sessionDirectory: candidate.sessionDirectory,
				authorityId: candidate.authorityId, tenantId: candidate.tenantId, sessionId: candidate.sessionId,
				...(candidate.snapshotFilePath ? { snapshotFilePath: candidate.snapshotFilePath } : {}),
			});
		} catch {
			return { ...recoveryBase, disposition: "corrupted", reasons: [], auditReceipts: [] };
		}
		if (recovery.kind === "corrupted") return { ...recoveryBase, disposition: "corrupted", reasons: [], auditReceipts: [] };
		if (recovery.kind === "stopped") return { ...recoveryBase, disposition: "stopped", reasons: [], cursor: recovery.cursor, auditReceipts: [] };
		const base = { ...recoveryBase, checks: [...recoveryBase.checks, "external_receipts"] as const };

		const reasons = new Set<StartupPauseReason>(
			recovery.kind === "pause_for_approval" || recovery.kind === "reconciliation_required"
				? recovery.reasons
				: [],
		);
		const referenceTimeoutMs = Math.min(
			this.#externalOperationTimeoutMs,
			this.#remainingExternalScanMs(externalDeadlineMs),
		);
		if (referenceTimeoutMs < 1) {
			reasons.add("external_reference_unavailable");
			return { ...base, disposition: "paused", reasons: [...reasons], cursor: recovery.cursor, auditReceipts: [] };
		}
		const loadedCall = await boundedExternalCall(
			(boundedSignal) => this.#references.loadReferences(base, boundedSignal),
			signal,
			referenceTimeoutMs,
		);
		if (loadedCall.kind !== "value") {
			reasons.add("external_reference_unavailable");
			return { ...base, disposition: "paused", reasons: [...reasons], cursor: recovery.cursor, auditReceipts: [] };
		}
		const loaded = loadedCall.value;
		if (!loaded.ok || !isExternalReceiptReferenceSet(loaded.value) ||
			loaded.value.authorityId !== candidate.authorityId || loaded.value.tenantId !== candidate.tenantId || loaded.value.sessionId !== candidate.sessionId) {
			reasons.add("external_reference_unavailable");
			return { ...base, disposition: "paused", reasons: [...reasons], cursor: recovery.cursor, auditReceipts: [] };
		}
		if (loaded.value.completeness !== "complete") reasons.add("external_reference_unknown");

		const auditReceipts: ExternalReceiptAuditReceipt[] = [];
		let auditBudgetExhausted = false;
		for (const lease of loaded.value.workspaceLeases) {
			const auditTimeoutMs = Math.min(
				this.#externalOperationTimeoutMs,
				this.#remainingExternalScanMs(externalDeadlineMs),
			);
			if (auditTimeoutMs < 1 || signal?.aborted) {
				reasons.add("external_receipt_unavailable");
				auditBudgetExhausted = true;
				break;
			}
			const auditedCall = await boundedExternalCall(
				(boundedSignal) => this.#auditor.auditWorkspaceLease(candidate.sessionId, lease, boundedSignal),
				signal,
				auditTimeoutMs,
			);
			if (auditedCall.kind !== "value") {
				reasons.add("external_receipt_unavailable");
				if (auditedCall.cause === "timeout" || auditedCall.cause === "aborted") {
					auditBudgetExhausted = true;
					break;
				}
				continue;
			}
			if (!auditedCall.value.ok) {
				reasons.add("external_receipt_unavailable");
				continue;
			}
			const audited = auditedCall.value.value;
			if (!auditReceiptMatchesWorkspaceLease(audited, candidate.sessionId, lease)) {
				reasons.add("external_receipt_invalid");
				continue;
			}
			auditReceipts.push(audited);
			if (lease.state !== "active" || audited.status === "invalid") reasons.add("external_receipt_invalid");
			if (audited.status === "unavailable") reasons.add("external_receipt_unavailable");
		}
		for (const approval of auditBudgetExhausted ? [] : loaded.value.approvalDecisions) {
			const auditTimeoutMs = Math.min(
				this.#externalOperationTimeoutMs,
				this.#remainingExternalScanMs(externalDeadlineMs),
			);
			if (auditTimeoutMs < 1 || signal?.aborted) {
				reasons.add("external_receipt_unavailable");
				break;
			}
			const auditedCall = await boundedExternalCall(
				(boundedSignal) => this.#auditor.auditApprovalDecision(candidate.sessionId, approval, boundedSignal),
				signal,
				auditTimeoutMs,
			);
			if (auditedCall.kind !== "value") {
				reasons.add("external_receipt_unavailable");
				if (auditedCall.cause === "timeout" || auditedCall.cause === "aborted") break;
				continue;
			}
			if (!auditedCall.value.ok) {
				reasons.add("external_receipt_unavailable");
				continue;
			}
			const audited = auditedCall.value.value;
			if (!auditReceiptMatchesApproval(audited, candidate.sessionId, approval)) {
				reasons.add("external_receipt_invalid");
				continue;
			}
			auditReceipts.push(audited);
			const expiredAllowed = approval.decision === "allowed" && approval.expiresAt !== undefined &&
				Date.parse(approval.expiresAt) <= this.#clock().getTime();
			if (approval.decision !== "allowed" || expiredAllowed || audited.status === "invalid") {
				reasons.add("external_receipt_invalid");
			}
			if (audited.status === "unavailable") reasons.add("external_receipt_unavailable");
		}
		return {
			...base,
			disposition: reasons.size === 0 ? "resumable" : "paused",
			reasons: [...reasons].sort(),
			cursor: recovery.cursor,
			auditReceipts,
		};
	}
}
