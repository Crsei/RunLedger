/**
 * 凭据无关引擎的 transport：带浏览器导航头的 fetch。
 *
 * 来源：oh-my-pi `coding-agent/src/web/search/providers/browser-page.ts`
 * （快照 `1c0303b1`）。上游在本层实现「先 fetch、被反爬挑战时升级到 headless
 * 浏览器（puppeteer + stealth + ALTCHA 求解）」的两级策略。
 *
 * RunLedger 未移植浏览器能力（无 browser tool、无 puppeteer 依赖、不引入新的
 * 外部进程面），因此这里只保留 fetch 一级：
 * - 出站一律经注入的受治 `fetch`，不直接调用全局 `fetch`；
 * - `BrowserFetchOptions.fetch` 成为必填；
 * - 上游的 `browser` 兜底选项与其 `shouldFallback`/`ready`/`afterNavigation`
 *   契约整体删除，而不是留下无实现的分支；
 * - 被反爬挑战时向上层返回该响应，由 provider 自行判定并报错（fail closed）。
 */

import type { WebSearchFetch } from "../../transport.ts";
import { buildBrowserNavigationHeaders } from "./browser-headers.ts";

/** HTML 以及响应状态与（跟随同 host 重定向后的）最终 URL。 */
export interface LoadedHtmlPage {
	readonly html: string;
	readonly status: number;
	readonly url: string;
}

/** 控制一次带浏览器画像的 fetch。 */
export interface BrowserFetchOptions {
	readonly fetch: WebSearchFetch;
	readonly signal: AbortSignal;
	readonly randomizeHeaders?: boolean;
	readonly referer?: string;
	readonly init?: Omit<RequestInit, "headers" | "signal">;
	readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 以浏览器导航指纹发一次请求。
 *
 * `signal` 必填：受治 port 的可取消性是该层唯一的超时/中断手段。
 */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const response = await options.fetch(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}
