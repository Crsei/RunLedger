/**
 * Firecrawl Web Search Provider
 *
 * Calls Firecrawl's search API and maps web results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { withApiKey, type WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import type { SearchResponse, SearchSource } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import { resolveFirecrawlUrl } from "../../firecrawl.ts";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery, type StructuredQuery } from "../query.ts";
import { clampNumResults } from "../utils.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, withHardTimeout } from "./utils.ts";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

const RECENCY_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

export interface FirecrawlSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	/** Explicit `tbs` (custom date range); takes precedence over `recency`. */
	tbs?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 受治出站通道;由 provider 的 search() 注入。 */
	fetch: WebSearchFetch;
}

interface FirecrawlWebResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	snippet?: string | null;
	markdown?: string | null;
}

interface FirecrawlSearchResponse {
	success?: boolean;
	error?: string | null;
	id?: string | null;
	data?:
		| FirecrawlWebResult[]
		| {
				web?: FirecrawlWebResult[] | null;
				news?: FirecrawlWebResult[] | null;
				images?: FirecrawlWebResult[] | null;
		  }
		| null;
	results?: FirecrawlWebResult[] | null;
}

function buildRequestBody(params: FirecrawlSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		limit: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		sources: [{ type: "web" }],
	};
	const tbs = params.tbs ?? (params.recency ? RECENCY_TBS[params.recency] : undefined);
	if (tbs) {
		body.tbs = tbs;
	}
	return body;
}

async function callFirecrawlSearch(
	apiKey: string | undefined,
	params: FirecrawlSearchParams,
	baseUrl?: string,
): Promise<FirecrawlSearchResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await params.fetch(resolveFirecrawlUrl("/search", baseUrl), {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("firecrawl", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"firecrawl",
			`Firecrawl API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as FirecrawlSearchResponse;
	if (data.success === false) {
		throw new SearchProviderError("firecrawl", data.error?.trim() || "Firecrawl request failed");
	}
	return data;
}

/** ISO `YYYY-MM-DD` to Google `MM/DD/YYYY` for `tbs=cdr` custom date ranges. */
function toGoogleDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	return `${month}/${day}/${year}`;
}

/**
 * Map explicit `before:`/`after:` bounds to a Firecrawl `tbs` custom date
 * range (`cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY`), or undefined when the
 * query carries no absolute date bounds.
 */
function buildDateTbs(parsed: StructuredQuery): string | undefined {
	if (!parsed.after && !parsed.before) return undefined;
	const parts = ["cdr:1"];
	if (parsed.after) parts.push(`cd_min:${toGoogleDate(parsed.after)}`);
	if (parsed.before) parts.push(`cd_max:${toGoogleDate(parsed.before)}`);
	return parts.join(",");
}

function getWebResults(data: FirecrawlSearchResponse): FirecrawlWebResult[] {
	if (Array.isArray(data.data)) return data.data;
	if (data.data && Array.isArray(data.data.web)) return data.data.web;
	return data.results ?? [];
}
/** Execute Firecrawl web search. */
export async function searchFirecrawl(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	let query = params.query;
	let tbs: string | undefined;
	if (parsed.hasDirectives) {
		// Firecrawl search is SERP-backed: the query supports Google operators
		// (site:, inurl:, intitle:, quotes, -, OR). Absolute date bounds move to
		// the native tbs param and are stripped from the query string.
		tbs = buildDateTbs(parsed);
		query = formatQuery(parsed, tbs ? { ...GOOGLE_QUERY_SYNTAX, dateRange: false } : GOOGLE_QUERY_SYNTAX);
	}
	const firecrawlParams: FirecrawlSearchParams = {
		query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		tbs,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	// Firecrawl 的自建端点覆盖来自 composition 注入的部署配置;未配置时用官方默认。
	const baseUrl = await params.credentials.getConfig("firecrawl.baseUrl");
	const configuredAuth = await params.credentials.has("firecrawl");
	const numResults = clampNumResults(firecrawlParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	// Keyless mode — omit the Authorization header when no credential is configured.
	const data = configuredAuth
		? await withApiKey(
				params.credentials,
				"firecrawl",
				"Firecrawl credentials not found. Set FIRECRAWL_API_KEY.",
				key => callFirecrawlSearch(key, firecrawlParams, baseUrl),
			)
		: await callFirecrawlSearch(undefined, firecrawlParams, baseUrl);

	const sources: SearchSource[] = [];

	for (const result of getWebResults(data)) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.description ?? result.snippet ?? result.markdown ?? undefined,
		});
	}

	return {
		provider: "firecrawl",
		sources: sources.slice(0, numResults),
		requestId: data.id ?? undefined,
		authMode: configuredAuth ? "api_key" : "keyless",
	};
}

/** Search provider for Firecrawl web search. */
export class FirecrawlProvider extends SearchProvider {
	readonly id = "firecrawl";
	readonly label = "Firecrawl";

	/**
	 * Auto-chain admission requires either a credential or an explicitly
	 * configured self-hosted endpoint. Hosted keyless mode remains explicit-only
	 * so it does not displace providers the user configured.
	 */
	async isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		const configuredBaseUrl = await credentials.getConfig("firecrawl.baseUrl");
		return !!configuredBaseUrl?.trim() || credentials.has("firecrawl");
	}

	/**
	 * Firecrawl supports keyless mode, so an explicit user selection
	 * (`webSearch: firecrawl`) works without any credential configured.
	 */
	override isExplicitlyAvailable(_credentials: WebSearchCredentialPort): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl(params);
	}
}
