import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest, RuntimeContentRef } from "../../../src/runtime/protocol/foundation.ts";
import {
	applyWaitCoordinator,
	createWaitCoordinatorState,
	type WaitCoordinatorResolution,
} from "../../../src/runtime/process/wait-coordinator.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../../../src/runtime/process/types.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

const evidence: RuntimeContentRef = { subjectKind: "receipt", digest: digest("e"), mediaType: "application/json", size: 0 };
const handle: ExecutionHandleRef = {
	authorityId: createRuntimeId("authority", "wait"),
	tenantId: createRuntimeId("tenant", "wait"),
	workspaceId: createRuntimeId("workspace", "wait"),
	sessionId: createRuntimeId("session", "wait"),
	hostGeneration: 1,
	sessionGeneration: 1,
	executionId: createRuntimeId("execution", "wait"),
	attemptId: createRuntimeId("attempt", "wait"),
	revision: 2,
	requestDigest: digest("r"),
};
const running: ManagedProcessSummary = {
	handle,
	state: "running",
	outputCursor: 0,
	outputSize: 0,
	capabilities: { canWrite: true, canEof: true, canResize: false, canStop: true, canReadOutput: true },
};
const terminal: ManagedProcessSummary = {
	...running,
	state: "completed",
	capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true },
	terminal: { state: "completed", exitCode: 0, evidenceRef: evidence },
};

function terminalResolution(result: { readonly resolutions: readonly WaitCoordinatorResolution[] }): WaitCoordinatorResolution {
	const resolution = result.resolutions[0];
	if (!resolution) throw new Error("missing wait resolution");
	return resolution;
}

describe("R5 wait coordinator", () => {
	it("returns the same terminal result whether terminal precedes or follows registration", () => {
		const beforeRegister = applyWaitCoordinator(
			applyWaitCoordinator(createWaitCoordinatorState(), { type: "terminal", summary: terminal }).state,
			{ type: "register", waiterId: "wait-before", summary: running },
		);
		const afterRegister = applyWaitCoordinator(
			applyWaitCoordinator(createWaitCoordinatorState(), { type: "register", waiterId: "wait-after", summary: running }).state,
			{ type: "terminal", summary: terminal },
		);
		expect(terminalResolution(beforeRegister)).toMatchObject({ outcome: "terminal", summary: terminal });
		expect(terminalResolution(afterRegister)).toMatchObject({ outcome: "terminal", summary: terminal });
	});

	it("timeout and cancel only settle the waiter and preserve process truth", () => {
		const registered = applyWaitCoordinator(createWaitCoordinatorState(), {
			type: "register",
			waiterId: "wait-timeout",
			summary: running,
		}).state;
		const timedOut = applyWaitCoordinator(registered, { type: "timeout", waiterId: "wait-timeout" });
		expect(timedOut.resolutions).toMatchObject([{ outcome: "timed_out", summary: running }]);
		expect(timedOut.state.terminals).toEqual([]);
		const repeatedTimeout = applyWaitCoordinator(timedOut.state, { type: "timeout", waiterId: "wait-timeout" });
		expect(repeatedTimeout).toMatchObject({
			state: timedOut.state,
			resolutions: [],
		});
		expect(repeatedTimeout.error).toBeUndefined();

		const cancelled = applyWaitCoordinator(timedOut.state, {
			type: "register",
			waiterId: "wait-cancel",
			summary: running,
		});
		const cancelledResult = applyWaitCoordinator(cancelled.state, { type: "cancel", waiterId: "wait-cancel" });
		expect(cancelledResult.resolutions).toMatchObject([{ outcome: "cancelled", summary: running }]);
		expect(cancelledResult.state.terminals).toEqual([]);
		const repeatedCancel = applyWaitCoordinator(cancelledResult.state, { type: "cancel", waiterId: "wait-cancel" });
		expect(repeatedCancel).toMatchObject({
			state: cancelledResult.state,
			resolutions: [],
		});
		expect(repeatedCancel.error).toBeUndefined();
	});

	it("does not cross-resolve identical execution IDs from another scope", () => {
		const otherHandle: ExecutionHandleRef = {
			...handle,
			sessionId: createRuntimeId("session", "wait-other-scope"),
		};
		const otherRunning: ManagedProcessSummary = { ...running, handle: otherHandle };
		const registered = applyWaitCoordinator(createWaitCoordinatorState(), {
			type: "register",
			waiterId: "wait-other-scope",
			summary: otherRunning,
		});
		const settled = applyWaitCoordinator(registered.state, { type: "terminal", summary: terminal });
		expect(settled.resolutions).toEqual([]);
		expect(settled.state.waiters).toMatchObject([{ waiterId: "wait-other-scope", status: "waiting" }]);
	});
});
