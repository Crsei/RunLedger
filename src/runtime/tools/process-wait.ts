/** Positive-timeout managed-process wait tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { OutputCursor } from "../process/output.ts";
import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";
import { errorToolResult, processHandleSchema, safeSummary, toProcessHandle, type ProcessToolClient } from "./process-tool-support.ts";

export const processWaitSchema = Type.Object({
	handle: processHandleSchema,
	timeout_ms: Type.Integer({ minimum: 1, maximum: RUNTIME_HOST_BOUNDS.maxWaitMs }),
}, { additionalProperties: false });
export type ProcessWaitInput = Static<typeof processWaitSchema>;

export type ProcessWaitDetails = {
	readonly outcome: string;
	readonly summary: ReturnType<typeof safeSummary>;
	readonly nextCursor: OutputCursor;
} | { readonly code: string };

export function createProcessWaitTool(client: Pick<ProcessToolClient, "processWait">, options: { readonly actor?: "driver" | "observer" } = {}): AgentTool<typeof processWaitSchema, ProcessWaitDetails> {
	const actor = options.actor ?? "observer";
	return {
		name: "process_wait",
		label: "process_wait",
		description: "在固定正超时内等待受治理进程；超时只结束 waiter，不改变进程状态。",
		parameters: processWaitSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_toolCallId, params): Promise<AgentToolResult<ProcessWaitDetails>> {
			const result = await client.processWait(toProcessHandle(params.handle), params.timeout_ms, actor);
			if (!result.ok) return errorToolResult(result.code);
			const details: ProcessWaitDetails = {
				outcome: result.outcome,
				summary: safeSummary(result.summary),
				nextCursor: result.nextCursor,
			};
			return {
				content: [{ type: "text", text: `process ${result.outcome}` }],
				details,
				isError: result.outcome === "uncertain",
			};
		},
	};
}
