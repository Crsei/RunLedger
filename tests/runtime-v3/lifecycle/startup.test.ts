import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";
import { StartupRecoveryCoordinator, type StartupRecoveryReport } from "../../../src/runtime/lifecycle/startup.ts";
import { createExternalReceiptAuditReceipt, LIFECYCLE_SCHEMA_VERSION, type ExternalReceiptAuditReceipt, type ExternalReceiptReferenceSet, type LifecycleResult, type StartupExternalReceiptAuditPort, type StartupExternalReferenceSourcePort } from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";

const D = "a".repeat(64);
const E = "b".repeat(64);
const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function valueOf<T>(result: SessionResult<T>): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

async function setup(seed: string) {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const sessionId = createRuntimeId("session", seed);
	const runtimeId = createRuntimeId("runtime", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const fence: WriterFence = { authorityId, tenantId, stream, leaseId: createRuntimeId("lease", seed), ownerRuntimeId: runtimeId, writerEpoch: 1, fencingToken: `${seed}-fence` };
	const store = new MemoryEventStore({ authorityId, tenantId, stream, validateFence: () => true });
	const writer = new EventWriter({ authorityId, tenantId, stream, store, fence, clock: () => new Date("2026-07-22T00:00:00.000Z") });
	valueOf(await writer.append({
		type: "session.created",
		principalId,
		traceId: createRuntimeId("trace", seed),
		payload: {
			origin: "test",
			runtimeId,
			featureDigest: D,
			initialGoalId: createRuntimeId("goal", seed),
			rootAgentId: createRuntimeId("agent", seed),
		},
	}));
	const sessionDirectory = await mkdtemp(join(tmpdir(), "runledger-lifecycle-")); roots.push(sessionDirectory);
	return { authorityId, tenantId, principalId, sessionId, runtimeId, stream, fence, store, writer, sessionDirectory };
}

class ReferenceSource implements StartupExternalReferenceSourcePort {
	public calls = 0;
	readonly #loader: StartupExternalReferenceSourcePort["loadReferences"];
	readonly #order: string[] | undefined;
	public constructor(
		resultOrLoader: LifecycleResult<ExternalReceiptReferenceSet> | StartupExternalReferenceSourcePort["loadReferences"],
		order?: string[],
	) {
		this.#loader = typeof resultOrLoader === "function"
			? resultOrLoader
			: async () => resultOrLoader;
		this.#order = order;
	}
	public async loadReferences(
		scope: Parameters<StartupExternalReferenceSourcePort["loadReferences"]>[0],
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptReferenceSet>> {
		this.calls += 1;
		this.#order?.push("references");
		return this.#loader(scope, signal);
	}
}

interface AuditorOptions {
	status?: ExternalReceiptAuditReceipt["status"];
	workspace?: StartupExternalReceiptAuditPort["auditWorkspaceLease"];
	approval?: StartupExternalReceiptAuditPort["auditApprovalDecision"];
	order?: string[];
}

interface AuditFixtureInput {
	sessionId: ReturnType<typeof createRuntimeId<"session">>;
	kind: ExternalReceiptAuditReceipt["subjectKind"];
	subjectId: string;
	subjectDigest: string;
	observedRevision: number;
	authorityId: ReturnType<typeof createRuntimeId<"authority">>;
	tenantId: ReturnType<typeof createRuntimeId<"tenant">>;
}

class Auditor implements StartupExternalReceiptAuditPort {
	public readonly calls = { workspace: 0, approval: 0 };
	readonly #status: ExternalReceiptAuditReceipt["status"];
	readonly #workspace: StartupExternalReceiptAuditPort["auditWorkspaceLease"] | undefined;
	readonly #approval: StartupExternalReceiptAuditPort["auditApprovalDecision"] | undefined;
	readonly #order: string[] | undefined;
	public constructor(options: AuditorOptions | ExternalReceiptAuditReceipt["status"] = {}) {
		const normalized = typeof options === "string" ? { status: options } : options;
		this.#status = normalized.status ?? "valid";
		this.#workspace = normalized.workspace;
		this.#approval = normalized.approval;
		this.#order = normalized.order;
	}
	private audit(input: AuditFixtureInput): LifecycleResult<ExternalReceiptAuditReceipt> {
		const authoritativeDigest = this.#status === "unavailable"
			? undefined
			: this.#status === "valid"
				? input.subjectDigest
				: canonicalDigest({ stale: input.subjectDigest });
		return {
			ok: true,
			value: createExternalReceiptAuditReceipt({
				authorityId: input.authorityId,
				tenantId: input.tenantId,
				sessionId: input.sessionId,
					subjectKind: input.kind,
					subjectId: input.subjectId,
					subjectDigest: input.subjectDigest,
					...(authoritativeDigest === undefined ? {} : {
						authoritativeDigest,
						observedRevision: input.observedRevision,
					}),
					status: this.#status,
					outcomeReason: this.#status === "valid"
						? "exact_match"
					: this.#status === "invalid"
						? "stale"
						: "external_unavailable",
				checkedAt: "2026-07-22T00:00:01.000Z",
				validThrough: null,
			}),
		};
	}
	public async auditWorkspaceLease(sessionId: ReturnType<typeof createRuntimeId<"session">>, lease: WorkspaceLeaseRef, signal?: AbortSignal): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		this.calls.workspace += 1;
		this.#order?.push(`workspace:${lease.leaseId}`);
		return this.#workspace
			? this.#workspace(sessionId, lease, signal)
			: this.audit({
				sessionId,
				kind: "workspace_lease",
				subjectId: lease.leaseId,
				subjectDigest: canonicalDigest(lease),
				observedRevision: lease.leaseRevision,
				authorityId: lease.authorityId,
				tenantId: lease.tenantId,
			});
	}
	public async auditApprovalDecision(sessionId: ReturnType<typeof createRuntimeId<"session">>, receipt: ApprovalReceiptRef, signal?: AbortSignal): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
		this.calls.approval += 1;
		this.#order?.push(`approval:${receipt.receiptId}`);
		return this.#approval
			? this.#approval(sessionId, receipt, signal)
			: this.audit({
				sessionId,
				kind: "approval_decision",
				subjectId: receipt.receiptId,
				subjectDigest: canonicalDigest(receipt),
				observedRevision: receipt.decisionRevision,
				authorityId: receipt.authorityId,
				tenantId: receipt.tenantId,
			});
	}
	public resultFor(input: AuditFixtureInput): LifecycleResult<ExternalReceiptAuditReceipt> {
		return this.audit(input);
	}
}

