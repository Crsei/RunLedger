/**
 * Kagi Web Search Provider
 *
 * Thin wrapper that adapts shared Kagi API utilities to SearchResponse shape.
 */
import { type WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import type { SearchResponse } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import { KagiApiError, searchWithKagi } from "../../kagi.ts";
import type { StructuredQuery } from "../query.ts";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query.ts";
import { clampNumResults } from "../utils.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, toSearchSources } from "./utils.ts";

type SearchParamsWithFetch = SearchParams & { fetch?: WebSearchFetch };

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** Execute Kagi web search. */
export async function searchKagi(params: {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	parsedQuery?: StructuredQuery;
	signal?: AbortSignal;
	timeoutMs?: number;
	credentials: WebSearchCredentialPort;
	fetch: WebSearchFetch;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	// Kagi's index understands the classic Google operator set: canonicalize
	// directives (domain: -> site:, until: -> before:YYYY-MM-DD, ...) and pass
	// them through in the query string. Directive-free queries stay untouched.
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;

	try {
		const result = await searchWithKagi(query, {
			limit: numResults,
			recency: params.recency,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
			credentials: params.credentials,
		});

		return {
			provider: "kagi",
			sources: toSearchSources(result.sources, numResults),
			relatedQuestions: result.relatedQuestions.length > 0 ? result.relatedQuestions : undefined,
			requestId: result.requestId,
			answer: result.answer,
		};
	} catch (err) {
		if (err instanceof KagiApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("kagi", err.statusCode, err.message);
				if (classified) throw classified;
			}
			throw new SearchProviderError("kagi", err.message, err.statusCode);
		}
		throw err;
	}
}

/** Search provider for Kagi web search. */
export class KagiProvider extends SearchProvider {
	readonly id = "kagi";
	readonly label = "Kagi";

	isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		return credentials.has("kagi");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchKagi({
			query: params.query,
			parsedQuery: params.parsedQuery,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			credentials: params.credentials,
			fetch: params.fetch,
		});
	}
}
