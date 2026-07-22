/** Durable Workspace/Approval store 上的 startup 外部 receipt 审计适配器。 */

import type { ApprovalStateStorePort } from "../security/permission/approval-coordinator.ts";
import {
	createExternalReceiptAuditReceipt,
	type ExternalReceiptAuditReceipt,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
} from "../runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { SessionId } from "../runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../runtime/protocol/v3/workspace.ts";
import type { WorkspaceLeaseMutationPort } from "../worktree/ports.ts";

export interface DurableStartupExternalReceiptAuditorOptions {
	workspaceLeaseStore: Pick<WorkspaceLeaseMutationPort, "read">;
	approvalStore: Pick<ApprovalStateStorePort, "read">;
	clock?: () => Date;
}

interface AuditBase {
	authorityId: ExternalReceiptAuditReceipt["authorityId"];
	tenantId: ExternalReceiptAuditReceipt["tenantId"];
	sessionId: SessionId;
	subjectKind: ExternalReceiptAuditReceipt["subjectKind"];
	subjectId: string;
	subjectDigest: string;
	checkedAt: string;
}

function completed(
	input: Parameters<typeof createExternalReceiptAuditReceipt>[0],
): LifecycleResult<ExternalReceiptAuditReceipt> {
	return { ok: true, value: createExternalReceiptAuditReceipt(input) };
}

function unavailable(
	base: AuditBase,
	outcomeReason: "not_found" | "store_unavailable" | "external_unavailable",
): LifecycleResult<ExternalReceiptAuditReceipt> {
	return completed({
		...base,
		status: "unavailable",
		outcomeReason,
		validThrough: null,
	});
}

/**
 * 只比较调用者持有的 reference 与 durable store 当前记录。
 *
 * Lease secret 的明文 fencing token 和 store 抛出的原始异常都不会进入 receipt；
 * authoritativeDigest 只覆盖可公开持久化的 reference。
 */
export class DurableStartupExternalReceiptAuditor implements StartupExternalReceiptAuditPort {
	readonly #workspaceLeaseStore: Pick<WorkspaceLeaseMutationPort, "read">;
	readonly #approvalStore: Pick<ApprovalStateStorePort, "read">;
	readonly #clock: () => Date;

	public constructor(options: DurableStartupExternalReceiptAuditorOptions) {
		this.#workspaceLeaseStore = options.workspaceLeaseStore;
		this.#approvalStore = options.approvalStore;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async auditWorkspaceLease(
		sessionId: SessionId,
		lease: WorkspaceLeaseRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		const base: AuditBase = {
			authorityId: lease.authorityId,
			tenantId: lease.tenantId,
			sessionId,
			subjectKind: "workspace_lease",
			subjectId: lease.leaseId,
			subjectDigest: canonicalDigest(lease),
			checkedAt: this.#clock().toISOString(),
		};
		if (signal?.aborted) return unavailable(base, "external_unavailable");

		let authoritative;
		try {
			authoritative = await this.#workspaceLeaseStore.read(lease.workspaceId);
		} catch {
			return unavailable(base, "store_unavailable");
		}
		if (signal?.aborted) return unavailable(base, "external_unavailable");
		if (authoritative === undefined) return unavailable(base, "not_found");

		const record = authoritative.record;
		const authoritativeDigest = canonicalDigest(record);
		const evidence = {
			...base,
			authoritativeDigest,
			observedRevision: record.leaseRevision,
			validThrough: null,
		};
		if (
			record.authorityId !== lease.authorityId ||
			record.tenantId !== lease.tenantId ||
			record.principalId !== lease.principalId
		) {
			return completed({ ...evidence, status: "invalid", outcomeReason: "scope_mismatch" });
		}
		if (authoritativeDigest !== base.subjectDigest) {
			return completed({ ...evidence, status: "invalid", outcomeReason: "stale" });
		}
		if (record.state === "active") {
			return completed({ ...evidence, status: "valid", outcomeReason: "exact_match" });
		}
		return completed({
			...evidence,
			status: "invalid",
			outcomeReason: record.state === "revoked" ? "revoked" : "stale",
		});
	}

	public async auditApprovalDecision(
		sessionId: SessionId,
		receipt: ApprovalReceiptRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		const checkedAt = this.#clock().toISOString();
		const base: AuditBase = {
			authorityId: receipt.authorityId,
			tenantId: receipt.tenantId,
			sessionId,
			subjectKind: "approval_decision",
			subjectId: receipt.receiptId,
			subjectDigest: canonicalDigest(receipt),
			checkedAt,
		};
		if (signal?.aborted) return unavailable(base, "external_unavailable");

		let authoritative;
		try {
			authoritative = await this.#approvalStore.read(receipt.approvalId);
		} catch {
			return unavailable(base, "store_unavailable");
		}
		if (signal?.aborted) return unavailable(base, "external_unavailable");
		if (authoritative === undefined) return unavailable(base, "not_found");

		const authoritativeDigest = canonicalDigest(authoritative);
		const evidence = {
			...base,
			authoritativeDigest,
			observedRevision: authoritative.decisionRevision,
			validThrough: null,
		};
		if (
			authoritative.authorityId !== receipt.authorityId ||
			authoritative.tenantId !== receipt.tenantId ||
			authoritative.principalId !== receipt.principalId
		) {
			return completed({ ...evidence, status: "invalid", outcomeReason: "scope_mismatch" });
		}
		if (authoritativeDigest !== base.subjectDigest) {
			return completed({ ...evidence, status: "invalid", outcomeReason: "stale" });
		}
		if (authoritative.decision === "revoked") {
			return completed({ ...evidence, status: "invalid", outcomeReason: "revoked" });
		}
		const expiresAt = authoritative.expiresAt;
		if (
			authoritative.decision === "expired" ||
			(expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(checkedAt))
		) {
			return completed({ ...evidence, status: "invalid", outcomeReason: "expired" });
		}
		if (authoritative.decision === "allowed") {
			return completed({
				...evidence,
				status: "valid",
				outcomeReason: "exact_match",
				validThrough: expiresAt ?? null,
			});
		}
		return completed({ ...evidence, status: "invalid", outcomeReason: "stale" });
	}
}
