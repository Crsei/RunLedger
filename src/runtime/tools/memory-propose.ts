import { Type } from "typebox";
import type { AgentTool } from "../types.ts";
import type { TraceId } from "../protocol/v3/ids.ts";
import type { MemoryScope, MemoryScopeRef, MemorySourceRef } from "../context/memory/types.ts";
import type { MemoryService } from "../context/memory/service.ts";

const MemoryProposeParameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 256 }),
	content: Type.String({ minLength: 1, maxLength: 65_536 }),
	scope: Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("session")]),
	expiresAt: Type.Optional(Type.String({ maxLength: 24 })),
}, { additionalProperties: false });

export function createMemoryProposeTool(binding: {
	service: MemoryService;
	resolveScope: (scope: MemoryScope) => MemoryScopeRef;
	sourceRefs: () => readonly MemorySourceRef[];
	traceId: () => TraceId;
}): AgentTool<typeof MemoryProposeParameters> {
	return {
		name: "memory_propose",
		label: "Propose memory",
		description: "Create a reviewable memory proposal. This tool never publishes memory automatically.",
		parameters: MemoryProposeParameters,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		isDestructive: () => false,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			if (signal?.aborted) throw new Error("memory proposal aborted");
			const result = await binding.service.propose({
				title: params.title,
				content: params.content,
				scope: binding.resolveScope(params.scope),
				sourceRefs: binding.sourceRefs(),
				traceId: binding.traceId(),
				expiresAt: params.expiresAt,
			});
			return {
				content: [{ type: "text", text: `memory proposal ${result.proposal.proposalId} is pending human approval` }],
				details: { proposal: result.proposal },
			};
		},
	};
}
