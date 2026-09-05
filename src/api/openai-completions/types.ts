/**
 * S8.2 拆分:OpenAI completions adapter 公共选项类型。
 */

import type { StreamOptions, ThinkingBudgets } from "../../types.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	thinkingBudgets?: ThinkingBudgets;
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
