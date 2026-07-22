import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ControlPlaneResult } from "../../../src/runtime/control-plane/errors.ts";
import {
	IdleSessionLifecycleCoordinator,
	type IdleSessionRuntimePort,
	type IdleSessionUnloadReceipt,
} from "../../../src/runtime/control-plane/session-lifecycle.ts";

const SESSION_ID = createRuntimeId("session", "idle-lifecycle");
const APPROVAL_ID = createRuntimeId("approval", "idle-lifecycle");

function success(): ControlPlaneResult<void> {
	return { ok: true, value: undefined };
}

describe("idle session lifecycle coordination", () => {
	it("does not unload while a subscriber lease is active", async () => {
		let unloads = 0;
		const runtime: IdleSessionRuntimePort = {
			inspect: async () => ({ ok: true, value: { activeWork: false, pendingApprovalIds: [] } }),
			closeMutationGate: async () => success(),
			openMutationGate: async () => success(),
			cancelPendingApprovals: async () => ({ ok: true, value: { cancelledApprovalIds: [] } }),
			unload: async () => {
				unloads += 1;
				return { ok: true, value: { state: "unloaded", durable: true } };
			},
			resume: async () => success(),
		};
		const lifecycle = new IdleSessionLifecycleCoordinator(runtime);
		const lease = await lifecycle.acquireSubscription(SESSION_ID);
		if (!lease.ok) throw new Error(lease.error.message);
		expect(await lifecycle.unloadIfIdle(SESSION_ID)).toEqual({
			ok: true,
			value: { status: "skipped", reason: "subscribed" },
		});
		expect(unloads).toBe(0);
		await expect(lease.value.release()).resolves.toMatchObject({ ok: true });
		await expect(lifecycle.unloadIfIdle(SESSION_ID)).resolves.toMatchObject({
			ok: true,
			value: { status: "unloaded" },
		});
		expect(unloads).toBe(1);
	});

	it("closes the mutation gate, durably cancels a raced approval, then serializes resume after unload", async () => {
		const order: string[] = [];
		let inspections = 0;
		let resolveUnload: ((value: ControlPlaneResult<IdleSessionUnloadReceipt>) => void) | undefined;
		const unloadResult = new Promise<ControlPlaneResult<IdleSessionUnloadReceipt>>((resolve) => {
			resolveUnload = resolve;
		});
		const runtime: IdleSessionRuntimePort = {
			inspect: async () => {
				inspections += 1;
				return {
					ok: true,
					value: {
						activeWork: false,
						pendingApprovalIds: inspections === 1 ? [] : [APPROVAL_ID],
					},
				};
			},
			closeMutationGate: async () => {
				order.push("gate:closed");
				return success();
			},
			openMutationGate: async () => {
				order.push("gate:open");
				return success();
			},
			cancelPendingApprovals: async (_sessionId, approvalIds) => {
				order.push(`approval:cancel:${approvalIds.join(",")}`);
				return { ok: true, value: { cancelledApprovalIds: approvalIds } };
			},
			unload: async () => {
				order.push("unload:start");
				return unloadResult;
			},
			resume: async () => {
				order.push("resume");
				return success();
			},
		};
		const lifecycle = new IdleSessionLifecycleCoordinator(runtime);
		const unloading = lifecycle.unloadIfIdle(SESSION_ID, 1_000);
		while (!order.includes("unload:start")) await new Promise((resolve) => setImmediate(resolve));
		const resuming = lifecycle.resume(SESSION_ID);
		expect(order).toEqual([
			"gate:closed",
			`approval:cancel:${APPROVAL_ID}`,
			"unload:start",
		]);
		resolveUnload?.({ ok: true, value: { state: "unloaded", durable: true } });
		await expect(unloading).resolves.toMatchObject({
			ok: true,
			value: { status: "unloaded", cancelledApprovals: 1 },
		});
		await expect(resuming).resolves.toMatchObject({ ok: true });
		expect(lifecycle.state(SESSION_ID)).toBe("active");
		expect(order).toEqual([
			"gate:closed",
			`approval:cancel:${APPROVAL_ID}`,
			"unload:start",
			"resume",
			"gate:open",
		]);
	});

	it("leaves a timed-out unload paused with an uncertain typed result", async () => {
		const runtime: IdleSessionRuntimePort = {
			inspect: async () => ({ ok: true, value: { activeWork: false, pendingApprovalIds: [] } }),
			closeMutationGate: async () => success(),
			openMutationGate: async () => success(),
			cancelPendingApprovals: async () => ({ ok: true, value: { cancelledApprovalIds: [] } }),
			unload: async (_sessionId, signal) => new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve({
					ok: false,
					error: { code: "drain_timeout", message: "aborted", retryable: false },
					effect: "uncertain",
				}), { once: true });
			}),
			resume: async () => success(),
		};
		const lifecycle = new IdleSessionLifecycleCoordinator(runtime);
		await expect(lifecycle.unloadIfIdle(SESSION_ID, 5)).resolves.toMatchObject({
			ok: false,
			error: { code: "drain_timeout" },
			effect: "uncertain",
		});
		expect(lifecycle.state(SESSION_ID)).toBe("paused");
	});
});
