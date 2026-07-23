import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalTicket } from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import {
	MemoryApprovalStateStore,
	createApprovalReceipt,
	createApprovalSupersessionReceipt,
} from "../../../src/security/permission/approval-coordinator.ts";
import { DurableStartupExternalReceiptAuditor } from "../../../src/storage/startup-receipt-auditor.ts";
import { GovernedV3SessionRuntime } from "../../../src/storage/v3-runtime-adapter.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const roots: string[] = [];
const features = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const REQUESTED_AT = "2026-07-23T00:00:00.000Z";
const DECIDED_AT = "2026-07-23T00:01:00.000Z";
const FUTURE_EXPIRY = "2026-07-23T01:00:00.000Z";
const APPROVER = createRuntimeId("principal", "governed-approval-reconciliation-approver");
const SUPERSESSION_ACTOR = createRuntimeId("principal", "governed-approval-reconciliation-system");

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw new Error("operation rejected with a non-Error value");
	}
	throw new Error("operation unexpectedly resolved");
}

async function approvalFixture(seed: string, expiresAt = FUTURE_EXPIRY) {
	const root = await mkdtemp(join(tmpdir(), `runledger-governed-approval-${seed}-`));
	roots.push(root);
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features,
	});
	const turn = await manager.sessionEvents().beginTurn();
	const tool = await manager.sessionEvents().requestTool(
		turn,
		`provider-${seed}`,
		"write",
		{ path: "fixture.ts" },
	);
	const identity = manager.identity();
	const approvalId = createRuntimeId("approval", `governed-approval-${seed}`);
	const ticket: ApprovalTicket = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		approvalId,
		request: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			requestId: createRuntimeId("command", `governed-approval-request-${seed}`),
			approvalId,
			sessionId: manager.sessionId(),
			runtimeId: manager.runtimeId(),
			runtimeGeneration: 1,
			turnId: turn.turnId,
			toolCallId: tool.toolCallId,
			capability: "workspace_write",
			argumentsDigest: tool.argumentsDigest,
			workspaceEnvelopeDigest: canonicalDigest({ seed, kind: "workspace-envelope" }),
			policyDigest: canonicalDigest({ seed, kind: "policy" }),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest({ seed, kind: "resource-scope" }),
			commandScopeDigest: canonicalDigest({ seed, kind: "command-scope" }),
		},
		scope: "once",
		createdAt: REQUESTED_AT,
		expiresAt,
	};
	await manager.sessionEvents().recordApprovalRequested(ticket, {
		attemptId: createRuntimeId("command", `governed-approval-attempt-${seed}`),
		resourceKind: "filesystem",
		summary: {
			operation: "write",
			toolIdentityDigest: tool.toolIdentityDigest,
			targetDigest: canonicalDigest("fixture.ts"),
			environmentKeyDigests: [],
		},
	});
	await manager.sessionEvents().failTool(tool, new Error("fixture stops before execution"), true);
	await manager.sessionEvents().finishTurn(turn, { ok: false }, "approval_fixture");
	return { manager, filePath: manager.filePath(), ticket };
}

function auditor(store: MemoryApprovalStateStore, clock: () => Date) {
	return new DurableStartupExternalReceiptAuditor({
		workspaceLeaseStore: { read: async () => undefined },
		approvalStore: store,
		clock,
	});
}

async function events(manager: V3SessionManager) {
	const replay = await readAllRuntimeEvents(manager.eventStore());
	if (!replay.ok) throw new Error(replay.error.message);
	return replay.value;
}

async function eventsFromFile(filePath: string) {
	const manager = await V3SessionManager.open(filePath, features);
	try {
		return await events(manager);
	} finally {
		await manager.closeAll();
	}
}

function effectProbes() {
	return {
		model: vi.fn(async () => undefined),
		tool: vi.fn(async () => undefined),
		child: vi.fn(async () => undefined),
	};
}

async function attemptEffects(
	governed: GovernedV3SessionRuntime,
	probes: ReturnType<typeof effectProbes>,
) {
	return governed.runIfResumable(async () => {
		await probes.model();
		await probes.tool();
		await probes.child();
	});
}

