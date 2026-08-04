/** Driver-fenced managed-process stop tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { errorToolResult, processHandleSchema, safeSummary, toProcessHandle, type ProcessToolClient } from "./process-tool-support.ts";

export const processStopSchema = Type.Object({
	handle: processHandleSchema,
	signal: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
}, { additionalProperties: false });
export type ProcessStopInput = Static<typeof processStopSchema>;

export type ProcessStopDetails = {
	readonly operation: "stop";
	readonly receiptDigest: unknown;
	readonly summary: ReturnType<typeof safeSummary>;
} | { readonly code: string };

export function createProcessStopTool(client: Pick<ProcessToolClient, "stop">, options: { readonly actor?: "driver" | "observer" } = {}): AgentTool<typeof processStopSchema, ProcessStopDetails> {
	const actor = options.actor ?? "observer";
	return {
		name: "process_stop",
		label: "process_stop",
		description: "请求 Host 停止受治理进程；只返回安全 receipt，不暴露 PID 或 process group。",
		parameters: processStopSchema,
		isDestructive: () => true,
		async execute(_toolCallId, params): Promise<AgentToolResult<ProcessStopDetails>> {
			if (actor !== "driver") return errorToolResult("observer_mutation_forbidden");
			const result = await client.stop(toProcessHandle(params.handle), actor, params.signal as NodeJS.Signals | undefined);
			if (!result.ok) return errorToolResult(result.code);
			return {
				content: [{ type: "text", text: "stop requested" }],
				details: { operation: "stop", receiptDigest: result.receiptDigest, summary: safeSummary(result.summary) },
			};
		},
	};
}
