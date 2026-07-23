import { describe, expect, it } from "vitest";
import {
	applyAgentGraphCommand,
	agentBudgetSettlementRequestDigest,
	agentCleanupReceiptDigest,
	agentCleanupRequestDigest,
	agentRuntimeReleaseRequestDigest,
	agentWorkspaceReleaseRequestDigest,
	createAgentSemanticTerminalRecord,
} from "../../../src/runtime/agents/graph-store.ts";
import { createAgentResidencyReceipt } from "../../../src/runtime/agents/residency.ts";
import type {
	AgentBudgetSettlementReceiptRef,
	AgentCleanupReceiptRef,
	AgentGraphSemanticCommand,
	AgentRuntimeReleaseReceiptRef,
	AgentWorkspaceReceiptRef,
} from "../../../src/runtime/agents/types.ts";
import { DEFAULT_AGENT_GRAPH_LIMITS } from "../../../src/runtime/agents/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { digest, key, rootRegistration, runtimeFakes, spawnRequest, zeroUsage } from "./helpers.ts";

const NOW = "2026-07-23T01:02:03.000Z";

describe("Agent cleanup graph", () => {
	it("keeps semantic terminal and cleanup terminal separate while enforcing the release order", async () => {
		const runtime = runtimeFakes();
		const root = rootRegistration();
		expect((await runtime.supervisor.registerRoot(root)).ok).toBe(true);
		const spawned = await runtime.supervisor.spawn(spawnRequest(root.capabilityGrant));
		if (!spawned.ok) throw new Error(spawned.error.message);
		const child = spawned.value.node;
		const usage = zeroUsage();
		if (!child.launchReceipt || !child.residency || !child.budgetReservation) {
			throw new Error("spawned child lacks release correlations");
		}

		let loaded = await runtime.store.load(root.agentId);
		if (!loaded.ok) throw new Error(loaded.error.message);
		const childStreamId = createRuntimeId("eventStream", "cleanup-child");
		const cursorAdvanced = await runtime.store.commit(root.agentId, loaded.value.revision, {
			type: "agent.cursor_advanced",
			requestId: createRuntimeId("command", "cleanup-child-cursor"),
			idempotencyKey: key("cleanup-child-cursor"),
			occurredAt: NOW,
			agentId: child.agentId,
			cursor: {
				stream: { scope: "session", streamId: childStreamId, sessionId: child.sessionId },
				sequence: 3,
				eventId: createRuntimeId("event", "cleanup-child-cursor"),
				eventHash: digest("4"),
			},
		});
		expect(cursorAdvanced).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!cursorAdvanced.ok || cursorAdvanced.value.status === "conflict") return;
		loaded = { ok: true, value: cursorAdvanced.value.head };
		const terminalRequestId = createRuntimeId("command", "cleanup-terminal");
		const terminalKey = key("cleanup-terminal");
		const terminal = createAgentSemanticTerminalRecord({
			agentId: child.agentId,
			requestId: terminalRequestId,
			idempotencyKey: terminalKey,
			outcome: "failed",
			reason: "crash",
			usage,
			partialResults: [],
		});
		const terminalCommand: AgentGraphSemanticCommand = {
			type: "agent.failed",
			requestId: terminalRequestId,
			idempotencyKey: terminalKey,
			occurredAt: NOW,
			agentId: child.agentId,
			from: "running",
			reason: "crash",
			error: {
				code: "crash",
				messageDigest: digest("1"),
				retryable: false,
				outcomeCertain: true,
				effect: "none",
			},
			terminal,
		};
		const semanticTerminal = await runtime.store.commit(root.agentId, loaded.value.revision, terminalCommand);
		expect(semanticTerminal).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!semanticTerminal.ok || semanticTerminal.value.status === "conflict") return;
		loaded = { ok: true, value: semanticTerminal.value.head };
		expect(loaded.value.projection.nodes.get(child.agentId)?.terminal).toEqual(terminal);
		expect(loaded.value.projection.cleanups.has(child.agentId)).toBe(false);

		const cleanupRequestId = createRuntimeId("command", "cleanup-request");
		const cleanupDigest = agentCleanupRequestDigest({
			requestId: cleanupRequestId,
			agentId: child.agentId,
			sessionId: child.sessionId,
			terminalDigest: terminal.terminalDigest,
		});
		const cleanupRequested: AgentGraphSemanticCommand = {
			type: "agent.cleanup_requested",
			requestId: cleanupRequestId,
			idempotencyKey: key("cleanup-request"),
			occurredAt: NOW,
			agentId: child.agentId,
			terminalDigest: terminal.terminalDigest,
			requestDigest: cleanupDigest,
		};
		const requested = await runtime.store.commit(root.agentId, loaded.value.revision, cleanupRequested);
		expect(requested).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!requested.ok || requested.value.status === "conflict") return;
		loaded = { ok: true, value: requested.value.head };

		const workspaceRequestId = createRuntimeId("command", "cleanup-workspace");
		const { receiptDigest: _workspaceDigest, ...workspaceBody } = child.workspaceReceipt;
		const releasedWorkspaceBody: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
			...workspaceBody,
			status: "released",
		};
		const releasedWorkspace = {
			...releasedWorkspaceBody,
			receiptDigest: canonicalDigest(releasedWorkspaceBody),
		};
		const workspaceRequestDigest = agentWorkspaceReleaseRequestDigest({
			requestId: workspaceRequestId,
			agentId: child.agentId,
			sessionId: child.sessionId,
			previousReceipt: child.workspaceReceipt,
			reason: "failed",
		});
		const prematureWorkspace: AgentGraphSemanticCommand = {
			type: "agent.workspace_released",
			requestId: workspaceRequestId,
			idempotencyKey: key("cleanup-workspace-premature"),
			occurredAt: NOW,
			agentId: child.agentId,
			cleanupRequestId,
			requestDigest: workspaceRequestDigest,
			receipt: releasedWorkspace,
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, prematureWorkspace)).toMatchObject({
			ok: false,
			error: { code: "cleanup_invalid" },
		});

		const reconciliation: AgentGraphSemanticCommand = {
			type: "agent.cleanup_reconciliation_required",
			requestId: createRuntimeId("command", "cleanup-runtime-uncertain"),
			idempotencyKey: key("cleanup-runtime-uncertain"),
			occurredAt: NOW,
			agentId: child.agentId,
			cleanupRequestId,
			stage: "runtime_release",
			error: {
				code: "runtime_close_uncertain",
				messageDigest: digest("2"),
				retryable: true,
				outcomeCertain: false,
				effect: "uncertain",
			},
		};
		const reconciliationRecorded = await runtime.store.commit(root.agentId, loaded.value.revision, reconciliation);
		expect(reconciliationRecorded).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!reconciliationRecorded.ok || reconciliationRecorded.value.status === "conflict") return;
		loaded = { ok: true, value: reconciliationRecorded.value.head };
		expect(loaded.value.projection.cleanups.get(child.agentId)?.reconciliationRequired).toMatchObject({
			stage: "runtime_release",
			error: { effect: "uncertain" },
		});

		const runtimeRequestId = createRuntimeId("command", "cleanup-runtime");
		const runtimeRequestDigest = agentRuntimeReleaseRequestDigest({
			requestId: runtimeRequestId,
			agentId: child.agentId,
			sessionId: child.sessionId,
			launchReceipt: child.launchReceipt,
			previousResidencyReceipt: child.residency,
			reason: "failed",
		});
		const nonresident = createAgentResidencyReceipt({
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: child.residency.runtimeInstanceId,
			state: "nonresident",
			revision: child.residency.revision + 1,
			observedAt: NOW,
		});
		if (!nonresident.ok) throw new Error(nonresident.error.message);
		const runtimeReleaseBody: Omit<AgentRuntimeReleaseReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId("receipt", "cleanup-runtime"),
			requestId: runtimeRequestId,
			requestDigest: runtimeRequestDigest,
			agentId: child.agentId,
			sessionId: child.sessionId,
			runtimeInstanceId: child.residency.runtimeInstanceId,
			launchReceiptId: child.launchReceipt.receiptId,
			launchRevision: child.launchReceipt.launchRevision,
			writerFenceReceiptId: createRuntimeId("receipt", "cleanup-writer-fence"),
			writerFenceReceiptDigest: digest("3"),
			finalCursor: {
				stream: {
					scope: "session",
					streamId: childStreamId,
					sessionId: child.sessionId,
				},
				sequence: 4,
				eventId: createRuntimeId("event", "cleanup-child-final"),
				eventHash: digest("5"),
			},
			residencyReceipt: nonresident.value,
			releasedAt: NOW,
		};
		const runtimeRelease = {
			...runtimeReleaseBody,
			receiptDigest: canonicalDigest(runtimeReleaseBody),
		};
		const runtimeReleaseWithCursor = (finalCursor: AgentRuntimeReleaseReceiptRef["finalCursor"]) => {
			const body = { ...runtimeReleaseBody, finalCursor };
			return { ...body, receiptDigest: canonicalDigest(body) };
		};
		const invalidRuntime: AgentGraphSemanticCommand = {
			type: "agent.runtime_released",
			requestId: runtimeRequestId,
			idempotencyKey: key("cleanup-runtime-invalid"),
			occurredAt: NOW,
			agentId: child.agentId,
			cleanupRequestId,
			receipt: { ...runtimeRelease, receiptDigest: digest("4") },
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, invalidRuntime)).toMatchObject({
			ok: false,
			error: { code: "cleanup_invalid" },
		});
		const crossStreamRuntime = {
			...invalidRuntime,
			idempotencyKey: key("cleanup-runtime-cross-stream"),
			receipt: runtimeReleaseWithCursor({
				...runtimeRelease.finalCursor,
				stream: {
					...runtimeRelease.finalCursor.stream,
					streamId: createRuntimeId("eventStream", "cleanup-child-other"),
				},
			}),
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, crossStreamRuntime)).toMatchObject({
			ok: false,
			error: { code: "cleanup_invalid" },
		});
		const regressedRuntime = {
			...invalidRuntime,
			idempotencyKey: key("cleanup-runtime-regressed-cursor"),
			receipt: runtimeReleaseWithCursor({ ...runtimeRelease.finalCursor, sequence: 2 }),
		};
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, regressedRuntime)).toMatchObject({
			ok: false,
			error: { code: "cleanup_invalid" },
		});

		const currentChild = loaded.value.projection.nodes.get(child.agentId);
		if (!currentChild?.cursor) throw new Error("cleanup test child lacks its durable cursor");
		const { cursor: _cursor, ...cursorlessChild } = currentChild;
		const cursorlessNodes = new Map(loaded.value.projection.nodes);
		cursorlessNodes.set(child.agentId, cursorlessChild);
		const cursorlessProjection = { ...loaded.value.projection, nodes: cursorlessNodes };
		expect(applyAgentGraphCommand(cursorlessProjection, crossStreamRuntime, DEFAULT_AGENT_GRAPH_LIMITS)).toMatchObject({
			ok: true,
			value: { cleanups: expect.any(Map) },
		});
		const runtimeReleased = await runtime.store.commit(root.agentId, loaded.value.revision, {
			...invalidRuntime,
			idempotencyKey: key("cleanup-runtime-valid"),
			receipt: runtimeRelease,
		});
		expect(runtimeReleased).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!runtimeReleased.ok || runtimeReleased.value.status === "conflict") return;
		loaded = { ok: true, value: runtimeReleased.value.head };
		expect(loaded.value.projection.nodes.get(child.agentId)?.residency?.state).toBe("nonresident");
		expect(loaded.value.projection.cleanups.get(child.agentId)?.reconciliationRequired).toBeUndefined();

		const workspaceReleased = await runtime.store.commit(root.agentId, loaded.value.revision, prematureWorkspace);
		expect(workspaceReleased).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!workspaceReleased.ok || workspaceReleased.value.status === "conflict") return;
		loaded = { ok: true, value: workspaceReleased.value.head };

		const settledAt = NOW;
		const budgetRequest = {
			idempotencyKey: key("cleanup-budget-port"),
			reservation: child.budgetReservation,
			outcome: "failed" as const,
			usage,
			partialResults: [],
			settledAt,
		};
		const budgetRequestDigest = agentBudgetSettlementRequestDigest(budgetRequest);
		const budgetReceiptBody: Omit<AgentBudgetSettlementReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId("receipt", "cleanup-budget"),
			reservationId: child.budgetReservation.reservationId,
			outcome: "failed",
			usageDigest: canonicalDigest(usage),
			partialResultsDigest: canonicalDigest([]),
			requestDigest: budgetRequestDigest,
			settledAt,
		};
		const budgetReceipt = { ...budgetReceiptBody, receiptDigest: canonicalDigest(budgetReceiptBody) };
		const forgedSettledAt = "2026-07-23T01:02:04.000Z";
		const forgedBudgetRequest = { ...budgetRequest, settledAt: forgedSettledAt };
		const forgedBudgetBody = {
			...budgetReceiptBody,
			requestDigest: agentBudgetSettlementRequestDigest(forgedBudgetRequest),
			settledAt: forgedSettledAt,
		};
		const forgedBudgetReceipt = { ...forgedBudgetBody, receiptDigest: canonicalDigest(forgedBudgetBody) };
		expect(await runtime.store.commit(root.agentId, loaded.value.revision, {
			type: "agent.budget_settled",
			requestId: createRuntimeId("command", "cleanup-budget-forged-time"),
			idempotencyKey: key("cleanup-budget-forged-time"),
			occurredAt: forgedSettledAt,
			agentId: child.agentId,
			cleanupRequestId,
			receipt: forgedBudgetReceipt,
		})).toMatchObject({ ok: false, error: { code: "cleanup_invalid" } });
		const budgetSettled = await runtime.store.commit(root.agentId, loaded.value.revision, {
			type: "agent.budget_settled",
			requestId: createRuntimeId("command", "cleanup-budget"),
			idempotencyKey: key("cleanup-budget"),
			occurredAt: settledAt,
			agentId: child.agentId,
			cleanupRequestId,
			receipt: budgetReceipt,
		});
		expect(budgetSettled).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!budgetSettled.ok || budgetSettled.value.status === "conflict") return;
		loaded = { ok: true, value: budgetSettled.value.head };

		const completedAt = "2026-07-23T01:02:05.000Z";
		const cleanupReceiptBody: Omit<AgentCleanupReceiptRef, "receiptDigest"> = {
			receiptId: createRuntimeId("receipt", "cleanup-complete"),
			requestId: cleanupRequestId,
			requestDigest: cleanupDigest,
			agentId: child.agentId,
			sessionId: child.sessionId,
			terminalDigest: terminal.terminalDigest,
			runtimeReleaseReceiptId: runtimeRelease.receiptId,
			runtimeReleaseReceiptDigest: runtimeRelease.receiptDigest,
			workspaceReleaseReceiptId: releasedWorkspace.receiptId,
			workspaceReleaseReceiptDigest: releasedWorkspace.receiptDigest,
			budgetSettlementReceiptId: budgetReceipt.receiptId,
			budgetSettlementReceiptDigest: budgetReceipt.receiptDigest,
			completedAt,
		};
		const cleanupReceipt = {
			...cleanupReceiptBody,
			receiptDigest: agentCleanupReceiptDigest(cleanupReceiptBody),
		};
		const cleanupCompleted = await runtime.store.commit(root.agentId, loaded.value.revision, {
			type: "agent.cleanup_completed",
			requestId: createRuntimeId("command", "cleanup-completed-event"),
			idempotencyKey: key("cleanup-completed-event"),
			occurredAt: completedAt,
			agentId: child.agentId,
			cleanupRequestId,
			receipt: cleanupReceipt,
		});
		expect(cleanupCompleted).toMatchObject({ ok: true, value: { status: "committed" } });
		if (!cleanupCompleted.ok || cleanupCompleted.value.status === "conflict") return;
		const final = cleanupCompleted.value.head.projection;
		expect(final.nodes.get(child.agentId)).toMatchObject({
			state: "failed",
			residency: { state: "nonresident" },
			workspaceReceipt: { status: "released" },
			terminal: { outcome: "failed", terminalDigest: terminal.terminalDigest },
		});
		expect(final.cleanups.get(child.agentId)?.completionReceipt).toEqual(cleanupReceipt);

		const cloned = await runtime.store.load(root.agentId);
		if (!cloned.ok) throw new Error(cloned.error.message);
		expect(cloned.value.projection.cleanups.get(child.agentId)).not.toBe(final.cleanups.get(child.agentId));
		expect(cloned.value.projection.cleanups.get(child.agentId)?.runtimeRelease?.receipt).not.toBe(runtimeRelease);
		expect(cloned.value.projection.cleanups.get(child.agentId)?.runtimeRelease?.receipt.finalCursor?.stream).not.toBe(
			runtimeRelease.finalCursor?.stream,
		);
	});
});
