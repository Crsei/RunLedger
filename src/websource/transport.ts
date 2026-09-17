/**
 * websource 出站传输：把受治 `Network` port 适配成裸 `fetch` 形状。
 *
 * 上游 `web/` 的每个 provider / scraper 都直接调用全局 `fetch`。RunLedger 要求
 * 所有出站经过 `ExecutionEnv.network`（`ExecutionGateway` + attempt fence +
 * owner fence），因此本模块是移植层唯一的出站入口。
 *
 * 与上游的差异（均为显式裁定，见开发计划 §3 D8）：
 * - 重定向由本模块自行跟随，上限 `maxRedirects`，且只允许同 host+port 跳转。
 *   受治 broker 用 `redirect: "manual"` 且 `PolicyNetworkClient` 拒绝跨 host/port
 *   的 `finalUrl`，所以这里必须自己跟随并把跨站跳转fail closed。
 * - `Network` port 是缓冲式的：响应体一次性取回，`maxBytes` 同时是策略上限与
 *   实际读取上限。超过上限由策略层拒绝（fail closed），不做流式截断。
 * - 每次请求都带上 `principal`，使审计与审批归属到真实工具而不是固定 `WebFetch`。
 */

import type { Network, NetworkRequest, NetworkResponse } from "../runtime/execution-env.ts";

/** 上游代码使用的 `fetch` 形状；返回值是真实 `Response`，可直接复用其全部读取面。 */
export type WebSearchFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebSearchFetchOptions {
	readonly network: Network;
	/** 审计/审批归属的工具名。 */
	readonly principal: string;
	/** 策略上限与实际读取上限；默认 16 MiB。 */
	readonly maxBytes?: number;
	/** 同 host 重定向跳数上限；默认 5。 */
	readonly maxRedirects?: number;
	/** 缺省 User-Agent；调用方 headers 中同名项优先。 */
	readonly userAgent?: string;
}

/** 上游 `scrapers/types.ts:MAX_BYTES` 是 50 MiB；缓冲式 port 下调到 16 MiB。 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

export class WebSourceNetworkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebSourceNetworkError";
	}
}

export function createWebSearchFetch(options: WebSearchFetchOptions): WebSearchFetch {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new WebSourceNetworkError("websource: maxBytes must be a positive integer");
	}
	return async (input, init = {}) => {
		const method = (init.method ?? "GET").toUpperCase();
		const redirectMode = init.redirect ?? "follow";
		const signal = init.signal ?? undefined;
		const requestHeaders = toHeaderRecord(init.headers);
		const body = toRequestBuffer(init.body);
		let currentUrl = input;
		for (let hop = 0; ; hop += 1) {
			const request: NetworkRequest = {
				url: currentUrl,
				method,
				headers: options.userAgent === undefined ? requestHeaders : { "user-agent": options.userAgent, ...requestHeaders },
				maxBytes,
				principal: options.principal,
				...(body === undefined ? {} : { body }),
			};
			const response = await options.network.request(request, signal);
			const location = headerValue(response.headers, "location");
			const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;
			if (isRedirect && redirectMode !== "manual") {
				if (hop >= maxRedirects) {
					throw new WebSourceNetworkError(`websource: too many redirects (${maxRedirects}) for ${input}`);
				}
				const next = resolveRedirect(location, currentUrl);
				assertSameOrigin(next, currentUrl);
				currentUrl = next;
				continue;
			}
			return toResponse(response, currentUrl);
		}
	};
}

function resolveRedirect(location: string, base: string): string {
	try {
		return new URL(location, base).toString();
	} catch {
		throw new WebSourceNetworkError(`websource: redirect target is not a valid URL: ${location}`);
	}
}

function assertSameOrigin(next: string, current: string): void {
	const from = new URL(current);
	const to = new URL(next);
	if (from.hostname !== to.hostname || from.port !== to.port) {
		throw new WebSourceNetworkError(
			`websource: cross-host redirect ${from.hostname} -> ${to.hostname} is denied`,
		);
	}
}

function toHeaderRecord(headers: RequestInit["headers"]): Record<string, string> {
	const result: Record<string, string> = {};
	if (headers === undefined) return result;
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	if (Array.isArray(headers)) {
		for (const entry of headers) {
			const [key, value] = entry;
			if (typeof value === "string") result[key] = value;
		}
		return result;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function toRequestBuffer(body: RequestInit["body"]): Buffer | string | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	throw new WebSourceNetworkError("websource: request body must be a string or a byte buffer");
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

/** 无 body 的响应状态：构造 `Response` 时不得携带 body。 */
const BODYLESS_STATUSES: Readonly<Record<number, true>> = { 101: true, 103: true, 204: true, 205: true, 304: true };

function toResponse(response: NetworkResponse, finalUrl: string): Response {
	const observable = new Response(
		BODYLESS_STATUSES[response.status] === true ? null : new Uint8Array(response.body),
		{
			status: response.status,
			headers: response.headers,
		},
	);
	// `Response` 的 url 只读且构造时为空；上游代码依赖它的重定向终态语义。
	Object.defineProperty(observable, "url", { value: finalUrl, configurable: true });
	return observable;
}
