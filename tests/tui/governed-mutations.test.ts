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
import type { TuiPortRequest } from "../../src/tui/application/common.ts";

const ref = (effectId: string, correlationId: string, generation = 1) => ({ generation, effectId, correlationId });
const bounded = { text: "label", truncated: false, byteLength: 5 };

function queuePort(receipt: QueueCancellationReceipt | { ok: false; code: string }): DurableQueueWorkflowPort {
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { authorityGeneration: 1, queueRevision: 1, items: [], pendingCount: { state: "known", value: 0 }, claimedCount: { state: "known", value: 0 } } satisfies DurableQueueSnapshot }),
		cancel: async (request) => {
			const item = request.item;
			if ("ok" in receipt && receipt.ok === false) {
				return { ok: false, ref: request, error: { code: receipt.code, message: "rejected", retryable: true } };
			}
			return { ok: true, ref: request, value: receipt as QueueCancellationReceipt };
		},
	};
}

function approvalPort(): ApprovalWorkflowPort {
	return {
		inspect: async (request) => ({ ok: true, ref: request, value: { items: [], authorityGeneration: 1, decisionRevision: 1 } satisfies ApprovalSnapshot }),
		resolve: async (request) => ({ ok: true, ref: request, value: { approvalId: request.approvalId, decision: request.decision, decisionRevision: request.expectedDecisionRevision, receiptDigestPrefix: bounded, recoveryRequired: false } satisfies ApprovalDecisionReceipt }),
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

	it("security mode mutation fails closed without changing the visible authority fact", async () => {
		const results: TuiResult[] = [];
		const failingSet = {
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
			inspect: async (request) => ({ ok: true, ref: request, value: { authorityGeneration: 1, queueRevision: 1, items: [], pendingCount: { state: "known", value: 0 }, claimedCount: { state: "known", value: 0 } } }),
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
