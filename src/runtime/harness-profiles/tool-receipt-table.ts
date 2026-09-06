/** 统一生成可由恢复路径重算的有序工具摘要表。 */
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import type { HarnessCompositionReceipt } from "./types.ts";

export function harnessToolReceiptTable(tools: readonly AgentTool[]): HarnessCompositionReceipt["tools"] {
	return Object.freeze(tools.map((tool) => Object.freeze({
		name: tool.name,
		descriptorDigest: runtimeDigest({ description: tool.description, parameters: tool.parameters }),
	})));
}
