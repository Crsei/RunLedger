/**
 * Exa MCP Types
 *
 * Types for the Exa MCP client and tool implementations.
 */
/** Search result from Exa */
export interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	image?: string;
	favicon?: string;
}

/** Search response from Exa */
export interface ExaSearchResponse {
	results?: ExaSearchResult[];
	statuses?: Array<{ id: string; status: string; source?: string }>;
	costDollars?: { total: number };
	searchTime?: number;
	requestId?: string;
}
