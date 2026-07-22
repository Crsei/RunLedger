import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	type ApprovalReceiptRef,
	type ApprovalTicket,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";
import {
	isExternalReceiptAuditReceipt,
	type ExternalReceiptAuditReceipt,
	type LifecycleResult,
} from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalStateStorePort } from "../../../src/security/permission/approval-coordinator.ts";
import { FileApprovalStateStore } from "../../../src/storage/security-runtime-state.ts";
import {
	DurableStartupExternalReceiptAuditor,
} from "../../../src/storage/startup-receipt-auditor.ts";
import {
	FileWorkspaceLeaseMutationPort,
	type DurableWorktreeScope,
} from "../../../src/storage/worktree-state-adapter.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorkspaceLeaseSecret,
} from "../../../src/worktree/ports.ts";

const NOW = "2026-07-23T00:02:00.000Z";
const ISSUED_AT = "2026-07-23T00:00:00.000Z";
const DECIDED_AT = "2026-07-23T00:01:00.000Z";
const FUTURE_EXPIRY = "2026-07-23T01:00:00.000Z";
const PAST_EXPIRY = "2026-07-23T00:01:30.000Z";
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function scope(seed: string): DurableWorktreeScope {
	return {
		authorityId: createRuntimeId("authority", seed),
		tenantId: createRuntimeId("tenant", seed),
	};
}

function lease(
	configuredScope: DurableWorktreeScope,
	seed: string,
	options: {
		revision?: number;
		token?: string;
		state?: WorkspaceLeaseRef["state"];
		ownerSeed?: string;
	} = {},
): { reference: WorkspaceLeaseRef; secret: WorkspaceLeaseSecret; fencingToken: string } {
	const revision = options.revision ?? 1;
	const fencingToken = options.token ?? `private-fencing-token-${seed}-${revision}`;
	const reference: WorkspaceLeaseRef = {
		authorityId: configuredScope.authorityId,
		tenantId: configuredScope.tenantId,
		principalId: createRuntimeId("principal", seed),
		leaseId: createRuntimeId("lease", seed),
		workspaceId: createRuntimeId("workspace", seed),
		ownerRuntimeId: createRuntimeId("runtime", options.ownerSeed ?? seed),
		leaseRevision: revision,
		fencingTokenDigest: canonicalDigest(fencingToken),
		state: options.state ?? "active",
	};
	return {
		reference,
		fencingToken,
		secret: {
			record: reference,
			fencingToken,
			issuedAt: ISSUED_AT,
			lastRenewedAt: ISSUED_AT,
		},
	};
}

function ticket(
	configuredScope: DurableWorktreeScope,
	sessionId: ReturnType<typeof createRuntimeId<"session">>,
	seed: string,
	expiresAt = FUTURE_EXPIRY,
): ApprovalTicket {
	const principalId = createRuntimeId("principal", seed);
	const approvalId = createRuntimeId("approval", seed);
	return {
		authorityId: configuredScope.authorityId,
		tenantId: configuredScope.tenantId,
		principalId,
		approvalId,
		request: {
			authorityId: configuredScope.authorityId,
			tenantId: configuredScope.tenantId,
			principalId,
			requestId: createRuntimeId("command", seed),
			approvalId,
			sessionId,
			runtimeId: createRuntimeId("runtime", seed),
			runtimeGeneration: 1,
			turnId: createRuntimeId("turn", seed),
			toolCallId: createRuntimeId("toolCall", seed),
			capability: "workspace_write",
			argumentsDigest: canonicalDigest({ seed, kind: "arguments" }),
			workspaceEnvelopeDigest: canonicalDigest({ seed, kind: "workspace" }),
			policyDigest: canonicalDigest({ seed, kind: "policy" }),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest({ seed, kind: "resource" }),
			commandScopeDigest: canonicalDigest({ seed, kind: "command" }),
		},
		scope: "once",
		createdAt: ISSUED_AT,
		expiresAt,
	};
}

