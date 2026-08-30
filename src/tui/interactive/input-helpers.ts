/**
 * S7 拆分:模块级纯 helper(user 消息正文提取)。
 */

import type { AgentMessage } from "../../runtime/types.ts";

export function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return message.content.map((content) => content.text).join("");
}
