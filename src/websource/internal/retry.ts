/**
 * 有界 HTTP 重试。
 *
 * 上游 `packages/utils/src/fetch-retry.ts` 的已用子集：只保留
 * `{ maxAttempts, maxDelayMs, fetch }` 与 429/5xx（含 408）重试、有界
 * `Retry-After` 提示。上游那套 `QuotaReset` / `reset at` 正文文案解析是
 * provider 配额提示专用，web 抓取用不到，不在此移植。
 *
 * 与上游的差异：
 * - 传输由调用方注入（`WebSearchFetch`，受治 `Network` port 适配层），
 *   不再有 `fetch` 全局兜底；
 * - 等待用 `internal/platform.ts` 的 `sleep`，调用方 signal 优先。
 */

import type { WebSearchFetch } from "../transport.ts";
import { sleep } from "./platform.ts";

/** 未显式指定时的重试上限；reader 链的调用方都会显式给更小的预算。 */
const DEFAULT_MAX_ATTEMPTS = 3;
/** 未显式指定时的单次退避上限（毫秒）。 */
const DEFAULT_MAX_DELAY_MS = 2_000;
/** 无 `Retry-After` 提示时的基准退避：500ms 起指数增长。 */
const BASE_DELAY_MS = 500;

export interface FetchWithRetryOptions {
	/** 总尝试次数（含首次）；默认 3。 */
	readonly maxAttempts?: number;
	/** 单次退避上限（毫秒）；默认 2000。 */
	readonly maxDelayMs?: number;
}

/** `Retry-After` 数字秒或 HTTP 日期；无提示返回 `undefined`。 */
function retryAfterMs(headers: Headers): number | undefined {
	const raw = headers.get("retry-after");
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * 用受治通道发起请求，对 408/429/5xx 与网络错误做有界重试。
 *
 * `Retry-After` 超过 `maxDelayMs` 时直接返回该响应，不睡到 signal 超时；
 * signal 中止立即抛出，不完成剩余尝试。
 */
export async function fetchWithRetry(
	fetchImpl: WebSearchFetch,
	url: string,
	init?: RequestInit,
	options?: FetchWithRetryOptions,
): Promise<Response> {
	const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const signal = init?.signal ?? undefined;

	for (let attempt = 0; ; attempt += 1) {
		signal?.throwIfAborted();

		let response: Response;
		try {
			response = await fetchImpl(url, init);
		} catch (error) {
			signal?.throwIfAborted();
			if (attempt + 1 >= maxAttempts) throw error;
			await sleep(Math.min(BASE_DELAY_MS * 2 ** attempt, maxDelayMs), signal);
			continue;
		}

		// 408 (Request Timeout) / 429 / 5xx 视为瞬时错误；其余状态直接返回。
		const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
		if (!retryable || attempt + 1 >= maxAttempts) return response;

		const hint = retryAfterMs(response.headers);
		if (hint !== undefined && hint > maxDelayMs) return response;
		await sleep(Math.min(hint ?? BASE_DELAY_MS * 2 ** attempt, maxDelayMs), signal);
	}
}
