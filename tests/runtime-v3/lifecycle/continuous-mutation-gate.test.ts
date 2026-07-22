import { describe, expect, it } from "vitest";
import { ContinuousExternalReceiptMutationGate } from "../../../src/runtime/lifecycle/mutation-gate.ts";
import {
	createExternalReceiptAuditReceipt,
	LIFECYCLE_SCHEMA_VERSION,
	type ExternalReceiptAuditReceipt,
	type ExternalReceiptReferenceSet,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
	type StartupExternalReferenceSourcePort,
} from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";

const NOW = "2026-07-23T00:00:02.000Z";
const FUTURE = "2026-07-23T00:10:00.000Z";
const PAST = "2026-07-22T23:59:59.000Z";
const D = "a".repeat(64);
const E = "b".repeat(64);

const scope = {
	authorityId: createRuntimeId("authority", "continuous-mutation-gate"),
	tenantId: createRuntimeId("tenant", "continuous-mutation-gate"),
	sessionId: createRuntimeId("session", "continuous-mutation-gate"),
};
const principalId = createRuntimeId("principal", "continuous-mutation-gate");
const runtimeId = createRuntimeId("runtime", "continuous-mutation-gate");
const stream = createSessionEventStreamRef(scope, scope.sessionId);

function eventHead(seed: string, sequence: number): EventCursor {
	return {
		stream,
		sequence,
		eventId: createRuntimeId("event", seed),
		eventHash: canonicalDigest({ seed, sequence }),
	};
}

const HEAD = eventHead("continuous-mutation-gate-head", 7);
const NEXT_HEAD = eventHead("continuous-mutation-gate-next-head", 8);

function workspaceLease(
	seed: string,
	overrides: Partial<WorkspaceLeaseRef> = {},
): WorkspaceLeaseRef {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		principalId,
		leaseId: createRuntimeId("lease", seed),
		workspaceId: createRuntimeId("workspace", seed),
		ownerRuntimeId: runtimeId,
		leaseRevision: 1,
		fencingTokenDigest: D,
		state: "active",
		...overrides,
	};
}

function approvalReceipt(
	seed: string,
	overrides: Partial<ApprovalReceiptRef> = {},
): ApprovalReceiptRef {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		principalId,
		receiptId: createRuntimeId("receipt", `approval-${seed}`),
		approvalId: createRuntimeId("approval", seed),
		requestId: createRuntimeId("command", seed),
		requestDigest: D,
		ticketDigest: E,
		decision: "allowed",
		decisionRevision: 1,
		decidedAt: "2026-07-23T00:00:00.000Z",
		expiresAt: FUTURE,
		receiptDigest: canonicalDigest({ kind: "approval", seed }),
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: D,
		...overrides,
	};
}

function referenceSet(
	options: {
		completeness?: ExternalReceiptReferenceSet["completeness"];
		workspaceLeases?: readonly WorkspaceLeaseRef[];
		approvalDecisions?: readonly ApprovalReceiptRef[];
	} = {},
): ExternalReceiptReferenceSet {
	return {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		...scope,
		completeness: options.completeness ?? "complete",
		workspaceLeases: options.workspaceLeases ?? [],
		approvalDecisions: options.approvalDecisions ?? [],
	};
}

function unavailable(message: string): LifecycleResult<never> {
	return {
		ok: false,
		error: { code: "external_unavailable", message, retryable: true },
	};
}

type ReferenceLoader = StartupExternalReferenceSourcePort["loadReferences"];

class MutableReferenceSource implements StartupExternalReferenceSourcePort {
	public calls = 0;
	#loader: ReferenceLoader;

	public constructor(loader: ReferenceLoader) {
		this.#loader = loader;
	}

	public setLoader(loader: ReferenceLoader): void {
		this.#loader = loader;
	}

	public loadReferences(
		requestedScope: Parameters<ReferenceLoader>[0],
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptReferenceSet>> {
		this.calls += 1;
		return this.#loader(requestedScope, signal);
	}
}

interface RecordingAuditorOptions {
	workspace?: StartupExternalReceiptAuditPort["auditWorkspaceLease"];
	approval?: StartupExternalReceiptAuditPort["auditApprovalDecision"];
}

class RecordingAuditor implements StartupExternalReceiptAuditPort {
	public readonly calls: string[] = [];
	#workspace: StartupExternalReceiptAuditPort["auditWorkspaceLease"] | undefined;
	#approval: StartupExternalReceiptAuditPort["auditApprovalDecision"] | undefined;

