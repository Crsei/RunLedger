/**
 * S8.2 拆分:tool schema 转换。
 */

import OpenAI from "openai";
import type { Tool } from "../../types.ts";
import type { ResolvedOpenAICompletionsCompat } from "./compat-detection.ts";

export function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any, // TypeBox already generates JSON Schema
			// Only include strict if provider supports it. Some reject unknown fields.
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}
