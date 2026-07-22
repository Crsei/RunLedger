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
}

export class StartupRecoveryCoordinator {
	readonly #references: StartupExternalReferenceSourcePort;
	readonly #auditor: StartupExternalReceiptAuditPort;
	readonly #clock: () => Date;

	public constructor(options: StartupRecoveryCoordinatorOptions) {
		this.#references = options.references;
		this.#auditor = options.auditor;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async scan(candidates: readonly StartupSessionCandidate[], signal?: AbortSignal): Promise<StartupRecoveryReport> {
		const startedAt = this.#clock().toISOString();
		const sessions: StartupSessionReport[] = [];
		for (const candidate of [...candidates].sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
			sessions.push(await this.#scanOne(candidate, signal));
		}
		return {
			startedAt,
			finishedAt: this.#clock().toISOString(),
			sessions,
			resumableSessionIds: sessions.filter((entry) => entry.disposition === "resumable").map((entry) => entry.sessionId),
			pausedSessionIds: sessions.filter((entry) => entry.disposition === "paused").map((entry) => entry.sessionId),
		};
	}

	async #scanOne(candidate: StartupSessionCandidate, signal?: AbortSignal): Promise<StartupSessionReport> {
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

		const reasons = new Set<StartupPauseReason>(recovery.kind === "pause_for_approval" ? recovery.reasons : []);
		let loaded;
		try {
			loaded = await this.#references.loadReferences(base, signal);
		} catch {
			reasons.add("external_reference_unavailable");
			return { ...base, disposition: "paused", reasons: [...reasons], cursor: recovery.cursor, auditReceipts: [] };
		}
		if (!loaded.ok || !isExternalReceiptReferenceSet(loaded.value) ||
			loaded.value.authorityId !== candidate.authorityId || loaded.value.tenantId !== candidate.tenantId || loaded.value.sessionId !== candidate.sessionId) {
			reasons.add("external_reference_unavailable");
			return { ...base, disposition: "paused", reasons: [...reasons], cursor: recovery.cursor, auditReceipts: [] };
		}
		if (loaded.value.completeness === "unknown") reasons.add("external_reference_unknown");

		const auditReceipts: ExternalReceiptAuditReceipt[] = [];
		for (const lease of loaded.value.workspaceLeases) {
			try {
				const audited = await this.#auditor.auditWorkspaceLease(candidate.sessionId, lease, signal);
				if (!audited.ok || !auditReceiptMatchesWorkspaceLease(audited.value, candidate.sessionId, lease)) reasons.add("external_receipt_unavailable");
				else { auditReceipts.push(audited.value); if (audited.value.status === "invalid") reasons.add("external_receipt_invalid"); if (audited.value.status === "unavailable") reasons.add("external_receipt_unavailable"); }
			} catch { reasons.add("external_receipt_unavailable"); }
		}
		for (const approval of loaded.value.approvalDecisions) {
			try {
				const audited = await this.#auditor.auditApprovalDecision(candidate.sessionId, approval, signal);
				if (!audited.ok || !auditReceiptMatchesApproval(audited.value, candidate.sessionId, approval)) reasons.add("external_receipt_unavailable");
				else { auditReceipts.push(audited.value); if (audited.value.status === "invalid") reasons.add("external_receipt_invalid"); if (audited.value.status === "unavailable") reasons.add("external_receipt_unavailable"); }
			} catch { reasons.add("external_receipt_unavailable"); }
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
