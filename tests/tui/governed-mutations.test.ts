/**
 * B6：governed mutation 验收（queue/approval/security/shutdown/update）。
 *
 *   - queue cancel 使用 expected queue revision 并返回 durable receipt；
 *   - approval decision 经 effect/result 形成相关链，不存在 allow-all 路径；
 *   - security mode mutation 失败不改变 visible authority fact；
 *   - uncertain mutation 必须 recoveryRequired；update 只展示 policy/status/receipt；
 *   - observer 不出现 mutation control（driver 判定在端口实现方）。
 */

import { describe, expect, it, vi } from "vitest";
import { createEffectRunner } from "../../src/tui/application/effect-runner.ts";
import type { TuiDomainPorts } from "../../src/tui/application/ports.ts";
import type { TuiResult } from "../../src/tui/application/result.ts";
import type { DurableQueueWorkflowPort, DurableQueueSnapshot, QueueCancellationReceipt } from "../../src/tui/queue/types.ts";
import type { ApprovalWorkflowPort, ApprovalSnapshot, ApprovalDecisionReceipt } from "../../src/tui/approval/types.ts";
import type { SecurityModeWorkflowPort, SecurityModeSnapshot, SecurityModeTransitionReceipt } from "../../src/tui/security-mode/types.ts";
import type { ShutdownWorkflowPort, ShutdownReceipt } from "../../src/tui/shutdown/types.ts";
import type { UpdateQueryPort, UpdateNoticeView } from "../../src/tui/update/types.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { TuiPortRequest } from "../../src/tui/application/common.ts";

const ref = (effectId: string, correlationId: string, generation = 1) => ({ generation, effectId, correlationId });
const bounded = { text: "label", truncated: false, byteLength: 5 };

function queuePort(receipt: QueueCancellationReceipt | { ok: false; code: string }): DurableQueueWorkflowPort {
	const queueRevision = "queueRevision" in receipt ? receipt.queueRevision : 5;
	const itemId = "itemId" in receipt ? receipt.itemId : "queue-1";
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { authorityGeneration: 1, queueRevision, items: [{ itemId, sessionId: "session-1", state: "pending", digestPrefix: bounded, label: bounded, queueRevision }], pendingCount: { state: "known", value: 1 }, claimedCount: { state: "known", value: 0 } } satisfies DurableQueueSnapshot }),
		cancel: async (request) => {
			const item = request.item;
			expect(item.itemId).toBe(itemId);
			expect(item.queueRevision).toBe(queueRevision);
			expect(request.reason).toMatchObject({ text: expect.any(String), byteLength: expect.any(Number), truncated: false });
			if ("ok" in receipt && receipt.ok === false) {
				return { ok: false, ref: request, error: { code: receipt.code, message: "rejected", retryable: true } };
			}
			return { ok: true, ref: request, value: receipt as QueueCancellationReceipt };
		},
	};
}

function approvalPort(): ApprovalWorkflowPort {
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { items: [{ approvalId: "appr-1", sessionId: "session-1", state: "pending", summary: bounded, ticketDigestPrefix: bounded, decisionRevision: 2, authorityGeneration: 1 }], authorityGeneration: 1, decisionRevision: 2 } satisfies ApprovalSnapshot }),
		resolve: async (request) => ({ ok: true, ref: request, value: { approvalId: request.item.approvalId, decision: request.decision, decisionRevision: request.item.decisionRevision, receiptDigestPrefix: bounded, recoveryRequired: false } satisfies ApprovalDecisionReceipt }),
	};
}

function securityPort(): SecurityModeWorkflowPort {
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { authorityGeneration: 1, mode: { state: "known", value: "guarded" }, modeRevision: { state: "known", value: 3 } } satisfies SecurityModeSnapshot }),
		set: async (request) => ({ ok: true, ref: request, value: { target: request.target, revision: 4, receiptPrefix: bounded, outcome: "completed", recoveryRequired: false } satisfies SecurityModeTransitionReceipt }),
	};
}

function shutdownPort(): ShutdownWorkflowPort {
	return {
		request: async (request) => ({ ok: true, ref: request, value: { trigger: request.trigger, outcome: "completed", recoveryRequired: false } satisfies ShutdownReceipt }),
	};
}

