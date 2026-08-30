/**
 * S8.4 拆分:tool config 转换。
 */

import {
	type Tool as BedrockTool,
	type ToolChoice,
	type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { Tool } from "../../types.ts";
import type { BedrockOptions } from "./types.ts";

export function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters as unknown as DocumentType },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}
