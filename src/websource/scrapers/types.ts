/**
 * Shared types and utilities for web-fetch handlers
 */
import type { WebSearchFetch } from "../transport.ts";
import type { WebSearchCredentialPort } from "../credentials.ts";
import type { WebSearchSettings } from "../settings.ts";
import { combineSignals, sleep } from "../internal/platform.ts";
import { createTurndown } from "../internal/turndown/create.ts";
import type TurndownService from "../internal/turndown/service.ts";
import { ToolAbortError } from "../internal/abort.ts";

export { formatNumber } from "../internal/platform.ts";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

/**
 * 一次抓取调用的运行时上下文。
 *
 * 上游 handler 直接用全局 `fetch` 与 `settings`/`AgentStorage`;RunLedger 把这些
 * 显式注入,使出站始终经过受治 `Network` port,且库层不持有全局单例。
 */
export interface ScraperContext {
	readonly fetch: WebSearchFetch;
	readonly credentials: WebSearchCredentialPort;
	readonly settings?: WebSearchSettings;
}

export type SpecialHandler = (
	url: string,
	timeout: number,
	context: ScraperContext,
	signal?: AbortSignal,
) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function isBotBlocked(status: number, content: string): boolean {
	if (status === 403 || status === 503) {
		const lower = content.toLowerCase();
		return (
			lower.includes("cloudflare") ||
			lower.includes("captcha") ||
			lower.includes("challenge") ||
			lower.includes("blocked") ||
			lower.includes("access denied") ||
			lower.includes("bot detection")
		);
	}
	return false;
}

/**
 * Truncate and cleanup output
 */
export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
	/**
	 * Return true to skip reading the response body for this content type
	 * (lowercased mime, no params). The caller is expected to re-fetch the
	 * payload as binary; this avoids streaming + decoding huge binaries twice.
	 */
	skipBodyForContentType?: (contentType: string) => boolean;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	/** True when the body was cut mid-stream at maxBytes. */
	truncated?: boolean;
	/** Last transport-level error message when ok is false. */
	error?: string;
	/** True when the body read was skipped via skipBodyForContentType. */
	bodySkipped?: boolean;
}

const RETRY_AFTER_MAX_MS = 10_000;

/** Parse a Retry-After header (seconds or HTTP-date) into a bounded delay. */
function parseRetryAfterMs(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
	return 1_000;
}

function charsetFromContentType(header: string): string | undefined {
	return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then a cheap <meta charset> sniff), falling back to UTF-8.
 */
function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label) {
		// All charsets we can decode are ASCII-compatible in the prefix, so a
		// latin1 view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			// 运行时接受全部 WHATWG 标签（shift_jis、euc-kr、gbk、big5…）。
			// Node 的 TextDecoder 声明 label 为 string，Bun 的则声明为字面量联合
			// `Encoding`，两者都不接受对方的入参形状，因此按构造参数类型转换;
			// 不支持的标签会在这里抛错，由下面的 catch 回退 UTF-8。
			return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall back to UTF-8.
		}
	}
	return bytes.toString("utf-8");
}

/**
 * Fetch a page with timeout and size limit
 */
export async function loadPage(context: ScraperContext, url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers = {}, maxBytes = MAX_BYTES, signal, method = "GET", body } = options;

	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const userAgent = USER_AGENTS[attempt];
		const requestSignal = combineSignals(signal, timeout * 1000);

		try {
			const requestInit: RequestInit = {
				signal: requestSignal,
				method,
				headers: {
					"User-Agent": userAgent,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					"Accept-Encoding": "identity", // Cloudflare Markdown-for-Agents returns corrupted bytes when compression is negotiated
					...headers,
				},
				redirect: "follow",
			};

			if (body !== undefined) {
				requestInit.body = body;
			}

			const response = await context.fetch(url, requestInit);

			const rawContentType = response.headers.get("content-type") ?? "";
			const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
			const finalUrl = response.url;

			if (response.status === 429 && !retried429) {
				// Rate limited: retry once, honoring a bounded Retry-After. The
				// wait observes the caller's signal so an Esc during the backoff
				// does not stall for up to the full delay.
				retried429 = true;
				const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
				void response.body?.cancel().catch(() => {});
				try {
					await sleep(delayMs, signal);
				} catch {
					throw new ToolAbortError();
				}
				attempt--; // Reuse the same user agent for the retry.
				continue;
			}

			if (response.ok && options.skipBodyForContentType?.(contentType)) {
				void response.body?.cancel().catch(() => {});
				return { content: "", contentType, finalUrl, ok: true, status: response.status, bodySkipped: true };
			}

			const reader = response.body?.getReader();
			if (!reader) {
				return { content: "", contentType, finalUrl, ok: false, status: response.status };
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;
			let truncated = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				totalSize += value.length;

				if (totalSize > maxBytes) {
					truncated = true;
					void reader.cancel().catch(() => {});
					break;
				}
			}

			const content = decodeBody(Buffer.concat(chunks), rawContentType);
			if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
				continue;
			}

			if (!response.ok) {
				return { content, contentType, finalUrl, ok: false, status: response.status, truncated };
			}

			return { content, contentType, finalUrl, ok: true, status: response.status, truncated };
		} catch (error) {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === USER_AGENTS.length - 1) {
				return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

/** Module-level Turndown instance — built lazily on first use. */
let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= initTurndown();
	return turndownPromise;
}

async function initTurndown(): Promise<TurndownService> {
	return createTurndown();
}

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const turndown = await getTurndown();
	return turndown.turndown(cleaned).trim();
}

/**
 * Build a RenderResult from markdown content. Calls finalizeOutput internally.
 */
export function buildResult(
	md: string,
	opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
	const output = finalizeOutput(md);
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: output.content,
		fetchedAt: opts.fetchedAt,
		truncated: output.truncated,
		notes: opts.notes ?? [],
	};
}

/**
 * Format a date value as YYYY-MM-DD. Returns empty string on invalid input.
 */
export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract localized text, preferring en-US/en.
 */
export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

/**
 * Check if content looks like HTML by inspecting the leading tag.
 */
export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