type StartupContext = Awaited<ReturnType<typeof setup>>;

function workspaceLease(context: StartupContext, seed: string, overrides: Partial<WorkspaceLeaseRef> = {}): WorkspaceLeaseRef {
	return {
		authorityId: context.authorityId,
		tenantId: context.tenantId,
		principalId: context.principalId,
		leaseId: createRuntimeId("lease", seed),
		workspaceId: createRuntimeId("workspace", seed),
		ownerRuntimeId: context.runtimeId,
		leaseRevision: 1,
		fencingTokenDigest: D,
		state: "active",
		...overrides,
	};
}

function approvalReceipt(context: StartupContext, seed: string): ApprovalReceiptRef {
	return {
		authorityId: context.authorityId,
		tenantId: context.tenantId,
		principalId: context.principalId,
		receiptId: createRuntimeId("receipt", `approval-${seed}`),
		approvalId: createRuntimeId("approval", seed),
		requestId: createRuntimeId("command", seed),
		requestDigest: D,
		ticketDigest: E,
		decision: "allowed",
		decisionRevision: 1,
		decidedAt: "2026-07-22T00:00:00.000Z",
		receiptDigest: canonicalDigest({ seed, kind: "approval" }),
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: D,
	};
}

function referenceSet(
	context: StartupContext,
	options: {
		completeness?: ExternalReceiptReferenceSet["completeness"];
		workspaceLeases?: readonly WorkspaceLeaseRef[];
		approvalDecisions?: readonly ApprovalReceiptRef[];
	} = {},
): ExternalReceiptReferenceSet {
	return {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		authorityId: context.authorityId,
		tenantId: context.tenantId,
		sessionId: context.sessionId,
		completeness: options.completeness ?? "complete",
		workspaceLeases: options.workspaceLeases ?? [],
		approvalDecisions: options.approvalDecisions ?? [],
	};
}

