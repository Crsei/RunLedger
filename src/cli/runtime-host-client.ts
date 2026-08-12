/** Production client adapters for Host-owned session/process views. */

import { RUNTIME_HOST_BOUNDS, type HostFrameEnvelope } from "../runtime/host/types.ts";
import type { RuntimeDigest } from "../runtime/protocol/foundation.ts";
import type { ExecutionId, AttemptId } from "../runtime/protocol/ids.ts";
import type { HostRequestTransport } from "../runtime/host/remote-session.ts";
import type { ProcessOverlayHostClient, ProcessOverlayMutationResult } from "../tui/process/controller-adapter.ts";
import type { ProcessOverlayItem } from "../tui/process/types.ts";
import type { OutputCursor } from "../runtime/process/output.ts";

export interface ProcessOverlayClientOptions {
	readonly isDriver: () => boolean;
	readonly driverFence?: () => { readonly expectedHostGeneration: number; readonly expectedSessionGeneration: number; readonly expectedDriverRevision: number };
}

export function createProductionProcessOverlayClient(
	transport: HostRequestTransport,
	sessionId: string,
	options: ProcessOverlayClientOptions,
): ProcessOverlayHostClient {
	let sequence = 0;
	const command = async (operation: string, body: Record<string, unknown>): Promise<HostFrameEnvelope> => {
		const frameId = `client_process_${Date.now()}_${++sequence}`;
		return transport.request({
			frameId,
			kind: "command_request",
			protocolVersion: 1,
				body: { operation, commandId: frameId, sessionId, ...(options.driverFence?.() ?? {}), ...body },
		});
	};

	const mutation = async (
		operation: "process.write" | "process.resize" | "process.stop",
		body: Record<string, unknown>,
	): Promise<ProcessOverlayMutationResult> => {
		if (!options.isDriver()) return { ok: false, code: "observer_mutation_forbidden" };
		try {
			const response = await command(operation, body);
			if (response.body.ok === false) return { ok: false, code: responseCode(response) };
			const receiptDigest = isRuntimeDigest(response.body.receiptDigest) ? response.body.receiptDigest : undefined;
			return receiptDigest === undefined ? { ok: true } : { ok: true, receiptDigest };
		} catch {
			return { ok: false, code: "host_unavailable" };
		}
	};

	return {
		listProcesses: async (): Promise<readonly ProcessOverlayItem[]> => {
			const response = await command("process.list", {});
			if (response.body.ok === false) throw new Error(responseCode(response));
			return Array.isArray(response.body.processes)
				? response.body.processes.flatMap((value) => {
						const item = parseProcessItem(value);
						return item === undefined ? [] : [item];
				  })
				: [];
		},
		processOutput: async (executionId, cursor, maxBytes) => {
			if (!isOutputCursor(cursor) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > RUNTIME_HOST_BOUNDS.maxOutputPageBytes) {
				return { ok: false, code: "output_cursor_invalid" };
			}
			try {
				const response = await command("process.output", { executionId, cursor, maxBytes });
				if (response.body.ok === false) {
					const earliestCursor = isOutputCursor(response.body.earliestCursor) ? response.body.earliestCursor : undefined;
					return earliestCursor === undefined
						? { ok: false, code: responseCode(response) }
						: { ok: false, code: responseCode(response), earliestCursor };
				}
				if (typeof response.body.page !== "string" || !isOutputCursor(response.body.startCursor) || !isOutputCursor(response.body.endCursor) || !isOutputCursor(response.body.nextCursor) || !isOutputCursor(response.body.head) || typeof response.body.truncated !== "boolean") {
					return { ok: false, code: "invalid_process_output" };
				}
				return {
					ok: true,
					text: response.body.page,
					startCursor: response.body.startCursor,
					endCursor: response.body.endCursor,
					nextCursor: response.body.nextCursor,
					truncated: response.body.truncated,
					head: response.body.head,
				};
			} catch {
				return { ok: false, code: "host_unavailable" };
			}
		},
		writeStdin: (executionId, input) => mutation("process.write", { executionId, input }),
		resizeProcess: (executionId, columns, rows) => mutation("process.resize", { executionId, columns, rows }),
		stopProcess: (executionId, signal) => mutation("process.stop", signal === undefined ? { executionId } : { executionId, signal }),
	};
}

function parseProcessItem(value: unknown): ProcessOverlayItem | undefined {
	if (!isRecord(value) || !isExecutionId(value.executionId) || !isAttemptId(value.attemptId) || typeof value.state !== "string") return undefined;
	if (!isOutputCursor(value.outputCursor) || !isSafeCursor(value.outputSize)) return undefined;
	const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
	return {
		executionId: value.executionId,
		attemptId: value.attemptId,
		state: value.state,
		outputCursor: value.outputCursor,
		outputSize: value.outputSize,
		canWrite: capabilities.canWrite === true,
		canResize: capabilities.canResize === true,
		canStop: capabilities.canStop === true,
		commandDisplay: parseCommandDisplay(value.commandDisplay),
	};
}

function parseCommandDisplay(value: unknown): ProcessOverlayItem["commandDisplay"] {
	if (!isRecord(value) || typeof value.authority !== "string") return { authority: "unavailable" };
	if (value.authority === "unavailable") return { authority: "unavailable" };
	if (
		(value.authority !== "authorized" && value.authority !== "spawned") ||
		typeof value.label !== "string" || value.label.length === 0 || Buffer.byteLength(value.label, "utf8") > 256 ||
		/[\u0000-\u001f\u007f]/u.test(value.label) || !isRuntimeDigest(value.receiptDigest)
	) {
		return { authority: "unavailable" };
	}
	return { authority: value.authority, label: value.label, receiptDigest: value.receiptDigest };
}

function isExecutionId(value: unknown): value is ExecutionId {
	return typeof value === "string" && /^execution_[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function isAttemptId(value: unknown): value is AttemptId {
	return typeof value === "string" && /^attempt_[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function isOutputCursor(value: unknown): value is OutputCursor {
	return isRecord(value) && isSafeCursor(value.sequence) && isSafeCursor(value.byteOffset);
}

function isSafeCursor(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function responseCode(response: HostFrameEnvelope): string {
	return typeof response.body.code === "string" ? response.body.code : "host_request_rejected";
}
