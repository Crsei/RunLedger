/**
 * Process passive bridge：既有 ProcessOverlayController/state <-> ProcessPassivePort。
 *
 * 纯 bridge/selector：复用现有 process reducer 与 controller-adapter，不另造
 * 第二 process manager。observer 的 terminal 永远没有 writable input
 * （driver 字段来自既有 facade 的 driver 标志）。
 */

import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { ProcessPassivePort, ProcessPassiveSnapshot } from "./types.ts";
import type { ProcessOverlayController, ProcessOverlayHostClient } from "./controller-adapter.ts";
import type { ExecutionId } from "../../runtime/protocol/ids.ts";

export function createProcessPassiveBridge(
	controller: ProcessOverlayController | undefined,
	client: ProcessOverlayHostClient | undefined,
): ProcessPassivePort | undefined {
	if (controller === undefined) return undefined;
	const snapshots = (): ProcessPassiveSnapshot[] => {
		const state = controller.snapshot();
		return state.processes.map((process) => ({
			executionId: process.executionId,
			attemptId: process.attemptId,
			state: process.state as ProcessPassiveSnapshot["state"],
			authorityGeneration: 0,
			hostRevision: { state: "unknown", reason: "not-reported" },
			output: {
				cursor: { state: "known", value: `${process.outputCursor.sequence}:${process.outputCursor.byteOffset}` },
				bytes: { state: "known", value: process.outputSize },
				truncated: state.truncated,
			},
			driver: state.driver ? "driver" : "observer",
		}));
	};
	return {
		list: async (request: TuiPortRequest): Promise<TuiResultEnvelope<readonly ProcessPassiveSnapshot[]>> => {
			await controller.refresh();
			return { ok: true, ref: request, value: snapshots() };
		},
		output: async (request) => {
			if (client === undefined) {
				return { ok: false, ref: request, error: { code: "process_output_unavailable", message: "no process output client", retryable: false } };
			}
			const cursor = request.cursor.state === "known" ? parseCursor(request.cursor.value) : { sequence: 0, byteOffset: 0 };
			const result = await client.processOutput(request.executionId as ExecutionId, cursor, 64 * 1024);
			if (!result.ok) {
				return { ok: false, ref: request, error: { code: result.code, message: "process output failed", retryable: true } };
			}
			return {
				ok: true,
				ref: request,
				value: {
					executionId: request.executionId,
					cursor: { state: "known", value: `${result.endCursor.sequence}:${result.endCursor.byteOffset}` },
					text: { text: result.text, truncated: result.truncated, byteLength: new TextEncoder().encode(result.text).byteLength },
					nextCursor: { state: "known", value: `${result.nextCursor.sequence}:${result.nextCursor.byteOffset}` },
					closed: false,
				},
			};
		},
		mutate: async (request) => {
			if (!controller.snapshot().driver) {
				return { ok: false, ref: request, error: { code: "observer_mutation_forbidden", message: "observer cannot mutate processes", retryable: false } };
			}
			const result = request.operation === "stop"
				? await controller.stop()
				: await controller.write("");
			if (!result.ok) {
				return { ok: false, ref: request, error: { code: result.code, message: "process mutation rejected", retryable: false } };
			}
			return {
				ok: true,
				ref: request,
				value: {
					executionId: request.executionId,
					operation: request.operation,
					receiptPrefix: { text: result.receiptDigest?.digest.slice(0, 12) ?? "process", truncated: false, byteLength: 12 },
					outcome: "completed",
					recoveryRequired: false,
				},
			};
		},
	};
}

function parseCursor(value: string): { sequence: number; byteOffset: number } {
	const [sequence, byteOffset] = value.split(":").map((part) => Number.parseInt(part, 10));
	return {
		sequence: Number.isSafeInteger(sequence) ? sequence! : 0,
		byteOffset: Number.isSafeInteger(byteOffset) ? byteOffset! : 0,
	};
}
