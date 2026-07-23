import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecuritySnapshot } from "../../src/security/types.ts";
import { NodePolicyExtensionStorage } from "../../src/storage/extension-node-storage.ts";

const temporaryRoots: string[] = [];
const IS_WINDOWS = process.platform === "win32";

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-extension-storage-${label}-`));
	temporaryRoots.push(path);
	return path;
}

function snapshot(
	root: string,
	overrides: Partial<SecuritySnapshot["filesystem"]> = {},
): SecuritySnapshot {
	return Object.freeze({
		profile: Object.freeze({
			name: "workspace-write" as const,
			approvalPolicy: "never" as const,
			filesystemMode: "workspace-write" as const,
			network: Object.freeze({ mode: "deny" as const, allowedHosts: Object.freeze([]) }),
			sandbox: "workspace-write" as const,
		}),
		filesystem: Object.freeze({
			readRoots: Object.freeze(overrides.readRoots ?? [root]),
			writeRoots: Object.freeze(overrides.writeRoots ?? [root]),
			denyRead: Object.freeze(overrides.denyRead ?? []),
			denyWrite: Object.freeze(overrides.denyWrite ?? []),
			protectedPaths: Object.freeze(overrides.protectedPaths ?? []),
		}),
		rules: Object.freeze([]),
		sources: Object.freeze(["builtin" as const]),
		workspaceRoot: root,
		tempRoot: join(root, ".tmp"),
		policyDigest: "e".repeat(64),
		createdAt: "2026-07-22T00:00:00.000Z",
	});
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("NodePolicyExtensionStorage", () => {
	it("reads and lists regular in-root resources through the frozen policy", async () => {
		const root = await temporary("read");
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "resource.txt"), "resource");
		await symlink(join(root, "resource.txt"), join(root, "resource-link"));
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot(root) });

		const loaded = await storage.readFile("resource.txt", 8);
		expect(loaded.ok && Buffer.from(loaded.value).toString("utf8")).toBe("resource");
		expect(await storage.realpath("resource.txt")).toEqual({ ok: true, value: join(root, "resource.txt") });
		expect(await storage.stat("nested")).toMatchObject({ ok: true, value: { kind: "directory" } });
		expect(await storage.stat("resource-link", { followSymlinks: false })).toMatchObject({ ok: true, value: { kind: "symlink" } });
		expect(await storage.stat("resource-link")).toMatchObject({ ok: true, value: { kind: "file", size: 8 } });

		const listed = await storage.readDirectory(".");
		expect(listed).toMatchObject({
			ok: true,
			value: expect.arrayContaining([
				{ name: "nested", kind: "directory" },
				{ name: "resource-link", kind: "symlink" },
				{ name: "resource.txt", kind: "file" },
			]),
		});
	});

	it("denies direct, parent-symlink, and followed leaf-symlink escapes", async () => {
		const root = await temporary("root");
		const outside = await temporary("outside");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "parent-link"));
		await symlink(join(outside, "secret.txt"), join(root, "leaf-link"));
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot(root) });

		expect(await storage.readFile(join(outside, "secret.txt"), 32)).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.readFile("parent-link/secret.txt", 32)).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.readFile("leaf-link", 32)).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.stat("leaf-link")).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.stat("leaf-link", { followSymlinks: false })).toMatchObject({ ok: true, value: { kind: "symlink" } });
	});

	it("rejects oversized and invalidly bounded reads", async () => {
		const root = await temporary("oversize");
		await writeFile(join(root, "large.txt"), "0123456789");
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot(root) });

		expect(await storage.readFile("large.txt", 9)).toMatchObject({ ok: false, code: "oversize" });
		expect(await storage.readFile("large.txt", -1)).toMatchObject({ ok: false, code: "io" });
	});

	it("enforces protected paths and explicit read/write deny rules", async () => {
		const root = await temporary("rules");
		for (const name of ["protected", "private", "locked"]) await mkdir(join(root, name));
		await writeFile(join(root, "protected", "metadata.json"), "protected");
		await writeFile(join(root, "private", "metadata.json"), "private");
		const storage = new NodePolicyExtensionStorage({
			cwd: root,
			securitySnapshot: snapshot(root, {
				protectedPaths: [join(root, "protected")],
				denyRead: [join(root, "private")],
				denyWrite: [join(root, "locked")],
			}),
		});

		expect(await storage.readFile("protected/metadata.json", 64)).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.readFile("private/metadata.json", 64)).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.writeFileAtomic("protected/new.json", Buffer.from("no"), { fileMode: 0o600, directoryMode: 0o700 })).toMatchObject({ ok: false, code: "denied" });
		expect(await storage.writeFileAtomic("locked/new.json", Buffer.from("no"), { fileMode: 0o600, directoryMode: 0o700 })).toMatchObject({ ok: false, code: "denied" });
	});

	it("atomically creates and overwrites private metadata without temporary residue", async () => {
		const root = await temporary("atomic");
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot(root) });
		const target = join(root, "state", "extensions-state.json");

		expect(await storage.writeFileAtomic("state/extensions-state.json", Buffer.from("first"), { fileMode: 0o600, directoryMode: 0o700 })).toEqual({ ok: true, value: undefined });
		expect(await readFile(target, "utf8")).toBe("first");
		await writeFile(target, "loose", { mode: 0o666 });
		expect(await storage.writeFileAtomic("state/extensions-state.json", Buffer.from("second"), { fileMode: 0o600, directoryMode: 0o700 })).toEqual({ ok: true, value: undefined });
		expect(await readFile(target, "utf8")).toBe("second");
		expect((await readdir(join(root, "state"))).filter((name) => name.includes(".tmp-"))).toEqual([]);

		if (!IS_WINDOWS) {
			expect((await stat(target)).mode & 0o777).toBe(0o600);
			expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
		}
	});

	it("denies writes through an existing symlink target and outside the write root", async () => {
		const root = await temporary("write-root");
		const outside = await temporary("write-outside");
		await writeFile(join(root, "actual.json"), "unchanged");
		await symlink(join(root, "actual.json"), join(root, "state-link.json"));
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot(root) });

		expect(await storage.writeFileAtomic("state-link.json", Buffer.from("changed"), { fileMode: 0o600, directoryMode: 0o700 })).toMatchObject({ ok: false, code: "denied" });
		expect(await readFile(join(root, "actual.json"), "utf8")).toBe("unchanged");
		expect(await storage.writeFileAtomic(join(outside, "new.json"), Buffer.from("changed"), { fileMode: 0o600, directoryMode: 0o700 })).toMatchObject({ ok: false, code: "denied" });
	});
});
