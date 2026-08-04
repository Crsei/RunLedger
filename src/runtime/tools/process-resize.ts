/** Driver-fenced PTY resize tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { errorToolResult, processHandleSchema, safeSummary, toProcessHandle, type ProcessToolClient } from "./process-tool-support.ts";

export const processResizeSchema = Type.Object({
	handle: processHandleSchema,
	columns: Type.Integer({ minimum: 1, maximum: 512 }),
	rows: Type.Integer({ minimum: 1, maximum: 256 }),
}, { additionalProperties: false });
export type ProcessResizeInput = Static<typeof processResizeSchema>;

export type ProcessResizeDetails = {
	readonly operation: "resize";
	readonly receiptDigest: unknown;
	readonly summary: ReturnType<typeof safeSummary>;
} | { readonly code: string };

export function createProcessResizeTool(client: Pick<ProcessToolClient, "resize">, options: { readonly actor?: "driver" | "observer" } = {}): AgentTool<typeof processResizeSchema, ProcessResizeDetails> {
	const actor = options.actor ?? "observer";
	return {
		name: "process_resize",
		label: "process_resize",
		description: "调整受治理 PTY 的 bounded terminal size；只有当前 driver 可以执行。",
		parameters: processResizeSchema,
		isDestructive: () => true,
		async execute(_toolCallId, params): Promise<AgentToolResult<ProcessResizeDetails>> {
			if (actor !== "driver") return errorToolResult("observer_mutation_forbidden");
			const result = await client.resize(toProcessHandle(params.handle), actor, params.columns, params.rows);
			if (!result.ok) return errorToolResult(result.code);
			return {
				content: [{ type: "text", text: `PTY resized to ${params.columns}x${params.rows}` }],
				details: { operation: "resize", receiptDigest: result.receiptDigest, summary: safeSummary(result.summary) },
			};
		},
	};
}
