import { type WebSearchCredentialPort, withApiKey } from "../../credentials.ts";
import type { WebSearchFetch } from "../../transport.ts";
import { isRecord, USER_AGENT } from "../../internal/platform.ts";
import { callMCP } from "../../internal/mcp-rpc.ts";
import type { SearchResponse } from "../types.ts";
import { SearchProviderError } from "../types.ts";
import {
	PARALLEL_BETA_HEADER,
	PARALLEL_SEARCH_URL,
	ParallelApiError,
	type ParallelSearchResult,
	parseParallelErrorResponse,
	parseParallelJsonResponse,
	parseParallelSearchPayload,
} from "../../parallel.ts";
import { formatQuery, parseSearchQuery, type StructuredQuery } from "../query.ts";
import { clampNumResults } from "../utils.ts";
import type { SearchParams } from "./base.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils.ts";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

/** Query-string caps for Parallel: natural-language objective, no field operators. */
const PARALLEL_QUERY_SYNTAX = { phrases: true, negation: true, or: true } as const;
/** Public MCP accepts search operators in search_queries instead of REST source_policy. */
const PARALLEL_MCP_QUERY_SYNTAX = { ...PARALLEL_QUERY_SYNTAX, site: true, dateRange: true } as const;

/** Parallel `source_policy` (beta Search API): bare-host allow/deny lists + freshness floor. */
interface ParallelSourcePolicy {
	include_domains?: string[];
	exclude_domains?: string[];
	after_date?: string;
}

interface ParallelMcpToolResult {
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** Narrow an MCP `tools/call` result to the fields the keyless search path reads. */
function toMcpToolResult(result: unknown): ParallelMcpToolResult | undefined {
	if (!isRecord(result)) return undefined;
	const content = Array.isArray(result.content)
		? result.content.filter(
				(item): item is { type: string; text?: string } => isRecord(item) && typeof item.type === "string",
			)
		: undefined;
	return { structuredContent: result.structuredContent, content, isError: result.isError === true };
}

const RECENCY_DAYS: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** Site values may carry paths (`github.com/anthropics`); Parallel takes bare hosts. */
function toHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Map parsed `site:`/`-site:`/`after:` directives and the relative recency
 * option onto Parallel's `source_policy`. An explicit `after:` bound wins.
 * Per Parallel docs, `exclude_domains` is ignored when `include_domains` is
 * set, so exclusions are only sent without an allow list (the central lenient
 * filter enforces them regardless).
 */
function toSourcePolicy(parsed: StructuredQuery, recency?: SearchParams["recency"]): ParallelSourcePolicy | undefined {
	const policy: ParallelSourcePolicy = {};
	const include = toHosts(parsed.sites);
	const exclude = toHosts(parsed.excludedSites);
	if (include.length) policy.include_domains = include;
	else if (exclude.length) policy.exclude_domains = exclude;
	if (parsed.after) policy.after_date = parsed.after;
	else if (recency) {
		policy.after_date = new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
	}
	return policy.include_domains || policy.exclude_domains || policy.after_date ? policy : undefined;
}

async function searchWithPublicMcp(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch: WebSearchFetch;
	},
): Promise<ParallelSearchResult> {
	const mcpResponse = await callMCP(
		PARALLEL_MCP_URL,
		"tools/call",
		{
			name: "web_search",
			arguments: {
				objective,
				search_queries: queries,
			},
		},
		{
			fetch: params.fetch,
			headers: { "User-Agent": USER_AGENT },
			signal: withHardTimeout(params.signal, params.timeoutMs),
			onHttpError(response, errorText) {
				const classified = classifyProviderHttpError("parallel", response.status, errorText);
				if (classified) return classified;
				if (response.status === 429) {
					return new SearchProviderError(
						"parallel",
						"parallel: MCP rate limit reached (429); configure a Parallel API key for higher limits",
						response.status,
					);
				}
				return new SearchProviderError(
					"parallel",
					`Parallel MCP request failed (${response.status}): ${errorText}`,
					response.status,
				);
			},
			onParseError: () => new SearchProviderError("parallel", "Failed to parse Parallel MCP response"),
		},
	);

	if (mcpResponse.error) {
		throw new SearchProviderError("parallel", `Parallel MCP error: ${mcpResponse.error.message}`);
	}
	const result = toMcpToolResult(mcpResponse.result);
	if (result?.isError) {
		const message = result.content?.find(item => item.type === "text" && typeof item.text === "string")?.text?.trim();
		throw new SearchProviderError("parallel", message || "Parallel MCP returned an error");
	}
	if (result?.structuredContent !== undefined) {
		return parseParallelSearchPayload(result.structuredContent, { parseMetadata: false });
	}
	for (const item of result?.content ?? []) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		let payload: unknown;
		try {
			payload = JSON.parse(item.text);
		} catch {
			continue;
		}
		return parseParallelSearchPayload(payload, { parseMetadata: false });
	}

	if (result) {
		return parseParallelSearchPayload({ results: [] }, { parseMetadata: false });
	}

	throw new SearchProviderError("parallel", "Parallel MCP search returned an unexpected response shape.");
}

