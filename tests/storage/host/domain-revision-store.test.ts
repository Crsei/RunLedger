import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { JsonHostDomainRevisionStore } from "../../../src/storage/host/domain-revision-store.ts";

const workspaceStorageKey = "ws-" + "d".repeat(64);

describe("durable Host domain revision store", () => {
	it("restores the exact per-session domain revisions after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-domain-revision-"));
		try {
			const store = new JsonHostDomainRevisionStore({ layout: buildRunledgerLayout(root, "posix"), workspaceStorageKey });
			const sessionId = "session_revision";
			await store.save(sessionId, new Map([["plan:session_revision", 3], ["mcp:session_revision", 7]]));

			const reloaded = new JsonHostDomainRevisionStore({ layout: buildRunledgerLayout(root, "posix"), workspaceStorageKey });
			expect(Object.fromEntries(await reloaded.load(sessionId))).toEqual({
				"plan:session_revision": 3,
				"mcp:session_revision": 7,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a malformed current-format snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-domain-revision-invalid-"));
		try {
			const layout = buildRunledgerLayout(root, "posix");
			const store = new JsonHostDomainRevisionStore({ layout, workspaceStorageKey });
			await store.save("session_invalid", new Map([["fixture:session_invalid", 1]]));
			const path = join(layout.state, "hosts", workspaceStorageKey, "domain-revisions", "session_invalid.json");
			await writeFile(path, JSON.stringify({ version: 0 }), "utf8");

			await expect(store.load("session_invalid")).rejects.toThrow("domain revision snapshot");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