function approval(
	value: ApprovalTicket,
	decision: "allowed" | "revoked" | "expired" = "allowed",
): ApprovalReceiptRef {
	const base = {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		principalId: value.principalId,
		receiptId: createRuntimeId("receipt", `approval-${value.approvalId}`),
		approvalId: value.approvalId,
		requestId: value.request.requestId,
		requestDigest: approvalTicketRequestDigest(value),
		ticketDigest: approvalTicketDigest(value),
		decisionRevision: decision === "allowed" ? 1 : 2,
		decidedBy: createRuntimeId("principal", `approver-${value.approvalId}`),
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: value.request.argumentsDigest,
	};
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = decision === "revoked"
		? {
			...base,
			decision,
			decidedAt: DECIDED_AT,
			expiresAt: value.expiresAt,
			revokedAt: NOW,
		}
		: decision === "expired"
			? {
				...base,
				decision,
				decidedAt: value.expiresAt ?? PAST_EXPIRY,
				expiresAt: value.expiresAt ?? PAST_EXPIRY,
			}
			: {
				...base,
				decision,
				decidedAt: DECIDED_AT,
				expiresAt: value.expiresAt,
			};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function valueOf<T>(result: LifecycleResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function expectBoundAudit(
	receipt: ExternalReceiptAuditReceipt,
	expected: {
		status: ExternalReceiptAuditReceipt["status"];
		subjectKind: ExternalReceiptAuditReceipt["subjectKind"];
		subjectId: string;
		subjectDigest: string;
		authoritativeDigest?: string;
		observedRevision?: number;
		outcomeReason: string;
	},
): void {
	expect(receipt).toMatchObject(expected);
	if (expected.authoritativeDigest === undefined) {
		expect(receipt).not.toHaveProperty("authoritativeDigest");
	}
	if (expected.observedRevision === undefined) {
		expect(receipt).not.toHaveProperty("observedRevision");
	}
	expect(isExternalReceiptAuditReceipt(receipt)).toBe(true);
	const { receiptDigest, ...body } = receipt;
	expect(receiptDigest).toBe(canonicalDigest(body));
}

async function durableStores(seed: string) {
	const root = await mkdtemp(join(tmpdir(), "runledger-startup-auditor-"));
	roots.push(root);
	const configuredScope = scope(seed);
	return {
		root,
		configuredScope,
		workspaceLeaseStore: new FileWorkspaceLeaseMutationPort(
			join(root, "workspace-leases.json"),
			configuredScope,
		),
		approvalStore: new FileApprovalStateStore(join(root, "approvals")),
	};
}

function auditor(options: {
	workspaceLeaseStore: Pick<WorkspaceLeaseMutationPort, "read">;
	approvalStore: Pick<ApprovalStateStorePort, "read">;
}) {
	return new DurableStartupExternalReceiptAuditor({
		...options,
		clock: () => new Date(NOW),
	});
}

describe("DurableStartupExternalReceiptAuditor store-port contract", () => {
	it("accepts only an exact active lease and exact unexpired allowed approval", async () => {
		const stores = await durableStores("exact");
		const sessionId = createRuntimeId("session", "exact");
		const active = lease(stores.configuredScope, "exact");
		const allowed = approval(ticket(stores.configuredScope, sessionId, "exact"));
		expect(await stores.workspaceLeaseStore.create(active.secret)).toBe("applied");
		expect(await stores.approvalStore.commit(allowed, 0)).toMatchObject({ ok: true });

		const durable = auditor(stores);
		const leaseAudit = valueOf(await durable.auditWorkspaceLease(sessionId, active.reference));
		expectBoundAudit(leaseAudit, {
			status: "valid",
			subjectKind: "workspace_lease",
			subjectId: active.reference.leaseId,
			subjectDigest: canonicalDigest(active.reference),
			authoritativeDigest: canonicalDigest(active.reference),
			observedRevision: active.reference.leaseRevision,
			outcomeReason: "exact_match",
		});
		expect(JSON.stringify(leaseAudit)).not.toContain(active.fencingToken);

		const approvalAudit = valueOf(await durable.auditApprovalDecision(sessionId, allowed));
		expectBoundAudit(approvalAudit, {
			status: "valid",
			subjectKind: "approval_decision",
			subjectId: allowed.receiptId,
			subjectDigest: canonicalDigest(allowed),
			authoritativeDigest: canonicalDigest(allowed),
			observedRevision: allowed.decisionRevision,
			outcomeReason: "exact_match",
		});
	});

	it.each(["revision", "fencing"] as const)(
		"rejects a same-id lease whose %s observation is stale",
		async (difference) => {
			const stores = await durableStores(`stale-lease-${difference}`);
			const sessionId = createRuntimeId("session", `stale-lease-${difference}`);
			const expected = lease(stores.configuredScope, `stale-lease-${difference}`);
			const authoritative = lease(stores.configuredScope, `stale-lease-${difference}`, {
				revision: difference === "revision" ? 2 : 1,
				token: `private-new-token-${difference}`,
				ownerSeed: difference === "revision" ? `new-owner-${difference}` : `stale-lease-${difference}`,
			});
			expect(await stores.workspaceLeaseStore.create(authoritative.secret)).toBe("applied");

			const receipt = valueOf(await auditor(stores).auditWorkspaceLease(sessionId, expected.reference));
			expectBoundAudit(receipt, {
				status: "invalid",
				subjectKind: "workspace_lease",
				subjectId: expected.reference.leaseId,
				subjectDigest: canonicalDigest(expected.reference),
				authoritativeDigest: canonicalDigest(authoritative.reference),
				observedRevision: authoritative.reference.leaseRevision,
				outcomeReason: "stale",
			});
			expect(JSON.stringify(receipt)).not.toContain(expected.fencingToken);
			expect(JSON.stringify(receipt)).not.toContain(authoritative.fencingToken);
		},
	);

	it("rejects a same-id approval whose durable receipt digest is different", async () => {
		const stores = await durableStores("stale-approval");
		const sessionId = createRuntimeId("session", "stale-approval");
		const authoritative = approval(ticket(stores.configuredScope, sessionId, "stale-approval"));
		const stale = { ...authoritative, receiptDigest: canonicalDigest("stale-approval-receipt") };
		expect(await stores.approvalStore.commit(authoritative, 0)).toMatchObject({ ok: true });

		const receipt = valueOf(await auditor(stores).auditApprovalDecision(sessionId, stale));
		expectBoundAudit(receipt, {
			status: "invalid",
			subjectKind: "approval_decision",
			subjectId: stale.receiptId,
			subjectDigest: canonicalDigest(stale),
			authoritativeDigest: canonicalDigest(authoritative),
			observedRevision: authoritative.decisionRevision,
			outcomeReason: "stale",
		});
	});

	it("rejects revoked leases and revoked or expired approvals", async () => {
		const stores = await durableStores("terminal");
		const sessionId = createRuntimeId("session", "terminal");
		const revokedLease = lease(stores.configuredScope, "terminal", { state: "revoked" });
		const revokedTicket = ticket(stores.configuredScope, sessionId, "revoked");
		const expiredTicket = ticket(stores.configuredScope, sessionId, "expired", PAST_EXPIRY);
		const allowedBeforeRevocation = approval(revokedTicket);
		const allowedBeforeExpiry = approval(expiredTicket);
		const revokedApproval = approval(revokedTicket, "revoked");
		const expiredApproval = approval(expiredTicket, "expired");
		expect(await stores.workspaceLeaseStore.create(revokedLease.secret)).toBe("applied");
		expect(await stores.approvalStore.commit(allowedBeforeRevocation, 0)).toMatchObject({ ok: true });
		expect(await stores.approvalStore.commit(revokedApproval, 1)).toMatchObject({ ok: true });
		expect(await stores.approvalStore.commit(allowedBeforeExpiry, 0)).toMatchObject({ ok: true });
		expect(await stores.approvalStore.commit(expiredApproval, 1)).toMatchObject({ ok: true });

		const durable = auditor(stores);
		const leaseAudit = valueOf(await durable.auditWorkspaceLease(sessionId, revokedLease.reference));
		expectBoundAudit(leaseAudit, {
			status: "invalid",
			subjectKind: "workspace_lease",
			subjectId: revokedLease.reference.leaseId,
			subjectDigest: canonicalDigest(revokedLease.reference),
			authoritativeDigest: canonicalDigest(revokedLease.reference),
			observedRevision: revokedLease.reference.leaseRevision,
			outcomeReason: "revoked",
		});
		expect(JSON.stringify(leaseAudit)).not.toContain(revokedLease.fencingToken);

		for (const [candidate, reason] of [
			[revokedApproval, "revoked"],
			[expiredApproval, "expired"],
		] as const) {
			const receipt = valueOf(await durable.auditApprovalDecision(sessionId, candidate));
			expectBoundAudit(receipt, {
				status: "invalid",
				subjectKind: "approval_decision",
				subjectId: candidate.receiptId,
				subjectDigest: canonicalDigest(candidate),
				authoritativeDigest: canonicalDigest(candidate),
				observedRevision: candidate.decisionRevision,
				outcomeReason: reason,
			});
		}
	});

	it("maps missing durable records to unavailable without inventing authoritative evidence", async () => {
		const stores = await durableStores("missing");
		const sessionId = createRuntimeId("session", "missing");
		const missingLease = lease(stores.configuredScope, "missing");
		const missingApproval = approval(ticket(stores.configuredScope, sessionId, "missing"));
		const durable = auditor(stores);

		const leaseAudit = valueOf(await durable.auditWorkspaceLease(sessionId, missingLease.reference));
		expectBoundAudit(leaseAudit, {
			status: "unavailable",
			subjectKind: "workspace_lease",
			subjectId: missingLease.reference.leaseId,
			subjectDigest: canonicalDigest(missingLease.reference),
			outcomeReason: "not_found",
		});
		expect(JSON.stringify(leaseAudit)).not.toContain(missingLease.fencingToken);

		const approvalAudit = valueOf(await durable.auditApprovalDecision(sessionId, missingApproval));
		expectBoundAudit(approvalAudit, {
			status: "unavailable",
			subjectKind: "approval_decision",
			subjectId: missingApproval.receiptId,
			subjectDigest: canonicalDigest(missingApproval),
			outcomeReason: "not_found",
		});
	});

	it("maps store throws to unavailable receipts without leaking the thrown value", async () => {
		const configuredScope = scope("throw");
		const sessionId = createRuntimeId("session", "throw");
		const expectedLease = lease(configuredScope, "throw");
		const expectedApproval = approval(ticket(configuredScope, sessionId, "throw"));
		const secretFailure = "private-store-failure-value";
		const workspaceLeaseStore: WorkspaceLeaseMutationPort = {
			read: async () => { throw new Error(secretFailure); },
			create: async () => "conflict",
			compareAndSwap: async () => "conflict",
			remove: async () => "not_found",
		};
		const approvalStore: ApprovalStateStorePort = {
			read: async () => { throw new Error(secretFailure); },
			commit: async () => ({
				ok: false,
				error: { code: "approval_stale", message: "unused", retryable: false },
			}),
			withCurrentApproval: async () => { throw new Error(secretFailure); },
		};
		const durable = auditor({ workspaceLeaseStore, approvalStore });

		for (const receipt of [
			valueOf(await durable.auditWorkspaceLease(sessionId, expectedLease.reference)),
			valueOf(await durable.auditApprovalDecision(sessionId, expectedApproval)),
		]) {
			expect(receipt).toMatchObject({
				status: "unavailable",
				outcomeReason: "store_unavailable",
			});
			expect(receipt).not.toHaveProperty("authoritativeDigest");
			expect(receipt).not.toHaveProperty("observedRevision");
			expect(isExternalReceiptAuditReceipt(receipt)).toBe(true);
			const { receiptDigest, ...body } = receipt;
			expect(receiptDigest).toBe(canonicalDigest(body));
			expect(JSON.stringify(receipt)).not.toContain(secretFailure);
			expect(JSON.stringify(receipt)).not.toContain(expectedLease.fencingToken);
		}
	});
});
