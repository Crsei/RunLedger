/**
 * Firecrawl API Client
 *
 * Shared Firecrawl REST helpers: endpoint resolution (honouring an injected
 * self-hosting override) and the `/scrape` reader backend used by the
 * fetch/read URL tool. The web search provider builds its `/search` request
 * on the same endpoint resolver.
 *
 * See https://docs.firecrawl.dev/api-reference/endpoint/scrape.
 */
import { type WebSearchCredentialPort, withApiKey } from "./credentials.ts";
import type { WebSearchFetch } from "./transport.ts";
import { fetchWithRetry } from "./internal/retry.ts";
import { withHardTimeout } from "./search/providers/utils.ts";

const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev/v2";
/** Cap on honoured `Retry-After` hints; longer hints fail fast to the next backend. */
const RETRY_MAX_DELAY_MS = 2_000;

/**
 * Resolve a Firecrawl endpoint URL, applying the injected self-hosting
 * override (composition resolves `firecrawl.baseUrl`) when set. A configured
 * base keeps an explicit `/v1` or `/v2` suffix and is otherwise defaulted to `/v2`.
 */
export function resolveFirecrawlUrl(endpoint: "/search" | "/scrape", baseUrl?: string): string {
	const configured = baseUrl?.trim();
	if (!configured) return `${FIRECRAWL_DEFAULT_BASE_URL}${endpoint}`;
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new Error("Invalid Firecrawl base URL: expected an HTTP or HTTPS URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Invalid Firecrawl base URL: expected an HTTP or HTTPS URL");
	}
	if (url.username || url.password) {
		throw new Error("Invalid Firecrawl base URL: URL credentials are not allowed");
	}
	url.search = "";
	url.hash = "";
	// Build the path in a local string: assigning "" to `URL.pathname` normalizes
	// straight back to "/", so a bare origin would otherwise yield "//v2/scrape".
	let basePath = url.pathname.replace(/\/+$/, "");
	if (!/\/v[12]$/i.test(basePath)) basePath += "/v2";
	url.pathname = basePath + endpoint;
	return url.toString();
}

export class FirecrawlApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "FirecrawlApiError";
		this.statusCode = statusCode;
	}
}

/** `/scrape` response, narrowed to the markdown format this client requests. */
interface FirecrawlScrapeResponse {
	success?: boolean;
	error?: string | null;
	data?: {
		markdown?: string | null;
	} | null;
}

export interface FirecrawlScrapeOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 受治出站通道;由调用方注入。 */
	fetch: WebSearchFetch;
	/** 自建端点覆盖 (`credentials.getConfig("firecrawl.baseUrl")`);未提供时用官方默认。 */
	baseUrl?: string;
}

function parseFirecrawlErrorResponse(statusCode: number, responseText: string): FirecrawlApiError {
	const trimmed = responseText.trim();
	if (trimmed.length === 0) {
		return new FirecrawlApiError(`Firecrawl API error (${statusCode})`, statusCode);
	}
	try {
		const payload = JSON.parse(trimmed) as { error?: unknown };
		const detail = typeof payload.error === "string" ? payload.error.trim() : "";
		return new FirecrawlApiError(`Firecrawl API error (${statusCode}): ${detail || trimmed}`, statusCode);
	} catch {
		return new FirecrawlApiError(`Firecrawl API error (${statusCode}): ${trimmed}`, statusCode);
	}
}

/**
 * Scrape a single URL through Firecrawl and return its markdown rendering, or
 * `null` when the response carries no markdown. Unlike the local renderers,
 * Firecrawl fetches the page itself, so it also reaches JS-gated pages that the
 * already-loaded HTML cannot render.
 */
export async function scrapeWithFirecrawl(
	url: string,
	options: FirecrawlScrapeOptions,
	credentials: WebSearchCredentialPort,
): Promise<string | null> {
	const body = { url, formats: ["markdown"] };

	const response = await withApiKey(
		credentials,
		"firecrawl",
		"Firecrawl credentials not found. Set FIRECRAWL_API_KEY.",
		apiKey =>
			fetchWithRetry(
				options.fetch,
				resolveFirecrawlUrl("/scrape", options.baseUrl),
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(body),
					signal: withHardTimeout(options.signal, options.timeoutMs),
				},
				// Firecrawl marks 408/429/5xx retryable. The reader chain gives each
				// remote backend a short slice of its budget before falling through to
				// the next renderer, so allow a single quick retry and let a longer
				// `Retry-After` hint return the response as-is instead of sleeping until
				// the signal aborts. The abort signal bounds both attempts and the
				// backoff sleep.
				{ maxAttempts: 2, maxDelayMs: RETRY_MAX_DELAY_MS },
			),
	);
	if (!response.ok) {
		throw parseFirecrawlErrorResponse(response.status, await response.text());
	}

	const payload = (await response.json()) as FirecrawlScrapeResponse;
	if (payload.success === false) {
		throw new FirecrawlApiError(payload.error?.trim() || "Firecrawl scrape failed");
	}
	return payload.data?.markdown ?? null;
}
