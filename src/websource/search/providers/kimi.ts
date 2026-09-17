/**
 * Kimi Web Search Provider
 *
 * Uses the Kimi Code search API to retrieve web results. This is the Kimi Code
 * membership service, distinct from the Moonshot Open Platform — it requires a
 * Kimi Code Console credential (`omp /login kimi-code` or an explicit
 * `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`), not `MOONSHOT_API_KEY`.
 * Endpoint: POST https://api.kimi.com/coding/v1/search
 */
import { withApiKey, type WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import type { WebSearchSettings } from "../../settings.ts";

import type { SearchResponse, SearchSource } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query.ts";
import { clampNumResults, dateToAgeSeconds } from "../utils.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, withHardTimeout } from "./utils.ts";

const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Kimi Code search is Bing-flavored: re-emit the operators Bing parses; dates/lang stay with the central filter. */
const KIMI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	site: true,
	inTitle: true,
	inUrl: true,
	filetype: true,
};

export interface KimiSearchParams {
	query: string;
	parsedQuery?: StructuredQuery;
	num_results?: number;
	include_content?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	credentials: WebSearchCredentialPort;
	fetch: WebSearchFetch;
	settings?: WebSearchSettings;
}

interface KimiSearchResult {
	site_name?: string;
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	date?: string;
	icon?: string;
	mime?: string;
}

interface KimiSearchResponse {
	search_results?: KimiSearchResult[];
}

function asTrimmed(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBaseUrl(override?: string): string {
	return asTrimmed(override) ?? KIMI_SEARCH_URL;
}

async function callKimiSearch(
	apiKey: string,
	params: {
		query: string;
		limit: number;
		includeContent: boolean;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch: WebSearchFetch;
		baseUrl?: string;
	},
): Promise<{ response: KimiSearchResponse; requestId?: string }> {
	const response = await params.fetch(resolveBaseUrl(params.baseUrl), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			text_query: params.query,
			limit: params.limit,
			enable_page_crawling: params.includeContent,
			timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("kimi", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"kimi",
			`Kimi search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as KimiSearchResponse;
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-msh-request-id") ?? undefined;
	return { response: data, requestId };
}

/** Execute Kimi web search. */
export async function searchKimi(params: KimiSearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, KIMI_QUERY_SYNTAX) : params.query;
	const limit = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { response, requestId } = await withApiKey(
		params.credentials,
		"kimi-code",
		"Kimi search credentials not found. Kimi web search uses the Kimi Code service (api.kimi.com); set MOONSHOT_SEARCH_API_KEY / KIMI_SEARCH_API_KEY to a Kimi Code Console key, or configure a stored kimi-code credential. A Moonshot Open Platform key (MOONSHOT_API_KEY) is not accepted here.",
		key =>
			callKimiSearch(key, {
				query,
				limit,
				includeContent: params.include_content ?? false,
				...(params.signal === undefined ? {} : { signal: params.signal }),
				...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
				fetch: params.fetch,
				...(params.settings?.kimi?.baseUrl === undefined ? {} : { baseUrl: params.settings.kimi?.baseUrl }),
			}),
	);
	const sources: SearchSource[] = [];

	for (const result of response.search_results ?? []) {
		if (!result.url) continue;
		const publishedDate = asTrimmed(result.date);
		const snippet = asTrimmed(result.snippet) ?? asTrimmed(result.content);
		sources.push({
			title: asTrimmed(result.title) ?? result.url,
			url: result.url,
			snippet,
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asTrimmed(result.site_name),
		});
	}

	return {
		provider: "kimi",
		sources: sources.slice(0, limit),
		requestId,
	};
}

/** Search provider for Kimi web search. */
export class KimiProvider extends SearchProvider {
	readonly id = "kimi";
	readonly label = "Kimi";

	isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		return credentials.has("kimi-code");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const fetchImpl = params.fetch;

		return searchKimi({
			query: params.query,
			parsedQuery: params.parsedQuery,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			credentials: params.credentials,
			fetch: fetchImpl,
			...(params.settings === undefined ? {} : { settings: params.settings }),
		});
	}
}
