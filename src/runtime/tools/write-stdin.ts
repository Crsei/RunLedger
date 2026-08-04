/** Driver-fenced stdin mutation tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { errorToolResult, processHandleSchema, safeSummary, toProcessHandle, type ProcessToolClient } from "./process-tool-support.ts";

export const writeStdinSchema = Type.Object({
	handle: processHandleSchema,
	input: Type.String({ maxLength: 64 * 1024 }),
}, { additionalProperties: false });
export type WriteStdinInput = Static<typeof writeStdinSchema>;

export type WriteStdinDetails = {
	readonly operation: "write";
	readonly receiptDigest: unknown;
	readonly summary: ReturnType<typeof safeSummary>;
} | { readonly code: string };

export function createWriteStdinTool(client: Pick<ProcessToolClient, "write">, options: { readonly actor?: "driver" | "observer" } = {}): AgentTool<typeof writeStdinSchema, WriteStdinDetails> {
	const actor = options.actor ?? "observer";
	return {
		name: "write_stdin",
		label: "write_stdin",
		description: "向受治理进程写入 bounded stdin；只有当前 driver 可以执行。",
		parameters: writeStdinSchema,
		isDestructive: () => true,
		async execute(_toolCallId, params): Promise<AgentToolResult<WriteStdinDetails>> {
			if (actor !== "driver") return errorToolResult("observer_mutation_forbidden");
			const result = await client.write(toProcessHandle(params.handle), actor, params.input);
			if (!result.ok) return errorToolResult(result.code);
			return {
				content: [{ type: "text", text: "stdin delivered" }],
				details: { operation: "write", receiptDigest: result.receiptDigest, summary: safeSummary(result.summary) },
			};
		},
	};
}
