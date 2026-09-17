/**
 * Exa MCP 响应归一与判定。
 *
 * 来源：oh-my-pi `exa/mcp-client.ts`（快照 `1c0303b1`）。上游该文件还包含
 * 「从 MCP schema 动态生成 CustomTool」的包装器（`MCPWrappedTool` /
 * `createMCPToolFromServer` / `fetchMCPToolSchema`）与 `tools/list` 拉取——那部分
 * 依赖上游的 `CustomTool` 扩展面，RunLedger 未移植，因此这里只保留检索路径实际
 * 消费的部分：
 *
 * - `isSearchResponse`：判定 MCP 返回值是不是一个检索响应（`exa.ts` 的 MCP 兜底
 *   用它区分「拿到了结果」与「拿到了错误/包装」）；
 * - `normalizeExaMcpPayload`：把 MCP 各种返回形状归一后再判定。
 *
 * 凭据与出站不再由本模块承担：`exa.ts` 用注入的凭据 port 与受治 transport。
 */

import { isRecord } from "../internal/platform.ts";
import type { ExaSearchResponse } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function parseJsonContent(text: string): unknown | null {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** 判定结果是否为检索响应。 */
export function isSearchResponse(data: unknown): data is ExaSearchResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data)
	);
}

/**
 * 归一 MCP `tools/call` 的返回形状。
 *
 * Exa 随部署/环境返回不同结构：直接载荷、`result.structuredContent` /
 * `result.data` / `result.result` 下的结构化载荷、以及 `result.content[]` 里以
 * 文本形式内嵌的 JSON。归一后再交给 {@link isSearchResponse} 判定。
 */
export function normalizeExaMcpPayload(payload: unknown): unknown {
	const candidates: unknown[] = [];
	const root = asRecord(payload);

	if (root) {
		if (root.structuredContent !== undefined) candidates.push(root.structuredContent);
		if (root.data !== undefined) candidates.push(root.data);
		if (root.result !== undefined) candidates.push(root.result);
		candidates.push(root);

		const content = root.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				const part = asRecord(item);
				if (!part) continue;
				const text = part.text;
				if (typeof text !== "string" || text.trim().length === 0) continue;
				const parsed = parseJsonContent(text);
				if (parsed !== null) candidates.push(parsed);
			}
		}
	} else {
		candidates.push(payload);
	}

	for (const candidate of candidates) {
		if (isSearchResponse(candidate)) return candidate;
	}

	return payload;
}
