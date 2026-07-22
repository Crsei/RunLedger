import { Type } from "typebox";
import type { AgentTool } from "../types.ts";
import type { TraceId } from "../protocol/v3/ids.ts";
import type { MemoryScopeRef } from "../context/memory/types.ts";
import type { MemoryService } from "../context/memory/service.ts";

const MemorySearchParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 4_096 }),
	cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false });

export function createMemorySearchTool(binding: {
	service: MemoryService;
	scopes: readonly MemoryScopeRef[];
	traceId: () => TraceId;
}): AgentTool<typeof MemorySearchParameters> {
	return {
		name: "memory_search",
		label: "Search approved memory",
		description: "Search only approved, in-scope, non-revoked canonical memory with bounded results.",
		parameters: MemorySearchParameters,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		isDestructive: () => false,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal) => {
			if (signal?.aborted) throw new Error("memory search aborted");
			const result = await binding.service.search({ query: params.query, scopes: binding.scopes, traceId: binding.traceId(), cursor: params.cursor });
			return {
				content: [{ type: "text", text: JSON.stringify({ results: result.receipt.results, nextCursor: result.receipt.nextCursor, diagnostics: result.receipt.diagnostics }) }],
				details: result.receipt,
			};
		},
	};
}
