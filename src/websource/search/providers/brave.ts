/**
 * Brave Web Search Provider
 *
 * Calls Brave's web search REST API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { withApiKey, type WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import type { SearchResponse, SearchSource } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import type { QuerySyntax, StructuredQuery } from "../query.ts";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query.ts";
import { clampNumResults, dateToAgeSeconds } from "../utils.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, readLimitedText, withHardTimeout } from "./utils.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_QUERY_CHARACTERS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", "pd" | "pw" | "pm" | "py"> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/**
 * Brave parses the classic operator set inline (site:, quotes, -, OR…) but
 * date bounds map onto the native `freshness` param, so `before:`/`after:`
 * tokens are stripped from the rebuilt query string.
 */
const BRAVE_QUERY_SYNTAX: QuerySyntax = { ...GOOGLE_QUERY_SYNTAX, dateRange: false };

/**
 * Freshness param: explicit `after:`/`before:` bounds win over the
 * recency-derived period, rendered as Brave's absolute range
 * `YYYY-MM-DDtoYYYY-MM-DD` with sensible open ends.
 */
function braveFreshness(parsed: StructuredQuery, recency?: keyof typeof RECENCY_MAP): string | undefined {
	if (parsed.after || parsed.before) {
		const start = parsed.after ?? "1970-01-01";
		const end = parsed.before ?? new Date().toISOString().slice(0, 10);
		return `${start}to${end}`;
	}
	return recency ? RECENCY_MAP[recency] : undefined;
}

export interface BraveSearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	parsedQuery?: StructuredQuery;
	/** Two-letter market code, or `ALL`. */
	country?: string;
	/** Brave search language code, such as `en` or `zh-hans`. */
	search_lang?: string;
	safesearch?: "off" | "moderate" | "strict";
	/** 凭据唯一来源;由 provider 的 search() 注入。 */
	credentials: WebSearchCredentialPort;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 受治出站通道;由 provider 的 search() 注入。 */
	fetch: WebSearchFetch;
}

interface BraveSearchResponse {
	web?: unknown;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return undefined;
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function webResults(response: BraveSearchResponse): readonly unknown[] {
	if (typeof response.web !== "object" || response.web === null || !("results" in response.web)) return [];
	return Array.isArray(response.web.results) ? response.web.results : [];
}

function buildSnippet(result: object): string | undefined {
	const snippets = new Set<string>();
	const description = normalizeText("description" in result ? result.description : undefined, 8_000);
	if (description) snippets.add(description);

	const extras = "extra_snippets" in result ? result.extra_snippets : undefined;
	if (Array.isArray(extras)) {
		for (const value of extras) {
			const snippet = normalizeText(value, 8_000);
			if (snippet) snippets.add(snippet);
		}
	}

	const combined = [...snippets].join("\n");
	return combined ? (combined.length <= 8_000 ? combined : `${combined.slice(0, 7_999)}…`) : undefined;
}

async function callBraveSearch(
	apiKey: string,
	params: BraveSearchParams,
): Promise<{ response: BraveSearchResponse; requestId?: string }> {
	const numResults = Math.floor(clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, BRAVE_QUERY_SYNTAX) : params.query;
	if (query.length > MAX_QUERY_CHARACTERS) {
		throw new SearchProviderError(
			"brave",
			`Brave search queries cannot exceed ${MAX_QUERY_CHARACTERS} characters`,
			400,
		);
	}
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(numResults));
	url.searchParams.set("extra_snippets", "true");
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("safesearch", params.safesearch ?? "moderate");
	if (params.country) url.searchParams.set("country", params.country.toUpperCase());
	if (params.search_lang) url.searchParams.set("search_lang", params.search_lang);
	const freshness = braveFreshness(parsed, params.recency);
	if (freshness) url.searchParams.set("freshness", freshness);

	const fetchImpl = params.fetch;
	const response = await fetchImpl(url.toString(), {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "brave", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("brave", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("brave", `Brave API error (${response.status}): ${errorText}`, response.status);
	}

	const raw = await readLimitedText(response, "brave", MAX_RESPONSE_BYTES);
	let data: BraveSearchResponse;
	try {
		data = JSON.parse(raw) as BraveSearchResponse;
	} catch {
		throw new SearchProviderError("brave", "Brave API returned invalid JSON", 500);
	}
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
	return { response: data, requestId };
}

/** Execute Brave web search. */
export async function searchBrave(params: BraveSearchParams): Promise<SearchResponse> {
	const numResults = Math.floor(clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS));
	const { response, requestId } = await withApiKey(
		params.credentials,
		"brave",
		'Brave credentials not found. Set BRAVE_API_KEY or configure an API key for provider "brave".',
		key => callBraveSearch(key, params),
	);
	const sources: SearchSource[] = [];

	for (const result of webResults(response)) {
		if (typeof result !== "object" || result === null) continue;
		const url = normalizeUrl("url" in result ? result.url : undefined);
		if (!url) continue;
		const publishedDate = normalizeText("age" in result ? result.age : undefined, 100);
		sources.push({
			title: normalizeText("title" in result ? result.title : undefined, 300) ?? url,
			url,
			snippet: buildSnippet(result),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "brave",
		sources: sources.slice(0, numResults),
		requestId,
		authMode: "api_key",
	};
}

/** Search provider for Brave web search. */
export class BraveProvider extends SearchProvider {
	readonly id = "brave";
	readonly label = "Brave";

	isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		return credentials.has("brave");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBrave({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			parsedQuery: params.parsedQuery,
			credentials: params.credentials,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
		});
	}
}
