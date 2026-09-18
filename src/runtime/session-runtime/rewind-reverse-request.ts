/** One-shot Session reverse request for checkpoint rewind. */

import type { ConnectionId } from "../protocol/ids.ts";
import type { SessionFrameEnvelope } from "../session-server/protocol.ts";
import type { ReverseRequestSender } from "./credential-reverse-request.ts";

export const CHECKPOINT_REWIND_REQUEST_KIND = "checkpoint_rewind";
export const CHECKPOINT_REWIND_LIMITS = Object.freeze({ maxCheckpointChars: 128, maxReportChars: 16_384, maxGoalChars: 1_024 });

export interface RewindDriverRequest {
	readonly checkpointId: string;
	readonly checkpointGoal: string;
	readonly sourceSessionId: string;
	readonly checkpointSequence: number;
	readonly expectedSourceHeadSequence: number;
	readonly expectedCatalogRevision: number;
	readonly report: string;
}

export type RewindDriverResponse =
	| { readonly ok: true; readonly targetSessionId: string }
	| { readonly ok: false; readonly code: string };

export interface RewindPort {
	request(input: RewindDriverRequest, signal?: AbortSignal): Promise<RewindDriverResponse>;
}

export interface ReverseRequestRewindPortOptions {
	readonly sender: ReverseRequestSender;
	readonly connectionId: ConnectionId | (() => ConnectionId | undefined);
	readonly timeoutMs?: number | null;
}

export function createReverseRequestRewindPort(options: ReverseRequestRewindPortOptions): RewindPort {
	const resolveConnection = typeof options.connectionId === "function" ? options.connectionId : () => options.connectionId as ConnectionId;
	return {
		async request(input, signal) {
			if (!isRewindDriverRequest(input)) return { ok: false, code: "reverse_request_invalid" };
			const connectionId = resolveConnection();
			if (connectionId === undefined) return { ok: false, code: "reverse_request_unhandled" };
			let frame: SessionFrameEnvelope;
			try {
				frame = await options.sender.requestToConnection(connectionId, { kind: CHECKPOINT_REWIND_REQUEST_KIND, body: encodeRewindRequest(input) }, options.timeoutMs === undefined ? null : options.timeoutMs, signal);
			} catch (error) {
				if (signal?.aborted === true) return { ok: false, code: "aborted" };
				return { ok: false, code: /timed out/u.test(error instanceof Error ? error.message : String(error)) ? "timeout" : "delivery_failed" };
			}
			return decodeRewindResponse(frame.body);
		},
	};
}

export function encodeRewindRequest(input: RewindDriverRequest): Record<string, unknown> {
	return { ...input };
}

export function decodeRewindRequest(value: unknown): RewindDriverRequest | undefined {
	if (!isRecord(value)) return undefined;
	const candidate: RewindDriverRequest = {
		checkpointId: typeof value.checkpointId === "string" ? value.checkpointId : "",
		checkpointGoal: typeof value.checkpointGoal === "string" ? value.checkpointGoal : "",
		sourceSessionId: typeof value.sourceSessionId === "string" ? value.sourceSessionId : "",
		checkpointSequence: typeof value.checkpointSequence === "number" ? value.checkpointSequence : 0,
		expectedSourceHeadSequence: typeof value.expectedSourceHeadSequence === "number" ? value.expectedSourceHeadSequence : 0,
		expectedCatalogRevision: typeof value.expectedCatalogRevision === "number" ? value.expectedCatalogRevision : -1,
		report: typeof value.report === "string" ? value.report : "",
	};
	return isRewindDriverRequest(candidate) ? candidate : undefined;
}

function decodeRewindResponse(value: Record<string, unknown>): RewindDriverResponse {
	if (value.ok === true && typeof value.targetSessionId === "string" && value.targetSessionId.length > 0) return { ok: true, targetSessionId: value.targetSessionId };
	return { ok: false, code: typeof value.code === "string" && value.code.length > 0 ? value.code : "reverse_request_invalid" };
}

function isRewindDriverRequest(value: RewindDriverRequest): boolean {
	return value.checkpointId.length > 0 && value.checkpointId.length <= CHECKPOINT_REWIND_LIMITS.maxCheckpointChars
		&& value.checkpointGoal.length > 0 && value.checkpointGoal.length <= CHECKPOINT_REWIND_LIMITS.maxGoalChars
		&& value.sourceSessionId.length > 0 && value.sourceSessionId.length <= 128
		&& value.report.length > 0 && value.report.length <= CHECKPOINT_REWIND_LIMITS.maxReportChars
		&& Number.isSafeInteger(value.checkpointSequence) && value.checkpointSequence > 0
		&& Number.isSafeInteger(value.expectedSourceHeadSequence) && value.expectedSourceHeadSequence >= value.checkpointSequence
		&& Number.isSafeInteger(value.expectedCatalogRevision) && value.expectedCatalogRevision >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
