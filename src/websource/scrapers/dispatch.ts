/**
 * 站点特化 handler 的派发。
 *
 * 上游 `tools/fetch.ts` 的 `handleSpecialUrls`（+ 惰性 `specialHandlers` 加载）：
 * 按注册顺序尝试每个 handler，首个返回非 null 结果者胜出，`null` 表示「本 URL
 * 不归我处理」。RunLedger 直接静态导入注册表（无 `await import()`），并保留
 * 「每次尝试前检查 abort」的语义。
 */

import type { RenderResult, ScraperContext } from "./types.ts";
import { ToolAbortError } from "../internal/abort.ts";
import { specialHandlers } from "./index.ts";

/** 顺序派发站点 handler；无命中返回 `null`。 */
export async function handleSpecialUrls(
	url: string,
	timeout: number,
	context: ScraperContext,
	signal?: AbortSignal,
): Promise<RenderResult | null> {
	for (const handler of specialHandlers) {
		if (signal?.aborted) throw new ToolAbortError();
		const result = await handler(url, timeout, context, signal);
		if (result !== null) return result;
	}
	return null;
}
