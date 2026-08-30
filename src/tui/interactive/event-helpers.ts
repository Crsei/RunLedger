/**
 * S7 拆分:event 投影纯 helper(assistant 文本/thinking 提取与 stop reason 判定)。
 */

import type { AgentMessage } from "../../runtime/types.ts";

export function messageAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

export function messageAssistantThinking(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((content) => content.type === "thinking")
		.map((content) => content.thinking)
		.join("");
}

export function isRunStopReason(value: string | undefined): value is "stop" | "length" | "toolUse" | "error" | "aborted" {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}