function unavailable(message: string): LifecycleResult<never> {
	return { ok: false, error: { code: "external_unavailable", message, retryable: true } };
}

function expectPausedWithoutExecution(
	report: StartupRecoveryReport,
	context: StartupContext,
	expectedReasons: readonly string[],
): void {
	const callback = vi.fn();
	const sideEffect = vi.fn();
	if (report.resumableSessionIds.includes(context.sessionId)) {
		callback();
		sideEffect();
	}
	expect(report.sessions[0]).toMatchObject({ disposition: "paused" });
	expect(report.sessions[0]?.reasons).toEqual(expect.arrayContaining(expectedReasons));
	expect(report.resumableSessionIds).toEqual([]);
	expect(callback).toHaveBeenCalledTimes(0);
	expect(sideEffect).toHaveBeenCalledTimes(0);
}

async function waitForBoundedSettlement(
	start: () => Promise<StartupRecoveryReport>,
	release: () => void,
): Promise<{ outcome: "settled" | "hung"; report: StartupRecoveryReport }> {
	const scan = start();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const observed = await Promise.race([
		scan.then((report) => ({ outcome: "settled" as const, report })),
		new Promise<{ outcome: "hung"; report?: never }>((resolve) => {
			timer = setTimeout(() => resolve({ outcome: "hung" }), 50);
		}),
	]);
	if (timer) clearTimeout(timer);
	release();
	const report = observed.outcome === "settled" ? observed.report : await scan;
	return { outcome: observed.outcome, report };
}