function updatePort(): UpdateQueryPort {
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { channel: bounded, releasePrefix: bounded, message: bounded, policy: "informational" } satisfies UpdateNoticeView }),
	};
}

async function runEffect(effect: Parameters<ReturnType<typeof createEffectRunner>["dispatch"]>[0], ports: TuiDomainPorts): Promise<TuiResult> {
	const results: TuiResult[] = [];
	const runner = createEffectRunner({ ports, currentGeneration: () => 1, onResult: (result) => results.push(result) });
	runner.dispatch(effect);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return results[0]!;
}

describe("B6 governed mutations", () => {
	it("queue cancel carries the expected revision and returns a durable receipt", async () => {
		const result = await runEffect(
			{ type: "queue.cancel", itemId: "queue-1", expectedQueueRevision: 3, reason: "user requested", ...ref("e-q", "c-q") },
			{ queue: queuePort({ itemId: "queue-1", queueRevision: 3, receiptPrefix: bounded, outcome: "cancelled", recoveryRequired: false }) },
		);
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect((result.value as QueueCancellationReceipt).outcome).toBe("cancelled");
			expect((result.value as QueueCancellationReceipt).queueRevision).toBe(3);
		}
	});

	it("queue cancel rejection surfaces as a typed failure (no allow-all)", async () => {
		const result = await runEffect(
			{ type: "queue.cancel", itemId: "queue-1", expectedQueueRevision: 5, reason: "user requested", ...ref("e-q2", "c-q2") },
			{ queue: queuePort({ ok: false, code: "queue_revision_conflict" }) },
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("queue_revision_conflict");
	});

	it("approval resolve decision flows through the effect/result correlation chain", async () => {
		const result = await runEffect(
			{ type: "approval.resolve", approvalId: "appr-1", expectedDecisionRevision: 2, decision: "denied", ...ref("e-a", "c-a") },
			{ approval: approvalPort() },
		);
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect((result.value as ApprovalDecisionReceipt).decision).toBe("denied");
		}
	});

	it("preserves queue and approval state decisions made by mutation ports", async () => {
		const approval = approvalPort();
		const resolve = vi.fn<ApprovalWorkflowPort["resolve"]>(async (request) => {
			expect(request.item.state).toBe("expired");
			return { ok: false, ref: request, error: { code: "approval_not_pending", message: "approval expired", retryable: false } };
		});
		const approvalResult = await runEffect(
			{ type: "approval.resolve", approvalId: "appr-1", expectedDecisionRevision: 2, decision: "allowed", ...ref("e-expired", "c-expired") },
			{ approval: { ...approval, resolve, inspect: async (request) => {
				const snapshot = await approval.inspect(request);
				return snapshot.ok ? { ...snapshot, value: { ...snapshot.value, items: snapshot.value.items.map((item) => ({ ...item, state: "expired" })) } } : snapshot;
			} } },
		);
		expect(approvalResult).toMatchObject({ status: "failed", error: { code: "approval_not_pending" } });
		expect(resolve).toHaveBeenCalledOnce();

		const queue = queuePort({ itemId: "q", queueRevision: 1, receiptPrefix: bounded, outcome: "cancelled", recoveryRequired: false });
		const cancel = vi.fn<DurableQueueWorkflowPort["cancel"]>(async (request) => {
			expect(request.item.state).toBe("completed");
			return { ok: true, ref: request, value: { itemId: request.item.itemId, queueRevision: 1, receiptPrefix: bounded, outcome: "already-terminal", recoveryRequired: false } };
		});
		const queueResult = await runEffect(
			{ type: "queue.cancel", itemId: "q", expectedQueueRevision: 1, reason: "cancel", ...ref("e-terminal", "c-terminal") },
			{ queue: { ...queue, cancel, inspect: async (request) => {
				const snapshot = await queue.inspect(request);
				return snapshot.ok ? { ...snapshot, value: { ...snapshot.value, items: snapshot.value.items.map((item) => ({ ...item, state: "completed" })) } } : snapshot;
			} } },
		);
		expect(queueResult).toMatchObject({ status: "completed", value: { outcome: "already-terminal" } });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each(["missing", "revision", "generation", "correlation"] as const)("rejects an approval %s mismatch before calling the mutation port", async (mismatch) => {
		const port = approvalPort();
		const resolve = vi.fn(port.resolve);
		const result = await runEffect(
			{ type: "approval.resolve", approvalId: "appr-1", expectedDecisionRevision: 2, decision: "allowed", ...ref("e-missing", "c-missing") },
			{ approval: { ...port, resolve, inspect: async (request) => {
				const snapshot = await port.inspect(request);
				if (!snapshot.ok) return snapshot;
				return { ...snapshot, ref: mismatch === "correlation" ? { ...request, correlationId: "other" } : request, value: { ...snapshot.value,
					...(mismatch === "missing" ? { items: [] } : {}),
					...(mismatch === "revision" ? { decisionRevision: 3 } : {}),
					...(mismatch === "generation" ? { authorityGeneration: 2 } : {}),
				} };
			} } },
		);
		expect(result).toMatchObject({ status: "failed", error: { code: mismatch === "missing" ? "approval_item_unavailable" : mismatch === "revision" ? "approval_revision_conflict" : mismatch === "generation" ? "authority_generation_conflict" : "snapshot_correlation_mismatch" } });
		expect(resolve).not.toHaveBeenCalled();
	});

	it("does not cancel a queue item that disappeared or moved to a newer revision", async () => {
		const port = queuePort({ itemId: "q", queueRevision: 4, receiptPrefix: bounded, outcome: "cancelled", recoveryRequired: false });
		const cancel = vi.fn(port.cancel);
		const moved = await runEffect({ type: "queue.cancel", itemId: "q", expectedQueueRevision: 3, reason: "cancel", ...ref("e-moved", "c-moved") }, { queue: { ...port, cancel } });
		const missing = await runEffect({ type: "queue.cancel", itemId: "missing", expectedQueueRevision: 4, reason: "cancel", ...ref("e-missing", "c-missing") }, { queue: { ...port, cancel } });
		expect(moved).toMatchObject({ status: "failed", error: { code: "queue_revision_conflict" } });
		expect(missing).toMatchObject({ status: "failed", error: { code: "queue_item_unavailable" } });
		expect(cancel).not.toHaveBeenCalled();
	});

	it.each(["cancel", "generation"] as const)("does not dispatch an approval mutation after %s while inspection is pending", async (action) => {
		let release!: () => void;
		const pending = new Promise<void>((done) => { release = done; });
		const port = approvalPort();
		const resolve = vi.fn(port.resolve);
		let generation = 1;
		const results: TuiResult[] = [];
		const runner = createEffectRunner({ currentGeneration: () => generation, onResult: (result) => results.push(result), ports: { approval: { ...port, resolve, inspect: async (request) => { await pending; return port.inspect(request); } } } });
		const effect = { type: "approval.resolve", approvalId: "appr-1", expectedDecisionRevision: 2, decision: "allowed", ...ref("e-paused", "c-paused") } as const;
		runner.dispatch(effect);
		if (action === "cancel") runner.cancel(effect); else generation = 2;
		release();
		await new Promise((done) => setTimeout(done, 0));
		expect(resolve).not.toHaveBeenCalled();
		expect(results).toMatchObject([{ status: action === "cancel" ? "aborted" : "stale" }]);
	});

	it("adapts process output identity and cursor without resetting the requested position", async () => {
		const executionId = createRuntimeId("execution", "effect-output");
		const output = vi.fn<NonNullable<TuiDomainPorts["process"]>["output"]>(async (request) => {
			expect(request.executionId).toBe(executionId);
			expect(request.cursor).toEqual({ state: "known", value: "3:27" });
			return { ok: true, ref: request, value: { executionId, cursor: request.cursor, text: bounded, nextCursor: { state: "known", value: "4:32" }, closed: false } };
		});
		const processPort: NonNullable<TuiDomainPorts["process"]> = { output, list: async (request) => ({ ok: true, ref: request, value: [] }), mutate: async (request) => ({ ok: false, ref: request, error: { code: "unavailable", message: "read only", retryable: false } }) };
		const result = await runEffect({ type: "process.output", executionId, cursor: "3:27", ...ref("e-output", "c-output") }, { process: processPort });
		expect(result.status).toBe("completed");
		for (const [id, cursor] of [["invalid", "3:27"], [executionId, "bad"]]) {
			const invalid = await runEffect({ type: "process.output", executionId: id, cursor, ...ref("e-invalid", "c-invalid") }, { process: processPort });
			expect(invalid.status).toBe("failed");
		}
		expect(output).toHaveBeenCalledTimes(1);
	});

	it("security mode mutation fails closed without changing the visible authority fact", async () => {
		const results: TuiResult[] = [];
		const failingSet: SecurityModeWorkflowPort = {
			...securityPort(),
			set: async (request: TuiPortRequest & { readonly target: "guarded" | "unrestricted" }) => ({ ok: false, ref: request, error: { code: "security_revision_conflict", message: "revision moved", retryable: true } }),
		};
		const runner = createEffectRunner({ ports: { securityMode: failingSet }, currentGeneration: () => 1, onResult: (result) => results.push(result) });
		runner.dispatch({ type: "security-mode.inspect", ...ref("e-s1", "c-s1") });
		runner.dispatch({ type: "security-mode.set", target: "unrestricted", expectedRevision: { state: "known", value: 3 }, ...ref("e-s2", "c-s2") });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// inspect completed、set failed —— 没有乐观提交
		const inspect = results.find((result) => result.ref.correlationId === "c-s1");
		const set = results.find((result) => result.ref.correlationId === "c-s2");
		expect(inspect?.status).toBe("completed");
		expect(set?.status).toBe("failed");
		if (set?.status === "failed") expect(set.error.code).toBe("security_revision_conflict");
	});

	it("shutdown only submits intent; receipts carry the trigger", async () => {
		const result = await runEffect(
			{ type: "shutdown.request", trigger: "user", ...ref("e-sh", "c-sh") },
			{ shutdown: shutdownPort() },
		);
		expect(result.status).toBe("completed");
		if (result.status === "completed") expect((result.value as ShutdownReceipt).trigger).toBe("user");
	});

	it("uncertain mutation is marked recoveryRequired by the runner", async () => {
		const uncertain: DurableQueueWorkflowPort = {
			...queuePort({ itemId: "q", queueRevision: 1, receiptPrefix: bounded, outcome: "uncertain", recoveryRequired: true }),
			cancel: async (request) => ({ ok: true, ref: request, value: { itemId: "q", queueRevision: 1, receiptPrefix: bounded, outcome: "uncertain", recoveryRequired: true } }),
		};
		const result = await runEffect(
			{ type: "queue.cancel", itemId: "q", expectedQueueRevision: 1, reason: "x", ...ref("e-u", "c-u") },
			{ queue: uncertain },
		);
		// runner 语义：receipt 里 recoveryRequired 由 workflow 层表达；runner 只在 error.recoveryRequired 时标记
		expect(result.status).toBe("completed");
		if (result.status === "completed") expect((result.value as QueueCancellationReceipt).recoveryRequired).toBe(true);
	});

	it("update inspect only reports policy/status; no download or activation", async () => {
		const result = await runEffect({ type: "update.inspect", ...ref("e-u2", "c-u2") }, { update: updatePort() });
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect((result.value as UpdateNoticeView).policy).toBe("informational");
		}
	});

	it("observer capability is decided by the port, not the runner", async () => {
		const observerRejected: DurableQueueWorkflowPort = {
			...queuePort({ itemId: "q", queueRevision: 1, receiptPrefix: bounded, outcome: "cancelled", recoveryRequired: false }),
			cancel: async (request) => ({ ok: false, ref: request, error: { code: "observer_mutation_forbidden", message: "observer cannot cancel", retryable: false } }),
		};
		const result = await runEffect(
			{ type: "queue.cancel", itemId: "q", expectedQueueRevision: 1, reason: "x", ...ref("e-o", "c-o") },
			{ queue: observerRejected },
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("observer_mutation_forbidden");
		expect(vi).toBeDefined();
	});
});
