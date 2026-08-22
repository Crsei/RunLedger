import type { TimelineAssistantUsage } from "./types.ts";

/** 小于这个前缀时，cacheRead=0 不能证明发生了 prompt cache 失效。 */
export const MIN_CACHE_FOOTPRINT = 2_048;

export interface CacheInvalidation {
	readonly reprocessedTokens: number;
}

/**
 * 只标记已确认 warm -> cold 的显式 prompt cache 转换。
 *
 * 首次请求通常只写 cache，隐式 provider cache 也可能短暂回报 0；两类
 * 情况都不应在 TUI 制造误报。连续 cold 请求也不会重复产生 marker。
 */
export function detectCacheInvalidation(
	previous: TimelineAssistantUsage | undefined,
	current: TimelineAssistantUsage,
): CacheInvalidation | undefined {
	const previousCacheRead = usageValue(previous?.cacheRead);
	const currentCacheRead = usageValue(current.cacheRead);
	const currentCacheWrite = usageValue(current.cacheWrite);
	const currentInput = usageValue(current.input);
	if (previousCacheRead === undefined || previousCacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	if (currentCacheRead === undefined || currentCacheRead > 0) return undefined;
	if (currentCacheWrite === undefined || currentCacheWrite <= 0) return undefined;
	if (currentInput === undefined) return undefined;
	const reprocessedTokens = currentCacheWrite + currentInput;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}

/** 只有有可比较的 input/cache usage 时，才把该 assistant 作为下一轮前序。 */
export function hasCacheFootprint(usage: TimelineAssistantUsage | undefined): usage is TimelineAssistantUsage {
	if (usage === undefined) return false;
	const input = usageValue(usage.input);
	const cacheRead = usageValue(usage.cacheRead);
	const cacheWrite = usageValue(usage.cacheWrite);
	return input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
		&& input + cacheRead + cacheWrite > 0;
}

function usageValue(quantity: TimelineAssistantUsage["input"] | undefined): number | undefined {
	return quantity?.state === "exact" || quantity?.state === "estimated" ? quantity.value : undefined;
}