describe("startup recovery audit", () => {
	it("verifies Runtime integrity before loading external receipts and marks only proven state resumable", async () => {
		const context = await setup("startup-resume");
		const calls: string[] = [];
		const originalVerify = context.store.verify.bind(context.store);
		vi.spyOn(context.store, "verify").mockImplementation(async (stream) => { calls.push("integrity"); return originalVerify(stream); });
		const lease = workspaceLease(context, "startup-resume");
		const approval = approvalReceipt(context, "startup-resume");
		const references = new ReferenceSource({ ok: true, value: referenceSet(context, { workspaceLeases: [lease], approvalDecisions: [approval] }) }, calls);
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor({ order: calls }), clock: () => new Date("2026-07-22T00:00:02.000Z") }).scan([{ ...context }]);
		expect(calls).toEqual(["integrity", "references", `workspace:${lease.leaseId}`, `approval:${approval.receiptId}`]);
		expect(report).toMatchObject({ resumableSessionIds: [context.sessionId], sessions: [{ disposition: "resumable", reasons: [] }] });
		expect(report.sessions[0]?.auditReceipts).toHaveLength(2);
	});

	it("pauses unknown or invalid external receipt state instead of auto-executing", async () => {
		const context = await setup("startup-pause");
		const lease = workspaceLease(context, "startup-pause", { leaseId: context.fence.leaseId });
		const references = new ReferenceSource({ ok: true, value: referenceSet(context, { completeness: "unknown", workspaceLeases: [lease] }) });
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor("invalid") }).scan([{ ...context }]);
		expect(report.sessions[0]?.reasons).toEqual(["external_receipt_invalid", "external_reference_unknown"]);
		expectPausedWithoutExecution(report, context, ["external_receipt_invalid", "external_reference_unknown"]);
	});

	it("does not call external adapters after Runtime corruption", async () => {
		const context = await setup("startup-corrupt");
		vi.spyOn(context.store, "verify").mockResolvedValue({
			ok: true,
			value: {
				authorityId: context.authorityId,
				tenantId: context.tenantId,
				stream: context.stream,
				integrity: "corrupted",
				attestation: "unavailable",
				eventCount: 1,
			},
		});
		const references = new ReferenceSource(unavailable("should not load"));
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor() }).scan([{ ...context }]);
		expect(report.sessions[0]).toMatchObject({ disposition: "corrupted" });
		expect(references.calls).toBe(0);
	});

	it("pauses when the external reference source returns unavailable", async () => {
		const context = await setup("references-unavailable");
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource(unavailable("reference store unavailable")),
			auditor: new Auditor(),
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_reference_unavailable"]);
	});

	it("pauses when the external reference source throws", async () => {
		const context = await setup("references-throw");
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource(async () => { throw new Error("injected reference failure"); }),
			auditor: new Auditor(),
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_reference_unavailable"]);
	});

	it("pauses structurally invalid external reference sets", async () => {
		const context = await setup("references-invalid");
		const invalid = referenceSet(context);
		Reflect.set(invalid, "schemaVersion", 2);
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({ ok: true, value: invalid }),
			auditor: new Auditor(),
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_reference_unavailable"]);
	});

	it("pauses unknown reference completeness even when every returned receipt audits valid", async () => {
		const context = await setup("references-unknown");
		const lease = workspaceLease(context, "references-unknown");
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({ ok: true, value: referenceSet(context, { completeness: "unknown", workspaceLeases: [lease] }) }),
			auditor: new Auditor(),
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_reference_unknown"]);
	});

	it("bounds an external reference source that ignores an aborted timeout signal", async () => {
		const context = await setup("references-timeout");
		let release: (() => void) | undefined;
		const hanging = new Promise<LifecycleResult<ExternalReceiptReferenceSet>>((resolve) => {
			release = () => resolve(unavailable("reference timeout released"));
		});
		const coordinator = new StartupRecoveryCoordinator({
			references: new ReferenceSource(async () => hanging),
			auditor: new Auditor(),
			externalOperationTimeoutMs: 10,
		});
		const observed = await waitForBoundedSettlement(
			() => coordinator.scan([{ ...context }]),
			() => release?.(),
		);
		expectPausedWithoutExecution(observed.report, context, ["external_reference_unavailable"]);
		expect(observed.outcome).toBe("settled");
	});

	for (const subject of ["workspace", "approval"] as const) {
		for (const mode of ["invalid", "unavailable", "not_found", "failure", "throw", "uncorrelated"] as const) {
			it(`pauses ${subject} audit when the adapter returns ${mode}`, async () => {
				const context = await setup(`${subject}-${mode}`);
				const lease = workspaceLease(context, `${subject}-${mode}`);
				const approval = approvalReceipt(context, `${subject}-${mode}`);
					const baseline = new Auditor(mode === "invalid" ? "invalid" : mode === "unavailable" ? "unavailable" : "valid");
				const failAudit = async (
					sessionId: ReturnType<typeof createRuntimeId<"session">>,
					kind: ExternalReceiptAuditReceipt["subjectKind"],
					subjectId: string,
					authorityId: ReturnType<typeof createRuntimeId<"authority">>,
					tenantId: ReturnType<typeof createRuntimeId<"tenant">>,
				): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> => {
						const subjectDigest = subject === "workspace" ? canonicalDigest(lease) : canonicalDigest(approval);
						const observedRevision = subject === "workspace" ? lease.leaseRevision : approval.decisionRevision;
						if (mode === "failure") return unavailable(`${subject} audit unavailable`);
						if (mode === "throw") throw new Error(`injected ${subject} audit failure`);
						if (mode === "not_found") {
							return {
								ok: true,
								value: createExternalReceiptAuditReceipt({
									authorityId,
									tenantId,
									sessionId,
									subjectKind: kind,
									subjectId,
									subjectDigest,
									status: "unavailable",
									outcomeReason: "not_found",
									checkedAt: "2026-07-22T00:00:01.000Z",
									validThrough: null,
								}),
							};
						}
						const result = baseline.resultFor({ sessionId, kind, subjectId, subjectDigest, observedRevision, authorityId, tenantId });
						if (!result.ok || mode !== "uncorrelated") return result;
						const { schemaVersion: _schemaVersion, auditReceiptId: _auditReceiptId, receiptDigest: _receiptDigest, ...receiptBody } = result.value;
						return {
							ok: true,
							value: createExternalReceiptAuditReceipt({
								...receiptBody,
								subjectId: `${result.value.subjectId}-other`,
						}),
					};
				};
				const auditor = subject === "workspace"
					? new Auditor({ workspace: (sessionId, value) => failAudit(sessionId, "workspace_lease", value.leaseId, value.authorityId, value.tenantId) })
					: new Auditor({ approval: (sessionId, value) => failAudit(sessionId, "approval_decision", value.receiptId, value.authorityId, value.tenantId) });
				const report = await new StartupRecoveryCoordinator({
					references: new ReferenceSource({
						ok: true,
						value: referenceSet(context, {
							workspaceLeases: subject === "workspace" ? [lease] : [],
							approvalDecisions: subject === "approval" ? [approval] : [],
						}),
					}),
					auditor,
				}).scan([{ ...context }]);
				expectPausedWithoutExecution(
					report,
					context,
					[mode === "invalid" || mode === "uncorrelated" ? "external_receipt_invalid" : "external_receipt_unavailable"],
				);
				expect(auditor.calls[subject]).toBe(1);
			});
		}

		it(`bounds a hanging ${subject} auditor that ignores an aborted timeout signal`, async () => {
			const context = await setup(`${subject}-timeout`);
			const lease = workspaceLease(context, `${subject}-timeout`);
			const approval = approvalReceipt(context, `${subject}-timeout`);
			let release: (() => void) | undefined;
			const hanging = new Promise<LifecycleResult<ExternalReceiptAuditReceipt>>((resolve) => {
				release = () => resolve(unavailable(`${subject} timeout released`));
			});
			const auditor = subject === "workspace"
				? new Auditor({ workspace: async () => hanging })
				: new Auditor({ approval: async () => hanging });
			const coordinator = new StartupRecoveryCoordinator({
				references: new ReferenceSource({
					ok: true,
					value: referenceSet(context, {
						workspaceLeases: subject === "workspace" ? [lease] : [],
						approvalDecisions: subject === "approval" ? [approval] : [],
					}),
				}),
				auditor,
				externalOperationTimeoutMs: 10,
			});
			const observed = await waitForBoundedSettlement(
				() => coordinator.scan([{ ...context }]),
				() => release?.(),
			);
			expectPausedWithoutExecution(observed.report, context, ["external_receipt_unavailable"]);
			expect(observed.outcome).toBe("settled");
		});
	}

	it("keeps partial valid audit receipts but never runs a callback after a later audit fails", async () => {
		const context = await setup("audit-partial");
		const first = workspaceLease(context, "audit-partial-first");
		const second = workspaceLease(context, "audit-partial-second");
		const approval = approvalReceipt(context, "audit-partial");
		const order: string[] = [];
		const baseline = new Auditor();
		const auditor = new Auditor({
			order,
			workspace: async (sessionId, lease) => {
				if (lease.leaseId === second.leaseId) throw new Error("injected second audit failure");
				return baseline.resultFor({
					sessionId,
					kind: "workspace_lease",
					subjectId: lease.leaseId,
					subjectDigest: canonicalDigest(lease),
					observedRevision: lease.leaseRevision,
					authorityId: lease.authorityId,
					tenantId: lease.tenantId,
				});
			},
		});
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({ ok: true, value: referenceSet(context, { completeness: "partial", workspaceLeases: [first, second], approvalDecisions: [approval] }) }, order),
			auditor,
		}).scan([{ ...context }]);
		expect(order).toEqual(["references", `workspace:${first.leaseId}`, `workspace:${second.leaseId}`, `approval:${approval.receiptId}`]);
		expect(report.sessions[0]?.auditReceipts).toHaveLength(2);
		expectPausedWithoutExecution(report, context, ["external_receipt_unavailable", "external_reference_unknown"]);
	});

	it("continues auditing after a fast explicit failure", async () => {
		const context = await setup("audit-explicit-failure-continues");
		const first = workspaceLease(context, "audit-explicit-failure-first");
		const second = workspaceLease(context, "audit-explicit-failure-second");
		const baseline = new Auditor();
		const auditor = new Auditor({
			workspace: async (sessionId, lease) => lease.leaseId === first.leaseId
				? unavailable("injected explicit audit failure")
				: baseline.resultFor({
						sessionId,
						kind: "workspace_lease",
						subjectId: lease.leaseId,
						subjectDigest: canonicalDigest(lease),
						observedRevision: lease.leaseRevision,
						authorityId: lease.authorityId,
						tenantId: lease.tenantId,
					}),
		});
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({
				ok: true,
				value: referenceSet(context, { workspaceLeases: [first, second] }),
			}),
			auditor,
		}).scan([{ ...context }]);
		expect(auditor.calls.workspace).toBe(2);
		expect(report.sessions[0]?.auditReceipts).toHaveLength(1);
		expectPausedWithoutExecution(report, context, ["external_receipt_unavailable"]);
	});

	it("rejects a stale Workspace audit with the same lease id but a different subject digest", async () => {
		const context = await setup("workspace-stale-binding");
		const stale = workspaceLease(context, "workspace-stale-binding");
		const current = { ...stale, leaseRevision: stale.leaseRevision + 1, fencingTokenDigest: E };
		const baseline = new Auditor();
		const auditor = new Auditor({
			workspace: async (sessionId, lease) => {
				return baseline.resultFor({
					sessionId,
					kind: "workspace_lease",
					subjectId: lease.leaseId,
					subjectDigest: canonicalDigest(stale),
					observedRevision: stale.leaseRevision,
					authorityId: lease.authorityId,
					tenantId: lease.tenantId,
				});
			},
		});
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({ ok: true, value: referenceSet(context, { workspaceLeases: [current] }) }),
			auditor,
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_receipt_invalid"]);
	});

	it.each(["workspace", "approval"] as const)(
		"rejects a valid %s audit whose observed revision is not the canonical subject revision",
		async (subject) => {
			const context = await setup(`${subject}-observed-revision`);
			const lease = workspaceLease(context, `${subject}-observed-revision`);
			const approval = approvalReceipt(context, `${subject}-observed-revision`);
			const auditor = new Auditor(subject === "workspace"
				? {
					workspace: async (sessionId, candidate) => ({
						ok: true,
						value: createExternalReceiptAuditReceipt({
							authorityId: candidate.authorityId,
							tenantId: candidate.tenantId,
							sessionId,
							subjectKind: "workspace_lease",
							subjectId: candidate.leaseId,
							subjectDigest: canonicalDigest(candidate),
							authoritativeDigest: canonicalDigest(candidate),
							observedRevision: candidate.leaseRevision + 1,
							status: "valid",
							outcomeReason: "exact_match",
							checkedAt: "2026-07-22T00:00:01.000Z",
							validThrough: null,
						}),
					}),
				}
				: {
					approval: async (sessionId, candidate) => ({
						ok: true,
						value: createExternalReceiptAuditReceipt({
							authorityId: candidate.authorityId,
							tenantId: candidate.tenantId,
							sessionId,
							subjectKind: "approval_decision",
							subjectId: candidate.receiptId,
							subjectDigest: canonicalDigest(candidate),
							authoritativeDigest: canonicalDigest(candidate),
							observedRevision: candidate.decisionRevision + 1,
							status: "valid",
							outcomeReason: "exact_match",
							checkedAt: "2026-07-22T00:00:01.000Z",
							validThrough: null,
						}),
					}),
				});
			const report = await new StartupRecoveryCoordinator({
				references: new ReferenceSource({
					ok: true,
					value: referenceSet(context, {
						workspaceLeases: subject === "workspace" ? [lease] : [],
						approvalDecisions: subject === "approval" ? [approval] : [],
					}),
				}),
				auditor,
			}).scan([{ ...context }]);
			expectPausedWithoutExecution(report, context, ["external_receipt_invalid"]);
		},
	);

	it("rejects a valid approval audit whose validity horizon differs from the canonical expiry", async () => {
		const context = await setup("approval-valid-through");
		const approval = {
			...approvalReceipt(context, "approval-valid-through"),
			expiresAt: "2026-07-22T00:10:00.000Z",
		};
		const auditor = new Auditor({
			approval: async (sessionId, candidate) => ({
				ok: true,
				value: createExternalReceiptAuditReceipt({
					authorityId: candidate.authorityId,
					tenantId: candidate.tenantId,
					sessionId,
					subjectKind: "approval_decision",
					subjectId: candidate.receiptId,
					subjectDigest: canonicalDigest(candidate),
					authoritativeDigest: canonicalDigest(candidate),
					observedRevision: candidate.decisionRevision,
					status: "valid",
					outcomeReason: "exact_match",
					checkedAt: "2026-07-22T00:00:01.000Z",
					validThrough: "2026-07-22T00:09:00.000Z",
				}),
			}),
		});
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({
				ok: true,
				value: referenceSet(context, { approvalDecisions: [approval] }),
			}),
			auditor,
			clock: () => new Date("2026-07-22T00:00:02.000Z"),
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_receipt_invalid"]);
	});

	it("rejects a non-allowed canonical approval even when the auditor reports it as valid", async () => {
		const context = await setup("approval-denied-valid-audit");
		const approval = {
			...approvalReceipt(context, "approval-denied-valid-audit"),
			decision: "denied" as const,
		};
		const auditor = new Auditor({
			approval: async (sessionId, candidate) => ({
				ok: true,
				value: createExternalReceiptAuditReceipt({
					authorityId: candidate.authorityId,
					tenantId: candidate.tenantId,
					sessionId,
					subjectKind: "approval_decision",
					subjectId: candidate.receiptId,
					subjectDigest: canonicalDigest(candidate),
					authoritativeDigest: canonicalDigest(candidate),
					observedRevision: candidate.decisionRevision,
					status: "valid",
					outcomeReason: "exact_match",
					checkedAt: "2026-07-22T00:00:01.000Z",
					validThrough: null,
				}),
			}),
		});
		const report = await new StartupRecoveryCoordinator({
			references: new ReferenceSource({
				ok: true,
				value: referenceSet(context, { approvalDecisions: [approval] }),
			}),
			auditor,
		}).scan([{ ...context }]);
		expectPausedWithoutExecution(report, context, ["external_receipt_invalid"]);
	});

	it("stops after the first timed-out audit under the default total scan budget", async () => {
		const context = await setup("external-audit-timeout-stop");
		const leases = Array.from({ length: 128 }, (_value, index) =>
			workspaceLease(context, `external-audit-timeout-stop-${index}`));
		let release: (() => void) | undefined;
		const hanging = new Promise<LifecycleResult<ExternalReceiptAuditReceipt>>((resolve) => {
			release = () => resolve(unavailable("external audit timeout released"));
		});
		const auditor = new Auditor({ workspace: async () => hanging });
		const coordinator = new StartupRecoveryCoordinator({
			references: new ReferenceSource({
				ok: true,
				value: referenceSet(context, { workspaceLeases: leases }),
			}),
			auditor,
			externalOperationTimeoutMs: 10,
		});
		const observed = await waitForBoundedSettlement(
			() => coordinator.scan([{ ...context }]),
			() => release?.(),
		);
		expect(observed.outcome).toBe("settled");
		expect(auditor.calls.workspace).toBe(1);
		expectPausedWithoutExecution(observed.report, context, ["external_receipt_unavailable"]);
	});

	it("stops after an in-flight audit abort even when the adapter ignores its signal", async () => {
		const context = await setup("external-audit-parent-abort");
		const leases = Array.from({ length: 64 }, (_value, index) =>
			workspaceLease(context, `external-audit-parent-abort-${index}`));
		const controller = new AbortController();
		let release: (() => void) | undefined;
		const hanging = new Promise<LifecycleResult<ExternalReceiptAuditReceipt>>((resolve) => {
			release = () => resolve(unavailable("external audit abort released"));
		});
		const auditor = new Auditor({
			workspace: async () => {
				controller.abort("injected parent abort");
				return hanging;
			},
		});
		const coordinator = new StartupRecoveryCoordinator({
			references: new ReferenceSource({
				ok: true,
				value: referenceSet(context, { workspaceLeases: leases }),
			}),
			auditor,
			externalOperationTimeoutMs: 1_000,
		});
		const observed = await waitForBoundedSettlement(
			() => coordinator.scan([{ ...context }], controller.signal),
			() => release?.(),
		);
		expect(observed.outcome).toBe("settled");
		expect(auditor.calls.workspace).toBe(1);
		expectPausedWithoutExecution(observed.report, context, ["external_receipt_unavailable"]);
	});
});
