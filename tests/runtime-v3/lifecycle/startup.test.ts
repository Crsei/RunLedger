import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";
import { StartupRecoveryCoordinator } from "../../../src/runtime/lifecycle/startup.ts";
import { LIFECYCLE_SCHEMA_VERSION, type ExternalReceiptAuditReceipt, type ExternalReceiptReferenceSet, type LifecycleResult, type StartupExternalReceiptAuditPort, type StartupExternalReferenceSourcePort } from "../../../src/runtime/lifecycle/recovery.ts";
import type { ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type { WorkspaceLeaseRef } from "../../../src/runtime/protocol/v3/workspace.ts";

const D = "a".repeat(64);
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
	public result: LifecycleResult<ExternalReceiptReferenceSet>;
	public constructor(result: LifecycleResult<ExternalReceiptReferenceSet>) { this.result = result; }
	public async loadReferences(): Promise<LifecycleResult<ExternalReceiptReferenceSet>> { this.calls += 1; return this.result; }
}

class Auditor implements StartupExternalReceiptAuditPort {
	public status: ExternalReceiptAuditReceipt["status"];
	public constructor(status: ExternalReceiptAuditReceipt["status"] = "valid") { this.status = status; }
	private audit(sessionId: ReturnType<typeof createRuntimeId<"session">>, kind: ExternalReceiptAuditReceipt["subjectKind"], subjectId: string, authorityId: ReturnType<typeof createRuntimeId<"authority">>, tenantId: ReturnType<typeof createRuntimeId<"tenant">>): LifecycleResult<ExternalReceiptAuditReceipt> {
		return { ok: true, value: { schemaVersion: LIFECYCLE_SCHEMA_VERSION, authorityId, tenantId, sessionId, auditReceiptId: createRuntimeId("receipt", `audit-${kind}`), subjectKind: kind, subjectId, status: this.status, checkedAt: "2026-07-22T00:00:01.000Z", receiptDigest: D } };
	}
	public async auditWorkspaceLease(sessionId: ReturnType<typeof createRuntimeId<"session">>, lease: WorkspaceLeaseRef): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> { return this.audit(sessionId, "workspace_lease", lease.leaseId, lease.authorityId, lease.tenantId); }
	public async auditApprovalDecision(sessionId: ReturnType<typeof createRuntimeId<"session">>, receipt: ApprovalReceiptRef): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> { return this.audit(sessionId, "approval_decision", receipt.receiptId, receipt.authorityId, receipt.tenantId); }
}

describe("startup recovery audit", () => {
	it("verifies Runtime integrity before loading external receipts and marks only proven state resumable", async () => {
		const context = await setup("startup-resume");
		const calls: string[] = [];
		const originalVerify = context.store.verify.bind(context.store);
		vi.spyOn(context.store, "verify").mockImplementation(async (stream) => { calls.push("integrity"); return originalVerify(stream); });
		const references = new ReferenceSource({ ok: true, value: { schemaVersion: LIFECYCLE_SCHEMA_VERSION, authorityId: context.authorityId, tenantId: context.tenantId, sessionId: context.sessionId, completeness: "complete", workspaceLeases: [], approvalDecisions: [] } });
		vi.spyOn(references, "loadReferences").mockImplementation(async () => { calls.push("external"); references.calls += 1; return references.result; });
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor(), clock: () => new Date("2026-07-22T00:00:02.000Z") }).scan([{ ...context }]);
		expect(calls).toEqual(["integrity", "external"]);
		expect(report).toMatchObject({ resumableSessionIds: [context.sessionId], sessions: [{ disposition: "resumable", reasons: [] }] });
	});

	it("pauses unknown or invalid external receipt state instead of auto-executing", async () => {
		const context = await setup("startup-pause");
		const lease: WorkspaceLeaseRef = {
			authorityId: context.authorityId, tenantId: context.tenantId, principalId: context.principalId,
			leaseId: context.fence.leaseId, workspaceId: createRuntimeId("workspace", "startup-pause"), ownerRuntimeId: context.runtimeId,
			leaseRevision: 1, fencingTokenDigest: D, state: "active",
		};
		const references = new ReferenceSource({ ok: true, value: { schemaVersion: LIFECYCLE_SCHEMA_VERSION, authorityId: context.authorityId, tenantId: context.tenantId, sessionId: context.sessionId, completeness: "unknown", workspaceLeases: [lease], approvalDecisions: [] } });
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor("invalid") }).scan([{ ...context }]);
		expect(report.sessions[0]).toMatchObject({ disposition: "paused" });
		expect(report.sessions[0]?.reasons).toEqual(["external_receipt_invalid", "external_reference_unknown"]);
		expect(report.resumableSessionIds).toEqual([]);
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
		const references = new ReferenceSource({ ok: false, error: { code: "external_unavailable", message: "should not load", retryable: true } });
		const report = await new StartupRecoveryCoordinator({ references, auditor: new Auditor() }).scan([{ ...context }]);
		expect(report.sessions[0]).toMatchObject({ disposition: "corrupted" });
		expect(references.calls).toBe(0);
	});
});
