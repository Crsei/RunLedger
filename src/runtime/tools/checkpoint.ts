/** Durable named checkpoint tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";
import { NAMED_CHECKPOINT_LIMITS } from "../session-runtime/named-checkpoint.ts";
import type { CheckpointCreateResult, NamedCheckpointToolPort } from "../session-runtime/named-checkpoint-domain.ts";

export const checkpointSchema = Type.Object({
	goal: Type.String({ minLength: 1, maxLength: NAMED_CHECKPOINT_LIMITS.maxGoalChars }),
}, { additionalProperties: false });
export type CheckpointToolInput = Static<typeof checkpointSchema>;

export function createCheckpointTool(port?: NamedCheckpointToolPort): AgentTool<typeof checkpointSchema, CheckpointCreateResult> {
	return {
		name: "checkpoint",
		label: "Create Checkpoint",
		description: "Create one durable named checkpoint at the latest completed assistant turn. A checkpoint records only conversation state; it does not snapshot files, git, processes, or credentials.",
		parameters: checkpointSchema,
		isDestructive: () => true,
		async execute(_toolCallId, params, signal) {
			if (port === undefined) throw new Error("checkpoint port 未注入");
			const result = await port.create(params.goal, signal);
			return {
				content: [{ type: "text", text: result.ok ? `Checkpoint ${result.checkpoint.checkpointId} created at event ${result.checkpoint.boundarySequence}.` : `checkpoint failed: ${result.code}.` }],
				details: result,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
