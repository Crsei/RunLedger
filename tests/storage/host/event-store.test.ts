import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { JsonlHostEventStore } from "../../../src/storage/host/event-store.ts";

describe("production Host durable subscription event store", () => {
	it("replays persisted events after the store is reconstructed", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-events-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "e".repeat(64) };
			const first = new JsonlHostEventStore(options);
			await first.append("session_events", { type: "agent_start", timestamp: 1 });
			await first.append("session_events", { type: "agent_end", timestamp: 2 });

			const reloaded = new JsonlHostEventStore(options);
			expect(await reloaded.head("session_events")).toBe(2);
			expect(await reloaded.readAfter("session_events", 0)).toMatchObject({
				ok: true,
				head: 2,
				events: [
					{ sequence: 1, eventType: "agent_start" },
					{ sequence: 2, eventType: "agent_end" },
				],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns typed resync when replay exceeds a caller bound", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-events-bound-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new JsonlHostEventStore({ layout, workspaceStorageKey: "ws-" + "f".repeat(64) });
			await store.append("session_events", { type: "agent_start", timestamp: 1 });
			await store.append("session_events", { type: "agent_end", timestamp: 2 });
			expect(await store.readAfter("session_events", 0, { maxItems: 1, maxBytes: 4096 })).toEqual({
				ok: false,
				code: "resync_required",
				safeCursor: 2,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
