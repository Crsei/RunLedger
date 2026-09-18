/** Checkpoint rewind tool.  The driver owns the Session switch. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";
import { NAMED_CHECKPOINT_LIMITS } from "../session-runtime/named-checkpoint.ts";
import type { NamedCheckpointToolPort } from "../session-runtime/named-checkpoint-domain.ts";

export const rewindSchema = Type.Object({
	checkpoint: Type.String({ minLength: 1, maxLength: 128 }),
	report: Type.String({ minLength: 1, maxLength: NAMED_CHECKPOINT_LIMITS.maxReportChars }),
}, { additionalProperties: false });
export type RewindToolInput = Static<typeof rewindSchema>;

export function createRewindTool(port?: NamedCheckpointToolPort): AgentTool<typeof rewindSchema> {
	return {
		name: "rewind",
		label: "Rewind to Checkpoint",
		description: "Fork a fresh Session from a named checkpoint and hand the report to it. The current Session remains append-only and is never edited or deleted.",
		parameters: rewindSchema,
		isDestructive: () => true,
		isConcurrencySafe: () => false,
		async execute(_toolCallId, params, signal) {
			if (port === undefined) throw new Error("rewind port 未注入");
			const result = await port.rewind(params.checkpoint, params.report, signal);
			return {
				content: [{ type: "text", text: result.ok ? `Rewind created Session ${result.targetSessionId}.` : `rewind failed: ${result.code}.` }],
				details: result,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
