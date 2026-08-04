import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { isMemorySearchReceipt } from "../../../src/runtime/context/memory/schema.ts";
import { MemoryStore } from "../../../src/runtime/context/memory/store.ts";

const workspaceA = createRuntimeId("workspace", "memory-a");
const workspaceB = createRuntimeId("workspace", "memory-b");
const sessionA = createRuntimeId("session", "memory-session");

function sourceRef(text: string) {
	return {
		subjectKind: "content" as const,
		digest: runtimeDigest(text),
		mediaType: "text/plain",
		size: text.length,
	};
}

describe("MemoryStore", () => {
	it("keeps proposals out of recall until an approval receipt publishes them", () => {
		const store = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const proposed = store.propose({
			scope: "workspace",
			workspaceId: workspaceA,
			title: "Release policy",
			content: "Release builds require the audit checklist.",
			sourceKind: "user",
			sourceRef: sourceRef("user source"),
			sourceDigest: runtimeDigest("user source"),
		});

		expect(proposed.ok).toBe(true);
		if (!proposed.ok) return;
		expect(proposed.value.record.trust).toBe("proposed");
		expect(store.search({ query: "audit", scope: "workspace", workspaceId: workspaceA }).value.results).toEqual([]);

		const approval = store.approve({
			proposalId: proposed.value.proposal.proposalId,
			approvalRef: sourceRef("approval receipt"),
		});
		expect(approval.ok).toBe(true);
		expect(store.search({ query: "audit", scope: "workspace", workspaceId: workspaceA }).value.results).toHaveLength(1);
	});

	it("enforces workspace scope, bounded lexical results, and stable receipts", () => {
		const store = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const first = store.propose({ scope: "workspace", workspaceId: workspaceA, title: "A", content: "alpha audit note", sourceKind: "user", sourceRef: sourceRef("a"), sourceDigest: runtimeDigest("a") });
		const second = store.propose({ scope: "workspace", workspaceId: workspaceB, title: "B", content: "alpha other workspace", sourceKind: "user", sourceRef: sourceRef("b"), sourceDigest: runtimeDigest("b") });
		if (!first.ok || !second.ok) throw new Error("fixture proposal failed");
		store.approve({ proposalId: first.value.proposal.proposalId, approvalRef: sourceRef("approval-a") });
		store.approve({ proposalId: second.value.proposal.proposalId, approvalRef: sourceRef("approval-b") });

		const result = store.search({ query: "alpha", scope: "workspace", workspaceId: workspaceA, maxResults: 1, maxSnippetChars: 5, maxTotalTokens: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.results).toHaveLength(1);
		expect(result.value.results[0]?.memoryId).toBe(first.value.record.memoryId);
		expect(result.value.results[0]?.snippet.length).toBeLessThanOrEqual(5);
		expect(isMemorySearchReceipt(result.value.receipt)).toBe(true);
		expect(store.search({ query: "alpha", scope: "workspace", workspaceId: workspaceB }).value.results[0]?.memoryId).toBe(second.value.record.memoryId);
	});

	it("stops injecting an approved record after content digest drift or revoke", () => {
		const store = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const proposed = store.propose({ scope: "session", sessionId: sessionA, title: "Task", content: "keep this task", sourceKind: "user", sourceRef: sourceRef("session"), sourceDigest: runtimeDigest("session") });
		if (!proposed.ok) throw new Error("fixture proposal failed");
		store.approve({ proposalId: proposed.value.proposal.proposalId, approvalRef: sourceRef("approval") });
		expect(store.markContentDigest(proposed.value.record.memoryId, runtimeDigest("changed"))).toMatchObject({ ok: true });
		expect(store.search({ query: "task", scope: "session", sessionId: sessionA }).value.results).toEqual([]);
		expect(store.revoke(proposed.value.record.memoryId)).toMatchObject({ ok: true });
	});
});
