import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAN_ASSERT_FILE_MODE, canCreateSymlink } from "../../helpers/platform.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { NodeExtensionStorage } from "../../../src/storage/extensions/extension-storage.ts";

const CAN_SYMLINK = canCreateSymlink();

describe("canonical ExtensionStorage", () => {
	it("writes only below the injected runledgerHome with bounded atomic files", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-storage-"));
		const home = join(root, "home");
		const outside = join(root, "outside.json");
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const storage = new NodeExtensionStorage({ runledgerHome: layout.home });
			const target = join(layout.state, "extensions", "extensions-state.json");
			const written = await storage.writeFileAtomic(target, new TextEncoder().encode("{\"revision\":0}\n"), { fileMode: 0o600, directoryMode: 0o700 });
			expect(written).toEqual({ ok: true, value: undefined });
			expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ revision: 0 });
			if (CAN_ASSERT_FILE_MODE) expect((await stat(target)).mode & 0o777).toBe(0o600);
			if (CAN_ASSERT_FILE_MODE) expect((await stat(join(layout.state, "extensions"))).mode & 0o777).toBe(0o700);

			const denied = await storage.writeFileAtomic(outside, new TextEncoder().encode("no"), { fileMode: 0o600, directoryMode: 0o700 });
			expect(denied).toMatchObject({ ok: false, code: "denied" });
			await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports oversize and refuses a symlinked canonical parent", { skip: !CAN_SYMLINK }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-storage-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(outside, { recursive: true });
			const storage = new NodeExtensionStorage({ runledgerHome: home });
			expect(await storage.readFile(join(home, "missing.json"), 1)).toMatchObject({ ok: false, code: "missing" });
			const oversizePath = join(home, "oversize.txt");
			await mkdir(home, { recursive: true });
			await writeFile(oversizePath, "too large");
			expect(await storage.readFile(oversizePath, 2)).toMatchObject({ ok: false, code: "oversize" });
			const linked = join(home, "linked");
			await symlink(outside, linked);
			expect(await storage.writeFileAtomic(join(linked, "state.json"), new Uint8Array([1]), { fileMode: 0o600, directoryMode: 0o700 })).toMatchObject({ ok: false, code: "denied" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
