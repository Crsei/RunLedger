import { Type } from "typebox";
import type { AgentTool } from "../types.ts";
import { parseRuntimeId } from "../protocol/v3/ids.ts";
import type { MemoryScopeRef } from "../context/memory/types.ts";
import type { MemoryStore } from "../../storage/memory-store.ts";

const MemoryGetParameters = Type.Object({
	memoryId: Type.String({ pattern: "^memory_[A-Za-z0-9][A-Za-z0-9._~-]*$", maxLength: 128 }),
}, { additionalProperties: false });

export function createMemoryGetTool(binding: {
	store: MemoryStore;
	scopes: readonly MemoryScopeRef[];
	clock?: () => Date;
}): AgentTool<typeof MemoryGetParameters> {
	return {
		name: "memory_get",
		label: "Read approved memory",
		description: "Read one exact approved memory record from an authorized scope.",
		parameters: MemoryGetParameters,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		isDestructive: () => false,
		executionMode: "parallel",
			execute: async (_toolCallId, params, signal) => {
			if (signal?.aborted) throw new Error("memory get aborted");
			const memoryId = parseRuntimeId("memory", params.memoryId);
			if (memoryId === undefined) throw new Error("invalid memory ID");
			for (const scope of binding.scopes) {
				try {
					const record = await binding.store.readRecord(scope, memoryId);
					const now = (binding.clock ?? (() => new Date()))().getTime();
					if (record.status !== "approved" || (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now)) {
						throw new Error("memory record is not approved and current");
					}
					return { content: [{ type: "text", text: `# ${record.title}\n\n${record.content}` }], details: { record } };
				} catch {
					continue;
				}
			}
			throw new Error("approved memory record not found in authorized scopes");
		},
	};
}
