/**
 * S8.1 拆分:Codex adapter 公共选项类型。
 */

import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { StreamOptions } from "../../types.ts";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}
