/** Non-blocking bounded managed-process output tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { OutputCursor } from "../process/output.ts";
import {
	errorToolResult,
	isBoundedPageSize,
	outputCursorSchema,
	processHandleSchema,
	toProcessHandle,
	type ProcessToolClient,
} from "./process-tool-support.ts";

export const processOutputSchema = Type.Object({
	handle: processHandleSchema,
	cursor: outputCursorSchema,
	max_bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 * 1024 })),
}, { additionalProperties: false });
export type ProcessOutputInput = Static<typeof processOutputSchema>;

export type ProcessOutputDetails = {
	readonly startCursor: OutputCursor;
	readonly endCursor: OutputCursor;
	readonly nextCursor: OutputCursor;
	readonly truncated: boolean;
	readonly head: { readonly sequence: number; readonly byteOffset: number };
} | { readonly code: string; readonly earliestCursor?: { readonly sequence: number; readonly byteOffset: number } };

export function createProcessOutputTool(client: Pick<ProcessToolClient, "processOutput">): AgentTool<typeof processOutputSchema, ProcessOutputDetails> {
	return {
		name: "process_output",
		label: "process_output",
		description: "立即读取受治理进程的 bounded output page；不会等待进程完成。",
		parameters: processOutputSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_toolCallId, params): Promise<AgentToolResult<ProcessOutputDetails>> {
			const maxBytes = params.max_bytes ?? 64 * 1024;
			if (!isBoundedPageSize(maxBytes)) return errorToolResult("output_page_bound_exceeded");
			const result = await client.processOutput(toProcessHandle(params.handle), params.cursor, maxBytes);
			if (!result.ok) {
				const failure = errorToolResult(result.code);
				return result.earliestCursor === undefined
					? failure
					: { ...failure, details: { code: result.code, earliestCursor: result.earliestCursor } };
			}
			return {
				content: [{ type: "text", text: result.page.text }],
				details: {
					startCursor: result.page.startCursor,
					endCursor: result.page.endCursor,
					nextCursor: result.page.nextCursor,
					truncated: result.page.truncated,
					head: result.head,
				},
			};
		},
	};
}
