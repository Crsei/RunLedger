import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import {
	acquireHostWriterLease,
	isHostWriterLeaseActive,
} from "../../../src/storage/host/writer-lease.ts";

describe("R3 Host writer lease", () => {
	it("keeps the workspace writer fence active until the Host releases it", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-writer-lease-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const workspaceStorageKey = "ws-" + "a".repeat(64);
			const first = await acquireHostWriterLease(layout, workspaceStorageKey);
			expect(first.ok).toBe(true);
			expect(await isHostWriterLeaseActive(layout, workspaceStorageKey)).toBe(true);
			const second = await acquireHostWriterLease(layout, workspaceStorageKey);
			expect(second).toEqual({ ok: false, code: "host_writer_lease_lost" });
			if (first.ok) await first.release();
			expect(await isHostWriterLeaseActive(layout, workspaceStorageKey)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
