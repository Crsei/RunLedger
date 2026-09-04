/** minimal@1 只收窄模型 schema；执行仍委托同一个 governed bash leaf。 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import type { ToolContext } from "../tool-context.ts";
import { bashSchema, type BashToolDetails, type BashToolInput } from "../tools/bash.ts";

export const minimalBashSchema = Type.Object(
	{
		command: bashSchema.properties.command,
		timeout: bashSchema.properties.timeout,
		stdin: bashSchema.properties.stdin,
		output_format: bashSchema.properties.output_format,
	},
	{ additionalProperties: false },
);

export type MinimalBashToolInput = Static<typeof minimalBashSchema>;

export function createMinimalBashDelegate(
	governedBash: AgentTool,
): AgentTool<typeof minimalBashSchema, BashToolDetails> {
	if (governedBash.name !== "bash") {
		throw new HarnessToolProjectionError("minimal bash delegate requires the governed bash tool");
	}
	const execute = governedBash.execute as AgentTool<typeof bashSchema, BashToolDetails>["execute"];
	return Object.freeze({
		name: governedBash.name,
		label: governedBash.label,
		description: governedBash.description,
		parameters: minimalBashSchema,
		...(governedBash.executionMode === undefined ? {} : { executionMode: governedBash.executionMode }),
		...(governedBash.isReadOnly === undefined ? {} : { isReadOnly: governedBash.isReadOnly }),
		...(governedBash.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: governedBash.isConcurrencySafe }),
		...(governedBash.isDestructive === undefined ? {} : { isDestructive: governedBash.isDestructive }),
		...(governedBash.maxResultSizeChars === undefined ? {} : { maxResultSizeChars: governedBash.maxResultSizeChars }),
		...(governedBash.capabilityClaims === undefined ? {} : { capabilityClaims: governedBash.capabilityClaims }),
		execute: (
			toolCallId: string,
			params: MinimalBashToolInput,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
			context?: ToolContext,
		): Promise<AgentToolResult<BashToolDetails>> => execute(
			toolCallId,
			params satisfies BashToolInput,
			signal,
			onUpdate,
			context,
		),
	});
}

export class HarnessToolProjectionError extends Error {
	public readonly code = "harness_tool_projection_invalid" as const;

	public constructor(message: string) {
		super(message);
		this.name = "HarnessToolProjectionError";
	}
}
