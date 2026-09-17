/**
 * Synthetic Web Search Provider
 *
 * Uses Synthetic's zero-data-retention web search API for coding agents.
 * Endpoint: POST https://api.synthetic.new/v2/search
 */

import { withApiKey, type WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import type { SearchResponse, SearchSource } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import { formatQuery, parseSearchQuery } from "../query.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, withHardTimeout } from "./utils.ts";

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";

interface SyntheticSearchResult {
	url: string;
	title: string;
	text?: string;
	published?: string;
}

interface SyntheticSearchResponse {
	results: SyntheticSearchResult[];
}

/** Call Synthetic search API. */
async function callSyntheticSearch(
	apiKey: string,
	query: string,
	signal?: AbortSignal,
	fetchImpl?: WebSearchFetch,
	timeoutMs?: number,
): Promise<SyntheticSearchResponse> {
	if (fetchImpl === undefined) throw new Error("synthetic: governed transport is not injected");
	const response = await fetchImpl(SYNTHETIC_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("synthetic", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"synthetic",
			`Synthetic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as SyntheticSearchResponse;
}

/** Execute Synthetic web search. */
export async function searchSynthetic(params: SearchParams): Promise<SearchResponse> {

	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives
		? formatQuery(parsed, { phrases: true, negation: true, site: true })
		: params.query;

	const data = await withApiKey(
		params.credentials,
		"synthetic",
		"Synthetic credentials not found. Set SYNTHETIC_API_KEY or login with 'omp /login synthetic'.",
		key => callSyntheticSearch(key, query, params.signal, params.fetch, params.timeoutMs),
	);
	const sources: SearchSource[] = [];

	for (const result of data.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.text ?? undefined,
			publishedDate: result.published ?? undefined,
		});
	}

	const numResults = params.numSearchResults ?? params.limit;
	const limitedSources = numResults ? sources.slice(0, numResults) : sources;

	return {
		provider: "synthetic",
		sources: limitedSources,
	};
}

/** Search provider for Synthetic. */
export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic";
	readonly label = "Synthetic";

	isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		return credentials.has("synthetic");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSynthetic(params);
	}
}
