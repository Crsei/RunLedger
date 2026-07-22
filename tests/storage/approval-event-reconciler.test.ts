import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalReceiptRef, ApprovalTicket } from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../src/runtime/session/snapshot.ts";
import {
	MemoryApprovalStateStore,
	createApprovalReceipt,
	createApprovalSupersessionReceipt,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
	type ApprovalStateStorePort,
} from "../../src/security/permission/approval-coordinator.ts";
import { reconcileApprovalEvents } from "../../src/storage/approval-event-reconciler.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const roots: string[] = [];
const CREATED_AT = "2026-07-23T00:00:00.000Z";
const EXPIRES_AT = "2026-07-23T00:05:00.000Z";
const AFTER_EXPIRY = new Date("2026-07-23T00:06:00.000Z");

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(seed: string) {
	const root = await mkdtemp(join(tmpdir(), `runledger-approval-reconcile-${seed}-`));
	roots.push(root);
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
	});
	const turn = await manager.sessionEvents().beginTurn();
	const tool = await manager.sessionEvents().requestTool(turn, `provider-${seed}`, "write", { path: "fixture.ts" });
	const identity = manager.identity();
	const requestId = createRuntimeId("command", `approval-reconcile-${seed}`);
	const approvalId = createRuntimeId("approval", `approval-reconcile-${seed}`);
	const argumentsDigest = canonicalDigest({ path: "fixture.ts" });
	const ticket: ApprovalTicket = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		approvalId,
		request: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			requestId,
			approvalId,
			sessionId: manager.sessionId(),
			runtimeId: manager.runtimeId(),
			runtimeGeneration: 1,
			turnId: turn.turnId,
			toolCallId: tool.toolCallId,
			capability: "workspace_write",
			argumentsDigest,
			workspaceEnvelopeDigest: canonicalDigest("workspace-envelope"),
			policyDigest: canonicalDigest("policy"),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest("resource-scope"),
			commandScopeDigest: canonicalDigest("command-scope"),
		},
		scope: "once",
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
	};
	await manager.sessionEvents().recordApprovalRequested(ticket, {
		attemptId: createRuntimeId("command", `attempt-${seed}`),
		resourceKind: "filesystem",
		summary: {
			operation: "write",
			toolIdentityDigest: canonicalDigest("write"),
			targetDigest: canonicalDigest("fixture.ts"),
			environmentKeyDigests: [],
		},
	});
	return { manager, ticket };
}

describe("approval event reconciliation", () => {
	it("fills the store-commit/event-append half commit exactly once", async () => {
		const { manager, ticket } = await fixture("store-only");
		const store = new MemoryApprovalStateStore();
		const receipt = createApprovalReceipt(
			ticket,
			{ decision: "allow-once", decidedBy: createRuntimeId("principal", "approval-reconcile-approver") },
			"2026-07-23T00:01:00.000Z",
		);
		expect((await store.commit(receipt, 0)).ok).toBe(true);

		const first = await reconcileApprovalEvents(manager, store, () => new Date("2026-07-23T00:02:00.000Z"));
		const second = await reconcileApprovalEvents(manager, store, () => new Date("2026-07-23T00:02:00.000Z"));

		expect(first).toMatchObject({ ok: true, value: { appended: 1, matched: 0 } });
		expect(second).toMatchObject({ ok: true, value: { appended: 0, matched: 1 } });
		const events = await readAllRuntimeEvents(manager.eventStore());
		expect(events.ok && events.value.filter((event) => event.type === "permission.decided")).toHaveLength(1);
		await manager.closeAll();
	});

	it("fails closed when a terminal event has no authoritative store receipt", async () => {
		const { manager, ticket } = await fixture("event-only");
		const receipt = createApprovalReceipt(
			ticket,
			{ decision: "deny", decidedBy: createRuntimeId("principal", "approval-reconcile-denier") },
			"2026-07-23T00:01:00.000Z",
		);
		await manager.sessionEvents().recordApprovalTerminal(ticket, receipt);

		expect(await reconcileApprovalEvents(manager, new MemoryApprovalStateStore(), () => AFTER_EXPIRY)).toMatchObject({
			ok: false,
			error: { code: "integrity_failed" },
		});
		await manager.closeAll();
	});

	it("durably advances an elapsed allowed receipt before appending expiry", async () => {
		const { manager, ticket } = await fixture("expiry");
		const store = new MemoryApprovalStateStore();
		const allowed = createApprovalReceipt(
			ticket,
			{ decision: "allow-once", decidedBy: createRuntimeId("principal", "approval-reconcile-expiry") },
			"2026-07-23T00:01:00.000Z",
		);
		expect((await store.commit(allowed, 0)).ok).toBe(true);

		const reconciled = await reconcileApprovalEvents(manager, store, () => AFTER_EXPIRY);
		if (!reconciled.ok) throw new Error(reconciled.error.message);
		expect(reconciled).toMatchObject({
			ok: true,
			value: { appended: 2, transitioned: 1 },
		});
		expect(await store.read(ticket.approvalId)).toMatchObject({
			decision: "expired",
			decisionRevision: 2,
			decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID,
		});
		const events = await readAllRuntimeEvents(manager.eventStore());
		expect(events.ok && events.value.filter((event) => event.type === "permission.expired")).toHaveLength(1);
		await manager.closeAll();
	});

	it("does not append a revision-two store receipt whose immutable evidence drifted", async () => {
		const { manager, ticket } = await fixture("drifted-revision-two");
		const allowed = createApprovalReceipt(
			ticket,
			{ decision: "allow-once", decidedBy: createRuntimeId("principal", "approval-reconcile-original-approver") },
			"2026-07-23T00:01:00.000Z",
		);
		await manager.sessionEvents().recordApprovalTerminal(ticket, allowed);
		const revoked = createApprovalSupersessionReceipt(
			allowed,
			"revoked",
			"2026-07-23T00:02:00.000Z",
			createRuntimeId("principal", "approval-reconcile-revoker"),
		);
		const { receiptDigest: _revokedDigest, ...revokedBody } = revoked;
		const driftedBody: Omit<ApprovalReceiptRef, "receiptDigest"> = {
			...revokedBody,
			originalInputDigest: canonicalDigest("drifted-input"),
		};
		const drifted: ApprovalReceiptRef = {
			...driftedBody,
			receiptDigest: canonicalDigest(driftedBody),
		};
		const store: ApprovalStateStorePort = {
			read: async () => drifted,
			commit: async () => ({
				ok: false,
				error: { code: "approval_stale", message: "unexpected commit", retryable: false },
			}),
			withCurrentApproval: async () => ({
				ok: false,
				error: { code: "approval_stale", message: "unexpected fence", retryable: false },
			}),
		};

		expect(await reconcileApprovalEvents(manager, store, () => AFTER_EXPIRY)).toMatchObject({
			ok: false,
			error: { code: "integrity_failed" },
		});
		const events = await readAllRuntimeEvents(manager.eventStore());
		expect(events.ok && events.value.filter((event) =>
			event.type === "permission.decided" || event.type === "permission.revoked"
		)).toHaveLength(1);
		await manager.closeAll();
	});
});
