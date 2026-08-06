import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { HostGenerationStore } from "../../../src/storage/host/host-generation-store.ts";

describe("HostGenerationStore", () => {
	it("allocates a durable monotonic generation after endpoint cleanup", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-host-generation-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const store = new HostGenerationStore(layout, `ws-${"a".repeat(64)}`);

			await expect(store.allocate()).resolves.toBe(1);
			await expect(store.allocate()).resolves.toBe(2);
			await expect(new HostGenerationStore(layout, `ws-${"a".repeat(64)}`).allocate()).resolves.toBe(3);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked Host state ancestor without allocating outside canonical home", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-generation-symlink-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(join(home, "state"), { recursive: true });
			await mkdir(outside, { recursive: true });
			await symlink(outside, join(home, "state", "hosts"), "dir");
			const workspaceStorageKey = `ws-${"b".repeat(64)}`;
			const store = new HostGenerationStore(buildRunledgerLayout(home, "posix"), workspaceStorageKey);

			await expect(store.allocate()).rejects.toThrow(/symlink|containment/iu);
			await expect(lstat(join(outside, workspaceStorageKey))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
