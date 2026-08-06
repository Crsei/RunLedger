/**
 * B7：process passive bridge 验收。
 *
 *   - 复用既有 process reducer/controller-adapter，没有第二 process manager；
 *   - list 反映 overlay snapshot（driver 字段分离）；
 *   - observer mutation fail closed；
 *   - output cursor 有界、分页。
 */

import { describe, expect, it, vi } from "vitest";
import { createProcessOverlayController, type ProcessOverlayHostClient } from "../../../src/tui/process/controller-adapter.ts";
import { createProcessPassiveBridge } from "../../../src/tui/process/passive-bridge.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";

const executionId = createRuntimeId("execution", "bridge");
const attemptId = createRuntimeId("attempt", "bridge_1");

const request = { generation: 1, effectId: "e-1", correlationId: "c-1", signal: new AbortController().signal, authorityGeneration: 1 };

function client(): ProcessOverlayHostClient {
	return {
		listProcesses: async () => [
			{ executionId, attemptId, state: "running", outputCursor: { sequence: 1, byteOffset: 5 }, outputSize: 120, canWrite: true, canResize: true, canStop: true },
		],
		processOutput: async (_id, cursor) => ({ ok: true as const, text: "out", startCursor: cursor, endCursor: { sequence: 2, byteOffset: 3 }, nextCursor: { sequence: 2, byteOffset: 3 }, truncated: false, head: { sequence: 2, byteOffset: 3 } }),
		writeStdin: async (_id, input) => ({ ok: true, receiptDigest: { algorithm: "sha256", digest: "abc123def456" } as never }),
		stopProcess: async () => ({ ok: true }),
	};
}

describe("B7 process passive bridge", () => {
	it("lists processes from the existing overlay snapshot (no second manager)", () => {
		const overlay = createProcessOverlayController(client(), { driver: true });
		const bridge = createProcessPassiveBridge(overlay, client());
		expect(bridge).toBeDefined();
		return bridge!.list(request).then((result) => {
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(1);
				expect(result.value[0]).toMatchObject({ executionId, driver: "driver" });
				expect(result.value[0]!.output.bytes).toEqual({ state: "known", value: 120 });
			}
		});
	});

	it("observer state is reflected without writable control", async () => {
		const overlay = createProcessOverlayController(client(), { driver: false });
		const bridge = createProcessPassiveBridge(overlay, client())!;
		const list = await bridge.list(request);
		expect(list.ok).toBe(true);
		if (list.ok) expect(list.value[0]!.driver).toBe("observer");
		const mutation = await bridge.mutate({ ...request, executionId, operation: "stop" });
		expect(mutation.ok).toBe(false);
		if (!mutation.ok) expect(mutation.error.code).toBe("observer_mutation_forbidden");
	});

	it("output pages carry bounded text and the next cursor", async () => {
		const overlay = createProcessOverlayController(client(), { driver: true });
		const bridge = createProcessPassiveBridge(overlay, client())!;
		const result = await bridge.output({ ...request, executionId, cursor: { state: "known", value: "1:5" } });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.text.text).toBe("out");
			expect(result.value.nextCursor).toEqual({ state: "known", value: "2:3" });
		}
	});

	it("absent overlay facade yields an undefined bridge (unavailable)", () => {
		expect(createProcessPassiveBridge(undefined, undefined)).toBeUndefined();
		expect(vi).toBeDefined();
	});
});
