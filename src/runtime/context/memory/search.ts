import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, type AuthorityId, type PrincipalId, type TenantId } from "../../protocol/v3/ids.ts";
import type { MemoryScopeRef, MemorySearchRequest } from "./types.ts";

export function createMemorySearchRequest(input: {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	query: string;
	scopes: readonly MemoryScopeRef[];
	maxResults?: number;
	maxSnippetChars?: number;
	maxTotalTokens?: number;
	cursor?: string;
	includeStale?: boolean;
}): MemorySearchRequest {
	const query = input.query.trim().slice(0, 4_096);
	if (query.length === 0) throw new Error("memory search query must not be empty");
	const queryDigest = canonicalDigest(query);
	return {
		schemaVersion: 1,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		principalId: input.principalId,
		requestId: createRuntimeId("command", `memory-search-${queryDigest.slice(0, 40)}`),
		query,
		queryDigest,
		scopes: input.scopes,
		maxResults: Math.max(1, Math.min(100, Math.trunc(input.maxResults ?? 10))),
		maxSnippetChars: Math.max(1, Math.min(4_096, Math.trunc(input.maxSnippetChars ?? 800))),
		maxTotalTokens: Math.max(1, Math.min(32_768, Math.trunc(input.maxTotalTokens ?? 4_096))),
		...(input.cursor === undefined ? {} : { cursor: input.cursor.slice(0, 512) }),
		includeStale: input.includeStale ?? false,
	};
}