async function searchWithCredentials(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch: WebSearchFetch;
		mcpQuery: string;
	},
	credentials: WebSearchCredentialPort,
	sourcePolicy?: ParallelSourcePolicy,
): Promise<ParallelSearchResult> {
	// A provider without a configured credential falls back to the public MCP;
	// a configured-but-unresolvable credential must not admit anonymous search.
	if (!(await credentials.has("parallel"))) {
		return searchWithPublicMcp(objective, [params.mcpQuery], params);
	}

	// The `ParallelApiError` thrown below carries a `statusCode`, which callers
	// read to detect a retryable 401 / usage-limit.
	return withApiKey(
		credentials,
		"parallel",
		"Parallel credentials could not be resolved. Check your configured API key or credential helper.",
		async key => {
			const response = await params.fetch(PARALLEL_SEARCH_URL, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"x-api-key": key,
					"parallel-beta": PARALLEL_BETA_HEADER,
				},
				body: JSON.stringify({
					objective,
					search_queries: queries,
					mode: "fast",
					excerpts: {
						max_chars_per_result: 10_000,
					},
					...(sourcePolicy && { source_policy: sourcePolicy }),
				}),
				signal: withHardTimeout(params.signal, params.timeoutMs),
			});

			if (!response.ok) {
				throw parseParallelErrorResponse(response.status, await response.text());
			}

			const payload = await parseParallelJsonResponse(response, "search");
			return parseParallelSearchPayload(payload, { parseMetadata: false });
		},
	);
}

export async function searchParallel(
	params: {
		query: string;
		num_results?: number;
		recency?: SearchParams["recency"];
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch: WebSearchFetch;
		parsedQuery?: StructuredQuery;
	},
	credentials: WebSearchCredentialPort,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	// Directives are removed only where Parallel has a native equivalent.
	const query = parsed.hasDirectives ? formatQuery(parsed, PARALLEL_QUERY_SYNTAX) : params.query;
	const sourcePolicy = toSourcePolicy(parsed, params.recency);
	const rawMcpQuery = parsed.hasDirectives ? formatQuery(parsed, PARALLEL_MCP_QUERY_SYNTAX) : params.query;
	const mcpQuery =
		!parsed.after && sourcePolicy?.after_date ? `${rawMcpQuery} after:${sourcePolicy.after_date}` : rawMcpQuery;

	try {
		const result = await searchWithCredentials(
			query,
			[query],
			{
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
				mcpQuery,
			},
			credentials,
			sourcePolicy,
		);

		return {
			provider: "parallel",
			sources: toSearchSources(result.sources, numResults),
			requestId: result.requestId,
		};
	} catch (err) {
		if (err instanceof ParallelApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("parallel", err.statusCode, err.message);
				if (classified) throw classified;
			}
			throw new SearchProviderError("parallel", err.message, err.statusCode);
		}
		throw err;
	}
}

export class ParallelProvider extends SearchProvider {
	readonly id = "parallel";
	readonly label = "Parallel";

	isAvailable(credentials: WebSearchCredentialPort): Promise<boolean> {
		return credentials.has("parallel");
	}

	override isExplicitlyAvailable(_credentials: WebSearchCredentialPort): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchParallel(
			{
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				recency: params.recency,
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
				parsedQuery: params.parsedQuery,
			},
			params.credentials,
		);
	}
}
