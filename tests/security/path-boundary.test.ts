import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, stat, lstat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	CanonicalPathResolver,
	FileAccessGuard,
	PolicyFileSystem,
	pathWithin,
	type FileSystemBrokerPort,
} from "../../src/security/policy-filesystem.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

const roots: string[] = [];

const broker: FileSystemBrokerPort = {
	readFile,
	writeFile,
	stat: async (path) => {
		const value = await stat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
	},
	lstat: async (path) => {
		const value = await lstat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
	},
	realpath,
	readdir,
	mkdir,
	rm,
	rename,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function snapshot(root: string): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: [root], writeRoots: [root], denyRead: [], denyWrite: [], protectedPaths: [join(root, ".git"), join(root, ".runledger")] },
		rules: [], sources: ["builtin"], workspaceRoot: root, tempRoot: join(root, ".tmp"), policyDigest: { algorithm: "sha256", digest: "e".repeat(64) as `${string}` }, createdAt: "2026-08-04T00:00:00.000Z",
	};
}

describe("canonical filesystem boundary", () => {
	it("does not confuse a root with a lexical prefix sibling", () => {
		expect(pathWithin("/repo", "/repo/file.ts")).toBe(true);
		expect(pathWithin("/repo", "/repo-other/file.ts")).toBe(false);
	});

	it("resolves missing targets through the nearest canonical parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		roots.push(root);
		const resolver = new CanonicalPathResolver(broker, root);
		expect(await resolver.resolve("a/b/file.ts")).toMatchObject({ ok: true, value: { existing: false, canonicalPath: join(root, "a/b/file.ts") } });
	});

	it("rejects ../ and absolute paths outside the workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		const outside = await mkdtemp(join(tmpdir(), "runledger-outside-"));
		roots.push(root, outside);
		const fs = new PolicyFileSystem(broker, root, snapshot(root));
		expect(await fs.writeFile("../escape.txt", "blocked")).toMatchObject({ ok: false, error: { code: "path_escape" } });
		expect(await fs.writeFile(join(outside, "absolute.txt"), "blocked")).toMatchObject({ ok: false, error: { code: "path_escape" } });
	});

	it("detects symlink-parent and symlink-leaf escapes before write", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		const outside = await mkdtemp(join(tmpdir(), "runledger-outside-"));
		roots.push(root, outside);
		await symlink(outside, join(root, "escape"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
		const fs = new PolicyFileSystem(broker, root, snapshot(root));
		expect(await fs.writeFile("escape/new.txt", "blocked")).toMatchObject({ ok: false, error: { code: "path_escape" } });
		expect(await fs.writeFile("leaf.txt", "blocked")).toMatchObject({ ok: false, error: { code: "path_escape" } });
	});

	it("protects .git and .runledger even when they are inside write roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		roots.push(root);
		await mkdir(join(root, ".git"));
		const resolver = new CanonicalPathResolver(broker, root);
		for (const target of [".git/config", ".runledger/settings.json"]) {
			const resolved = await resolver.resolve(target);
			expect(resolved.ok).toBe(true);
			if (resolved.ok) expect(new FileAccessGuard(snapshot(root)).check("write", resolved.value)).toMatchObject({ ok: false, error: { code: "protected_path" } });
		}
	});

	it("performs allowed reads and writes only through the broker", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		roots.push(root);
		const fs = new PolicyFileSystem(broker, root, snapshot(root));
		expect(await fs.writeFile("file.txt", "ok")).toEqual({ ok: true, value: undefined });
		const loaded = await fs.readFile("file.txt");
		expect(loaded.ok && loaded.value.toString("utf8")).toBe("ok");
	});

	it("revalidates non-file mutations immediately before the broker call", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-"));
		const outside = await mkdtemp(join(tmpdir(), "runledger-outside-"));
		roots.push(root, outside);
		let realpathCalls = 0;
		const flippingBroker: FileSystemBrokerPort = {
			...broker,
			realpath: async (path) => {
				realpathCalls += 1;
				return realpathCalls === 2 ? outside : realpath(path);
			},
		};
		const fs = new PolicyFileSystem(flippingBroker, root, snapshot(root));
		const result = await fs.mkdir("new-directory");
		expect(result).toMatchObject({ ok: false, error: { code: "path_escape" } });
	});
});