	public constructor(options: RecordingAuditorOptions = {}) {
		this.#workspace = options.workspace;
		this.#approval = options.approval;
	}

	public setWorkspace(handler: StartupExternalReceiptAuditPort["auditWorkspaceLease"]): void {
		this.#workspace = handler;
	}

	public auditWorkspaceLease(
		sessionId: typeof scope.sessionId,
		lease: WorkspaceLeaseRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		this.calls.push(`workspace:${lease.leaseId}`);
		return this.#workspace?.(sessionId, lease, signal) ??
			Promise.resolve(exactWorkspaceAudit(sessionId, lease));
	}

	public auditApprovalDecision(
		sessionId: typeof scope.sessionId,
		receipt: ApprovalReceiptRef,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		this.calls.push(`approval:${receipt.receiptId}`);
		return this.#approval?.(sessionId, receipt, signal) ??
			Promise.resolve(exactApprovalAudit(sessionId, receipt));
	}
}

function exactWorkspaceAudit(
	sessionId: typeof scope.sessionId,
	lease: WorkspaceLeaseRef,
): LifecycleResult<ExternalReceiptAuditReceipt> {
	const subjectDigest = canonicalDigest(lease);
	return {
		ok: true,
		value: createExternalReceiptAuditReceipt({
			authorityId: lease.authorityId,
			tenantId: lease.tenantId,
			sessionId,
			subjectKind: "workspace_lease",
			subjectId: lease.leaseId,
			subjectDigest,
			authoritativeDigest: subjectDigest,
			observedRevision: lease.leaseRevision,
			status: "valid",
			outcomeReason: "exact_match",
			checkedAt: "2026-07-23T00:00:01.000Z",
			validThrough: null,
		}),
	};
}

function exactApprovalAudit(
	sessionId: typeof scope.sessionId,
	receipt: ApprovalReceiptRef,
): LifecycleResult<ExternalReceiptAuditReceipt> {
	const subjectDigest = canonicalDigest(receipt);
	return {
		ok: true,
		value: createExternalReceiptAuditReceipt({
			authorityId: receipt.authorityId,
			tenantId: receipt.tenantId,
			sessionId,
			subjectKind: "approval_decision",
			subjectId: receipt.receiptId,
			subjectDigest,
			authoritativeDigest: subjectDigest,
			observedRevision: receipt.decisionRevision,
			status: "valid",
			outcomeReason: "exact_match",
			checkedAt: "2026-07-23T00:00:01.000Z",
			validThrough: receipt.expiresAt ?? null,
		}),
	};
}

function invalidWorkspaceAudit(
	sessionId: typeof scope.sessionId,
	lease: WorkspaceLeaseRef,
	reason: "stale" | "revoked",
): LifecycleResult<ExternalReceiptAuditReceipt> {
	const subjectDigest = canonicalDigest(lease);
	return {
		ok: true,
		value: createExternalReceiptAuditReceipt({
			authorityId: lease.authorityId,
			tenantId: lease.tenantId,
			sessionId,
			subjectKind: "workspace_lease",
			subjectId: lease.leaseId,
			subjectDigest,
			authoritativeDigest: canonicalDigest({ reason, lease }),
			observedRevision: lease.leaseRevision + 1,
			status: "invalid",
			outcomeReason: reason,
			checkedAt: "2026-07-23T00:00:01.000Z",
			validThrough: null,
		}),
	};
}

function failedWorkspaceAudit(
	sessionId: typeof scope.sessionId,
	lease: WorkspaceLeaseRef,
	mode: "stale" | "revoked" | "unavailable" | "malformed",
): LifecycleResult<ExternalReceiptAuditReceipt> {
	if (mode === "stale" || mode === "revoked") {
		return invalidWorkspaceAudit(sessionId, lease, mode);
	}
	if (mode === "unavailable") {
		return {
			ok: true,
			value: createExternalReceiptAuditReceipt({
				authorityId: lease.authorityId,
				tenantId: lease.tenantId,
				sessionId,
				subjectKind: "workspace_lease",
				subjectId: lease.leaseId,
				subjectDigest: canonicalDigest(lease),
				status: "unavailable",
				outcomeReason: "store_unavailable",
				checkedAt: "2026-07-23T00:00:01.000Z",
				validThrough: null,
			}),
		};
	}
	const result = exactWorkspaceAudit(sessionId, lease);
	if (!result.ok) return result;
	Reflect.set(result.value, "subjectDigest", canonicalDigest({ malformed: lease.leaseId }));
	return result;
}

function invalidReferenceSet(
	mode: "malformed" | "scope_mismatch" | "duplicate" | "partial" | "unknown",
): ExternalReceiptReferenceSet {
	if (mode === "duplicate") {
		const lease = workspaceLease("continuous-duplicate-reference");
		return referenceSet({ workspaceLeases: [lease, lease] });
	}
	if (mode === "partial" || mode === "unknown") return referenceSet({ completeness: mode });
	const references = referenceSet();
	Reflect.set(
		references,
		mode === "malformed" ? "schemaVersion" : "sessionId",
		mode === "malformed" ? 2 : createRuntimeId("session", "continuous-wrong-scope"),
	);
	return references;
}

function gate(options: {
	references: StartupExternalReferenceSourcePort;
	auditor?: StartupExternalReceiptAuditPort;
	currentHead?: () => EventCursor | undefined;
	externalOperationTimeoutMs?: number;
	externalScanTimeoutMs?: number;
}): ContinuousExternalReceiptMutationGate {
	return new ContinuousExternalReceiptMutationGate({
		references: options.references,
		auditor: options.auditor ?? new RecordingAuditor(),
		scope,
		currentHead: options.currentHead ?? (() => HEAD),
		clock: () => new Date(NOW),
		...(options.externalOperationTimeoutMs === undefined
			? {}
			: { externalOperationTimeoutMs: options.externalOperationTimeoutMs }),
		...(options.externalScanTimeoutMs === undefined
			? {}
			: { externalScanTimeoutMs: options.externalScanTimeoutMs }),
	});
}

function expectFailedAndLatched(
	result: LifecycleResult<unknown>,
	mutationGate: ContinuousExternalReceiptMutationGate,
): void {
	expect(result).toMatchObject({ ok: false });
	expect(mutationGate.isLatched()).toBe(true);
}

async function settleWithin<T>(
	operation: Promise<T>,
	limitMs: number,
): Promise<{ kind: "settled"; value: T } | { kind: "hung" }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then((value) => ({ kind: "settled" as const, value })),
			new Promise<{ kind: "hung" }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "hung" }), limitMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const mutationKinds = [
	"model_request",
	"tool_authorize",
	"tool_execute",
	"child_spawn",
	"session_fork",
] as const;