describe("GovernedV3SessionRuntime approval restart reconciliation", () => {
	it("fills a store-only allowed decision and re-evaluates the pending admission", async () => {
		const fixture = await approvalFixture("store-only");
		const store = new MemoryApprovalStateStore();
		const allowed = createApprovalReceipt(
			fixture.ticket,
			{ decision: "allow-once", decidedBy: APPROVER },
			DECIDED_AT,
		);
		expect((await store.commit(allowed, 0)).ok).toBe(true);
		await fixture.manager.closeAll();
		const pending = await V3SessionManager.open(fixture.filePath, features);
		try {
			expect(pending.recoveryDecision()).toMatchObject({
				kind: "pause_for_approval",
				reasons: ["pending_permission"],
			});
		} finally {
			await pending.closeAll();
		}

		const now = () => new Date("2026-07-23T00:02:00.000Z");
		const governed = await GovernedV3SessionRuntime.open({
			filePath: fixture.filePath,
			features,
			externalReceiptAuditor: auditor(store, now),
			clock: now,
		});
		try {
			expect(governed.startupReport().sessions[0]).toMatchObject({
				disposition: "resumable",
				reasons: [],
			});
			const probes = effectProbes();
			const admitted = await governed.runIfResumable(async (manager) => {
				const terminal = (await events(manager)).filter((event) =>
					event.type === "permission.decided" && event.payload.approvalId === fixture.ticket.approvalId);
				expect(terminal).toHaveLength(1);
				expect(terminal[0]?.payload).toMatchObject({
					receiptId: allowed.receiptId,
					receiptDigest: allowed.receiptDigest,
					decisionRevision: 1,
					decidedBy: APPROVER,
				});
				await probes.model();
				await probes.tool();
				await probes.child();
				return "admitted";
			});
			expect(admitted).toEqual({ ok: true, value: "admitted" });
			expect(probes.model).toHaveBeenCalledOnce();
			expect(probes.tool).toHaveBeenCalledOnce();
			expect(probes.child).toHaveBeenCalledOnce();
		} finally {
			await governed.close();
		}
	});

	it("fails closed on an event-only decision before model, tool, or child work", async () => {
		const fixture = await approvalFixture("event-only");
		const orphan = createApprovalReceipt(
			fixture.ticket,
			{ decision: "allow-once", decidedBy: APPROVER },
			DECIDED_AT,
		);
		await fixture.manager.sessionEvents().recordApprovalTerminal(fixture.ticket, orphan);
		await fixture.manager.closeAll();
		const store = new MemoryApprovalStateStore();
		const probes = effectProbes();
		const now = () => new Date("2026-07-23T00:02:00.000Z");

		const error = await rejectedError((async () => {
			const governed = await GovernedV3SessionRuntime.open({
				filePath: fixture.filePath,
				features,
				externalReceiptAuditor: auditor(store, now),
				clock: now,
			});
			try {
				await attemptEffects(governed, probes);
			} finally {
				await governed.close();
			}
		})());

		expect(error.message).toContain("approval startup reconciliation failed");
		expect(error.message).toContain("canonical approval terminal has no authoritative store receipt");
		expect(probes.model).not.toHaveBeenCalled();
		expect(probes.tool).not.toHaveBeenCalled();
		expect(probes.child).not.toHaveBeenCalled();
	});

	it.each([
		{
			decision: "revoked" as const,
			decidedAt: "2026-07-23T00:03:00.000Z",
			now: "2026-07-23T00:04:00.000Z",
			eventType: "permission.revoked" as const,
		},
		{
			decision: "expired" as const,
			// 重启 reconciliation 通常晚于原 expiry；事件必须仍能无损重建 receipt。
			decidedAt: "2026-07-23T01:01:00.000Z",
			now: "2026-07-23T01:02:00.000Z",
			eventType: "permission.expired" as const,
		},
	])("fills a missing $decision revision-two terminal and blocks admission", async (scenario) => {
		const fixture = await approvalFixture(`superseded-${scenario.decision}`);
		const store = new MemoryApprovalStateStore();
		const allowed = createApprovalReceipt(
			fixture.ticket,
			{ decision: "allow-once", decidedBy: APPROVER },
			DECIDED_AT,
		);
		expect((await store.commit(allowed, 0)).ok).toBe(true);
		await fixture.manager.sessionEvents().recordApprovalTerminal(fixture.ticket, allowed);
		const superseded = createApprovalSupersessionReceipt(
			allowed,
			scenario.decision,
			scenario.decidedAt,
			SUPERSESSION_ACTOR,
		);
		expect((await store.commit(superseded, 1)).ok).toBe(true);
		await fixture.manager.closeAll();

		const clock = () => new Date(scenario.now);
		const governed = await GovernedV3SessionRuntime.open({
			filePath: fixture.filePath,
			features,
			externalReceiptAuditor: auditor(store, clock),
			clock,
		});
		const report = governed.startupReport().sessions[0];
		const probes = effectProbes();
		const admission = await attemptEffects(governed, probes);
		await governed.close();
		const terminal = (await eventsFromFile(fixture.filePath)).filter((event) =>
			event.type === scenario.eventType && event.payload.approvalId === fixture.ticket.approvalId);

		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.payload).toMatchObject({
			receiptId: superseded.receiptId,
			receiptDigest: superseded.receiptDigest,
			decisionRevision: 2,
			decidedBy: SUPERSESSION_ACTOR,
		});
		expect(report).toMatchObject({
			disposition: "paused",
			reasons: ["external_receipt_invalid"],
		});
		expect(admission).toMatchObject({
			ok: false,
			error: { code: "external_unavailable" },
		});
		expect(probes.model).not.toHaveBeenCalled();
		expect(probes.tool).not.toHaveBeenCalled();
		expect(probes.child).not.toHaveBeenCalled();
	});

	it("does not append a duplicate when the durable store and event are already exact", async () => {
		const fixture = await approvalFixture("exact");
		const store = new MemoryApprovalStateStore();
		const allowed = createApprovalReceipt(
			fixture.ticket,
			{ decision: "allow-once", decidedBy: APPROVER },
			DECIDED_AT,
		);
		expect((await store.commit(allowed, 0)).ok).toBe(true);
		await fixture.manager.sessionEvents().recordApprovalTerminal(fixture.ticket, allowed);
		const sequenceBefore = fixture.manager.writer().currentHead()?.sequence;
		await fixture.manager.closeAll();

		const now = () => new Date("2026-07-23T00:02:00.000Z");
		const governed = await GovernedV3SessionRuntime.open({
			filePath: fixture.filePath,
			features,
			externalReceiptAuditor: auditor(store, now),
			clock: now,
		});
		try {
			expect(governed.startupReport().sessions[0]).toMatchObject({ disposition: "resumable" });
			const admitted = await governed.runIfResumable(async (manager) => {
				const replay = await events(manager);
				expect(replay.at(-1)?.sequence).toBe(sequenceBefore);
				expect(replay.filter((event) =>
					event.type === "permission.decided" && event.payload.approvalId === fixture.ticket.approvalId,
				)).toHaveLength(1);
				return true;
			});
			expect(admitted).toEqual({ ok: true, value: true });
		} finally {
			await governed.close();
		}
	});
});
