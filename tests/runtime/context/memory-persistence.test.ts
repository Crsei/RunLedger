import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { MemoryStore } from "../../../src/runtime/context/memory/store.ts";
import {
	InMemoryMemorySnapshotPersistence,
	MemoryStoreRepository,
	MemoryStoreSnapshotCodec,
} from "../../../src/runtime/context/memory/persistence.ts";

const workspaceId = createRuntimeId("workspace", "memory-persistence");

function sourceRef(text: string) {
	return {
		subjectKind: "content" as const,
		digest: runtimeDigest(text),
		mediaType: "text/plain",
		size: text.length,
	};
}

describe("MemoryStore snapshot persistence", () => {
	it("round-trips approved records and rejects content digest drift", () => {
		const store = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const proposed = store.propose({
			scope: "workspace",
			workspaceId,
			title: "Release rule",
			content: "release requires review",
			sourceKind: "user",
			sourceRef: sourceRef("source"),
			sourceDigest: runtimeDigest("source"),
		});
		if (!proposed.ok) throw new Error("proposal fixture failed");
		store.approve({ proposalId: proposed.value.proposal.proposalId, approvalRef: sourceRef("approval") });

		const encoded = MemoryStoreSnapshotCodec.encode(store.snapshot());
		const decoded = MemoryStoreSnapshotCodec.decode(encoded);
		expect(decoded).toMatchObject({ ok: true });
		if (!decoded.ok) return;
		const restored = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		expect(restored.restore(decoded.value)).toMatchObject({ ok: true });
		expect(restored.search({ scope: "workspace", workspaceId, query: "review" }).value.results).toHaveLength(1);

		const tampered = {
			...decoded.value,
			contents: decoded.value.contents.map((content) => ({ ...content, content: `${content.content}!` })),
		};
		expect(restored.restore(tampered)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
	});

	it("rejects an approved proposal whose record digest was tampered", () => {
		const store = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const proposed = store.propose({
			scope: "workspace",
			workspaceId,
			title: "Bound proposal",
			content: "proposal binding must survive restore",
			sourceKind: "user",
			sourceRef: sourceRef("source-bound"),
			sourceDigest: runtimeDigest("source-bound"),
		});
		if (!proposed.ok) throw new Error("proposal fixture failed");
		store.approve({ proposalId: proposed.value.proposal.proposalId, approvalRef: sourceRef("approval-bound") });
		const snapshot = store.snapshot();
		const tampered = {
			...snapshot,
			proposals: snapshot.proposals.map((proposal) =>
				proposal.proposalId === proposed.value.proposal.proposalId
					? { ...proposal, recordDigest: runtimeDigest("different-record") }
					: proposal,
			),
		};

		expect(new MemoryStore().restore(tampered)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
	});

	it("hydrates and flushes through an injected persistence port", async () => {
		const persistence = new InMemoryMemorySnapshotPersistence();
		const first = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const repository = new MemoryStoreRepository(first, persistence);
		const proposed = first.propose({
			scope: "workspace",
			workspaceId,
			title: "Persisted",
			content: "durable memory",
			sourceKind: "user",
			sourceRef: sourceRef("source-2"),
			sourceDigest: runtimeDigest("source-2"),
		});
		if (!proposed.ok) throw new Error("proposal fixture failed");
		first.approve({ proposalId: proposed.value.proposal.proposalId, approvalRef: sourceRef("approval-2") });
		expect(await repository.flush()).toMatchObject({ ok: true });

		const second = new MemoryStore({ clock: () => new Date("2026-08-04T00:00:00.000Z") });
		const hydrated = new MemoryStoreRepository(second, persistence);
		expect(await hydrated.hydrate()).toMatchObject({ ok: true });
		expect(second.search({ scope: "workspace", workspaceId, query: "durable" }).value.results).toHaveLength(1);
	});
});