describe("ContinuousExternalReceiptMutationGate", () => {
	it.each(mutationKinds)("admits %s with a complete empty reference set bound to one stable event head", async (kind) => {
		const references = new MutableReferenceSource(async () => ({ ok: true, value: referenceSet() }));
		const mutationGate = gate({ references });
		const correlationId = `${kind}-empty-reference-set`;

		const result = await mutationGate.revalidate({ kind, correlationId, expectedHead: HEAD });

		expect(result).toMatchObject({
			ok: true,
			value: {
				schemaVersion: LIFECYCLE_SCHEMA_VERSION,
				...scope,
				kind,
				correlationId,
				eventHead: HEAD,
				checkedAt: NOW,
				auditReceipts: [],
			},
		});
		if (!result.ok) throw new Error(result.error.message);
		const { receiptDigest, ...body } = result.value;
		expect(receiptDigest).toBe(canonicalDigest(body));
		expect(references.calls).toBe(1);
		expect(mutationGate.isLatched()).toBe(false);
	});

	it("audits active leases before unexpired allowed approvals in stable canonical ID order", async () => {
		const leaseA = workspaceLease("continuous-order-a");
		const leaseB = workspaceLease("continuous-order-b");
		const approvalA = approvalReceipt("continuous-order-a");
		const approvalB = approvalReceipt("continuous-order-b");
		const references = new MutableReferenceSource(async () => ({
			ok: true,
			value: referenceSet({
				workspaceLeases: [leaseB, leaseA],
				approvalDecisions: [approvalB, approvalA],
			}),
		}));
		const auditor = new RecordingAuditor();
		const mutationGate = gate({ references, auditor });

		const result = await mutationGate.revalidate({
			kind: "tool_execute",
			correlationId: createRuntimeId("toolCall", "continuous-order"),
			expectedHead: HEAD,
		});

		expect(result).toMatchObject({ ok: true, value: { eventHead: HEAD } });
		if (!result.ok) throw new Error(result.error.message);
		expect(auditor.calls).toEqual([
			`workspace:${leaseA.leaseId}`,
			`workspace:${leaseB.leaseId}`,
			`approval:${approvalA.receiptId}`,
			`approval:${approvalB.receiptId}`,
		]);
		expect(result.value.auditReceipts.map((receipt: ExternalReceiptAuditReceipt) => receipt.subjectId)).toEqual([
			leaseA.leaseId,
			leaseB.leaseId,
			approvalA.receiptId,
			approvalB.receiptId,
		]);
		expect(mutationGate.isLatched()).toBe(false);
	});

	it.each(["stale", "revoked", "unavailable", "malformed", "expired"] as const)(
		"fails closed on a %s external receipt at the mutation boundary",
		async (mode) => {
			const lease = workspaceLease(`continuous-${mode}`);
			const approval = approvalReceipt("continuous-expired", { expiresAt: PAST });
			const references = new MutableReferenceSource(async () => ({
				ok: true,
				value: referenceSet({
					workspaceLeases: mode === "expired" ? [] : [lease],
					approvalDecisions: mode === "expired" ? [approval] : [],
				}),
			}));
			const auditor = mode === "expired"
				? new RecordingAuditor()
				: new RecordingAuditor({
					workspace: async (sessionId, auditedLease) => failedWorkspaceAudit(
						sessionId,
						auditedLease,
						mode,
					),
				});
			const mutationGate = gate({ references, auditor });

			const result = await mutationGate.revalidate({
				kind: "model_request",
				correlationId: createRuntimeId("modelRequest", `continuous-${mode}`),
			});

			expectFailedAndLatched(result, mutationGate);
			expect(auditor.calls).toHaveLength(1);
		},
	);

	it.each([
		"reference_failure",
		"reference_throw",
		"audit_failure",
		"audit_throw",
		"operation_timeout",
		"scan_timeout",
	] as const)(
		"bounds and fails closed on external adapter mode %s",
		async (mode) => {
			const lease = workspaceLease(`continuous-${mode}`);
			let release: (() => void) | undefined;
			const hanging = new Promise<LifecycleResult<ExternalReceiptReferenceSet>>((resolve) => {
				release = () => resolve(unavailable("released after timeout"));
			});
			const references = new MutableReferenceSource(
				mode === "reference_failure"
					? async () => unavailable("reference source unavailable")
					: mode === "reference_throw"
						? async () => { throw new Error("reference source threw"); }
						: mode === "operation_timeout" || mode === "scan_timeout"
							? async () => hanging
						: async () => ({ ok: true, value: referenceSet({ workspaceLeases: [lease] }) }),
			);
			const auditor = new RecordingAuditor({
				workspace: mode === "audit_failure"
					? async () => unavailable("workspace auditor unavailable")
					: mode === "audit_throw"
						? async () => { throw new Error("workspace auditor threw"); }
						: undefined,
			});
			const mutationGate = gate({
				references,
				auditor,
				...(mode === "operation_timeout"
					? { externalOperationTimeoutMs: 10, externalScanTimeoutMs: 1_000 }
					: mode === "scan_timeout"
						? { externalOperationTimeoutMs: 1_000, externalScanTimeoutMs: 10 }
						: {}),
			});

			const operation = mutationGate.revalidate({
				kind: "tool_execute",
				correlationId: createRuntimeId("toolCall", `continuous-${mode}`),
			});
			if (mode === "operation_timeout" || mode === "scan_timeout") {
				const observed = await settleWithin(operation, 100);
				release?.();
				expect(observed).toMatchObject({ kind: "settled", value: { ok: false } });
				expect(mutationGate.isLatched()).toBe(true);
			} else {
				expectFailedAndLatched(await operation, mutationGate);
			}
		},
	);

	it.each(["malformed", "scope_mismatch", "duplicate", "partial", "unknown"] as const)(
		"fails closed before auditing a %s canonical reference set",
		async (mode) => {
			const auditor = new RecordingAuditor();
			const mutationGate = gate({
				references: new MutableReferenceSource(async () => ({
					ok: true,
					value: invalidReferenceSet(mode),
				})),
				auditor,
			});

			const result = await mutationGate.revalidate({
				kind: "child_spawn",
				correlationId: createRuntimeId("agent", `continuous-${mode}`),
			});

			expectFailedAndLatched(result, mutationGate);
			expect(auditor.calls).toEqual([]);
		},
	);

	it.each(["during_scan", "stale_expected_head"] as const)("fails closed on event-head mode %s", async (mode) => {
		let current = HEAD;
		const references = new MutableReferenceSource(async () => {
			if (mode === "during_scan") current = NEXT_HEAD;
			return { ok: true, value: referenceSet() };
		});
		const mutationGate = gate({ references, currentHead: () => current });

		const result = mode === "during_scan"
			? await mutationGate.revalidate({
				kind: "child_spawn",
				correlationId: createRuntimeId("agent", "continuous-head-drift"),
			})
			: await mutationGate.revalidate({
				kind: "session_fork",
				correlationId: createRuntimeId("command", "continuous-stale-expected-head"),
				expectedHead: NEXT_HEAD,
			});

		expectFailedAndLatched(result, mutationGate);
		expect(references.calls).toBe(mode === "during_scan" ? 1 : 0);
	});

	it("stays latched after the first failure and never re-enters a recovered auditor", async () => {
		const lease = workspaceLease("continuous-latched");
		const references = new MutableReferenceSource(async () => ({
			ok: true,
			value: referenceSet({ workspaceLeases: [lease] }),
		}));
		let recovered = false;
		const auditor = new RecordingAuditor({
			workspace: async (sessionId, auditedLease) => recovered
				? exactWorkspaceAudit(sessionId, auditedLease)
				: invalidWorkspaceAudit(sessionId, auditedLease, "revoked"),
		});
		const mutationGate = gate({ references, auditor });

		const first = await mutationGate.revalidate({
			kind: "tool_authorize",
			correlationId: createRuntimeId("toolCall", "continuous-latched-first"),
		});
		expectFailedAndLatched(first, mutationGate);
		recovered = true;
		const second = await mutationGate.revalidate({
			kind: "tool_execute",
			correlationId: createRuntimeId("toolCall", "continuous-latched-second"),
		});

		expectFailedAndLatched(second, mutationGate);
		expect(references.calls).toBe(1);
		expect(auditor.calls).toEqual([`workspace:${lease.leaseId}`]);
	});

	it("serializes concurrent revalidation calls before entering external adapters", async () => {
		let active = 0;
		let maximumActive = 0;
		let calls = 0;
		let firstEntered: (() => void) | undefined;
		let releaseFirst: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
		const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const order: string[] = [];
		const references = new MutableReferenceSource(async () => {
			calls += 1;
			const call = calls;
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			order.push(`start:${call}`);
			if (call === 1) {
				firstEntered?.();
				await firstBarrier;
			}
			order.push(`end:${call}`);
			active -= 1;
			return { ok: true, value: referenceSet() };
		});
		const mutationGate = gate({ references });

		const first = mutationGate.revalidate({
			kind: "model_request",
			correlationId: createRuntimeId("modelRequest", "continuous-serial-first"),
		});
		const second = mutationGate.revalidate({
			kind: "tool_authorize",
			correlationId: createRuntimeId("toolCall", "continuous-serial-second"),
		});
		await entered;
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst?.();

		const results = await Promise.all([first, second]);
		expect(results).toMatchObject([{ ok: true }, { ok: true }]);
		expect(maximumActive).toBe(1);
		expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
		expect(mutationGate.isLatched()).toBe(false);
	});
});
